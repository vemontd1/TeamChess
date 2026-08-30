import { Chess } from 'chess.js';
import { pickMove, rankMoves, pieceValue, type MoveStyle } from './bots.js';
import {
  createCards, cardsPublic, drawPerTurnFor, drawCards, drawBonus, refreshEmergency,
  resolveSpend, resolveSacrifice, commitSpend, snapshotCards, movableTypes, cardCovers,
  FREE_PIECE, extinctTypes, replaceExtinct, cycleForPlayable, mulligan as mulliganCards,
  aliveTypeCount, handCapFor, canCastle, canSacrifice, chooseSacrificeCards, handReach,
  type CardsState, type Spend,
} from './cards.js';
import {
  computeChoiceSet, materialBalance, hangingAfter, cardsSnapshot, emptyClientSession,
  type ClientSession,
} from './metrics.js';
import type {
  Color, GameMode, RoomConfig, RoomState, SeatView, TeamView, GameOver, SeatKind,
  SeatStats, HistoryEntry, PendingTakeback, PendingDraw, MovePayload, ChatMessage,
  ChatChannel, MarkView, PlyMetric, PlyCards,
} from './types.js';

export interface InternalSeat {
  id: number;
  name: string | null;
  token: string | null;
  /**
   * The account this seat is played by, if anyone signed in is in it.
   *
   * Kept apart from `token`, which is the browser's seat-reclaim credential and says
   * nothing about who is holding it. This is what a finished game is credited to, so a
   * guest simply carries null and is not recorded.
   */
  accountId: string | null;
  kind: SeatKind;
  connected: boolean;
  stats: SeatStats;
  /**
   * When this seat last completed a move.
   *
   * The other half of wait time: how long a player sits between their own turns. In a 5v5
   * that is four other people's thinking, and it is the number that decides whether the
   * rotation is fun -- which no result table will ever show.
   */
  lastMoveAt: number | null;
}

export interface Team {
  color: Color;
  seats: InternalSeat[];
  cursor: number;
}

/** Snapshot taken before each ply so a takeback rewinds rotation, not just the board. */
interface PlyFrame {
  cursorWhite: number;
  cursorBlack: number;
  lastMove: { from: string; to: string } | null;
  lastMoveAuto: boolean;
  entry: HistoryEntry;
  capturedValue: number;
  /** Hands, decks and discards as they stood before the ply. Cards mode only. */
  cards: CardsState | null;
}

export interface Room {
  id: string;
  chess: Chess;
  white: Team;
  black: Team;
  spectators: Map<string, string>;
  hostToken: string | null;
  status: 'lobby' | 'playing' | 'finished';
  config: RoomConfig;
  timer: ReturnType<typeof setTimeout> | null;
  turnDeadline: number | null;
  bankedMs: number | null;          // clock remainder held while a takeback is pending
  turnStartedAt: number | null;     // for think-time stats
  botTimer: ReturnType<typeof setTimeout> | null;
  takebackTimer: ReturnType<typeof setTimeout> | null;
  pendingTakeback: PendingTakeback | null;
  drawTimer: ReturnType<typeof setTimeout> | null;
  pendingDraw: PendingDraw | null;
  lastMove: { from: string; to: string } | null;
  lastMoveAuto: boolean;
  history: HistoryEntry[];
  /**
   * One row per ply, measured as it is played.
   *
   * Deliberately *not* in `RoomState`. That object is broadcast to everyone in the room,
   * spectators included, and every card field here reconstructs a hand -- which is the
   * whole mode. It reaches a client only through the archive, once the game is over and
   * there is nothing left to protect.
   */
  plyMetrics: PlyMetric[];
  /**
   * What the players' browsers have reported this game, per side.
   *
   * Advisory and best-effort: a client can lie, can send nothing at all, and a bot sends
   * nothing by definition. Nothing in the game reads it -- it exists so that hesitation,
   * device and premove outcomes, none of which the server can see, reach the archive
   * alongside the measurements that it can.
   */
  clientSessions: { white: ClientSession; black: ClientSession };
  frames: PlyFrame[];
  gameOver: GameOver | null;
  /**
   * Which game this is, counting from one.
   *
   * A rematch resets everything else about a room, so nothing else on the wire tells the
   * two games apart -- and a client that says "have I already announced this result?"
   * needs to mean *this* result, not "a result". Without it a rematch replays the
   * previous game's result card and then swallows the next one.
   */
  gameSeq: number;
  /** The position the current game began from -- the archive records where it started. */
  startFen: string;
  /** Set once this game has been written to the archive, so it is never written twice. */
  archived: boolean;
  /**
   * Pending reaping: nobody is here, and the room goes if nobody comes back.
   *
   * A timer rather than an immediate delete, because the commonest reason for a room to
   * empty is somebody refreshing their browser, and a game that vanishes in the second it
   * takes to reload is worse than a room that lingers for a few minutes.
   */
  reapTimer: NodeJS.Timeout | null;
  /**
   * Which funnel steps this room has already reached.
   *
   * The funnel counts rooms, not games, and each step at most once -- a room that starts
   * five games is one room that started, not five. Kept here because the room is the only
   * thing that knows, and it is deliberately not reset by a rematch.
   */
  funnel: {
    seated: boolean; started: boolean; firstMove: boolean; finished: boolean;
    rematch: boolean;
  };
  cards: CardsState | null;         // cards mode only
  chat: ChatMessage[];              // every channel; filtered when delivered
  chatSeq: number;
  marks: Map<string, TeamMarks>;    // seat token -> that player's flagged squares
}

/** Squares one seated player has flagged for their team this ply. */
export interface TeamMarks {
  color: Color;
  name: string;
  /**
   * What this player has drawn on the board this ply.
   *
   * A square on its own is a highlight; `a1>h8` is an arrow between the two. One list,
   * because the two have identical lives: both belong to one player, both are seen only
   * by their own team, and both are wiped the moment a move is made.
   */
  squares: string[];
}

export const CHAT_HISTORY = 80;   // per room, across all channels
export const MAX_MARKS = 6;       // per player

export const rooms = new Map<string, Room>();

const ROOM_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function makeRoomId(): string {
  let id = '';
  do {
    id = Array.from({ length: 5 }, () =>
      ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function emptyStats(): SeatStats {
  return { moves: 0, autoMoves: 0, botMoves: 0, thinkMsTotal: 0, captured: 0 };
}

function makeTeam(color: Color, size: number): Team {
  return {
    color,
    cursor: 0,
    seats: Array.from({ length: size }, (_, id) => ({
      id, name: null, token: null, accountId: null, kind: 'human' as SeatKind,
      connected: false, stats: emptyStats(), lastMoveAt: null,
    })),
  };
}

export function sanitizeConfig(c: Partial<RoomConfig> | undefined): RoomConfig {
  const mode: GameMode = c?.mode === 'cards' ? 'cards' : 'team';
  // Chess Cards is a duel: the hidden hand is what one player holds, and a rotation of
  // teammates sharing it would make it neither hidden nor a hand.
  const teamSize = mode === 'cards'
    ? 1
    : Math.min(5, Math.max(1, Math.floor(Number(c?.teamSize) || 2)));
  let moveTimerSec: number | null = null;
  const raw = Number(c?.moveTimerSec);
  if (c?.moveTimerSec != null && Number.isFinite(raw) && raw > 0) {
    moveTimerSec = Math.min(600, Math.max(5, Math.floor(raw)));
  }
  return {
    mode,
    teamSize,
    skipEmptySeats: c?.skipEmptySeats ?? true,
    moveTimerSec,
    allowTakeback: c?.allowTakeback ?? true,
  };
}

export function createRoom(config: RoomConfig): Room {
  const id = makeRoomId();
  const room: Room = {
    id,
    chess: new Chess(),
    white: makeTeam('white', config.teamSize),
    black: makeTeam('black', config.teamSize),
    spectators: new Map(),
    hostToken: null,
    status: 'lobby',
    config,
    timer: null,
    turnDeadline: null,
    bankedMs: null,
    turnStartedAt: null,
    botTimer: null,
    takebackTimer: null,
    pendingTakeback: null,
    drawTimer: null,
    pendingDraw: null,
    lastMove: null,
    lastMoveAuto: false,
    history: [],
    plyMetrics: [],
    clientSessions: { white: emptyClientSession(), black: emptyClientSession() },
    frames: [],
    gameOver: null,
    gameSeq: 0,
    startFen: new Chess().fen(),
    archived: false,
    reapTimer: null,
    funnel: {
      seated: false, started: false, firstMove: false, finished: false, rematch: false,
    },
    cards: null,
    chat: [],
    chatSeq: 0,
    marks: new Map(),
  };
  rooms.set(id, room);
  return room;
}

// ---------- rotation ----------

export function teamFor(room: Room, color: Color): Team {
  return color === 'white' ? room.white : room.black;
}

export function isOccupied(s: InternalSeat): boolean {
  return s.token != null || s.kind === 'bot';
}

export function occupiedCount(team: Team): number {
  return team.seats.filter(isOccupied).length;
}

/**
 * How many people -- actual people, connected right now -- are in this room.
 *
 * Bots do not count, and that is the whole point of the function. A room was kept alive
 * by `occupiedCount`, which counts a bot as an occupant, so a room whose human left with
 * a bot still seated could never be cleaned up: it sat in memory forever, and the player
 * who came back to its link rejoined a game nobody was playing. A seat's token surviving a
 * disconnect keeps a refresh working, so what is counted here is *connected* humans; the
 * grace period that stops a refresh from reaping the room lives at the call site.
 */
export function liveHumans(room: Room): number {
  const seated = (t: Team): number =>
    t.seats.filter(s => s.token != null && s.connected).length;
  return room.spectators.size + seated(room.white) + seated(room.black);
}

/** Anyone at all holding a seat, connected or not -- a room worth keeping for a moment. */
export function seatedHumans(room: Room): number {
  const seated = (t: Team): number => t.seats.filter(s => s.token != null).length;
  return seated(room.white) + seated(room.black);
}

/**
 * The first seat nobody is in, or null when the team is full.
 *
 * Resolving this on the server is what lets the client offer one Join button instead of a
 * row of them: the caller says which side it wants, not which chair.
 */
export function firstFreeSeat(team: Team): InternalSeat | null {
  return team.seats.find(s => !isOccupied(s)) ?? null;
}

/**
 * The seat whose turn it is for this team.
 *
 * With skipEmptySeats the rotation closes over occupied seats only. Without it every seat
 * keeps its slot in the order and an empty one simply has nobody to move it -- its turn is
 * resolved by the clock, which is only coherent because the timeout path exists.
 */
export function activeSeat(room: Room, team: Team): InternalSeat | null {
  const n = team.seats.length;
  if (n === 0) return null;
  if (!room.config.skipEmptySeats) return team.seats[team.cursor % n];
  for (let i = 0; i < n; i++) {
    const s = team.seats[(team.cursor + i) % n];
    if (isOccupied(s)) return s;
  }
  return null;
}

export function seatByToken(room: Room, token: string): { color: Color; seat: InternalSeat } | null {
  for (const color of ['white', 'black'] as Color[]) {
    const seat = teamFor(room, color).seats.find(s => s.token === token);
    if (seat) return { color, seat };
  }
  return null;
}

// ---------- moves ----------

function classifyGameOver(chess: Chess, mover: Color): GameOver {
  if (chess.isCheckmate()) return { reason: 'checkmate', winner: mover };
  if (chess.isStalemate()) return { reason: 'stalemate', winner: 'draw' };
  if (chess.isThreefoldRepetition()) return { reason: 'threefold', winner: 'draw' };
  if (chess.isInsufficientMaterial()) return { reason: 'insufficient', winner: 'draw' };
  const c = chess as unknown as { isDrawByFiftyMoves?: () => boolean };
  if (typeof c.isDrawByFiftyMoves === 'function' && c.isDrawByFiftyMoves()) {
    return { reason: 'fifty-move', winner: 'draw' };
  }
  return { reason: 'draw', winner: 'draw' };
}

export interface ApplyResult {
  ok: boolean;
  captured: boolean;
  castle: boolean;
  promotion: boolean;
  check: boolean;
  /** Cards mode: the move was bought by burning a hand of cards, not by playing one. */
  sacrifice: boolean;
  san?: string;
}

const FAIL: ApplyResult = {
  ok: false, captured: false, castle: false, promotion: false, check: false,
  sacrifice: false,
};

/**
 * Find the legal move a from/to pair names, so the piece type can be known before the
 * board is touched. Every candidate sharing a from/to square is the same piece, so the
 * promotion choice does not change the answer.
 */
function peekMove(chess: Chess, m: MovePayload):
    { piece: string; castling: boolean } | null {
  const moves = chess.moves({ verbose: true }) as unknown as
    Array<{ from: string; to: string; piece: string; flags: string }>;
  const found = moves.find(x => x.from === m.from && x.to === m.to);
  if (!found) return null;
  return {
    piece: found.piece,
    castling: found.flags.includes('k') || found.flags.includes('q'),
  };
}

/** The hand cap for one side right now, which falls as its army comes off the board. */
export function handCapOf(room: Room, color: Color): number {
  return handCapFor(aliveTypeCount(room.chess, color));
}

/**
 * Swap every card naming a piece that no longer exists, on both sides, right now.
 *
 * This runs after each ply rather than only when a turn opens, and that timing is the
 * whole point of it. Two things used to make a card visibly arrive and then change under
 * the player:
 *
 *  - the capture bonus deals a card the instant a capture lands, and it was dealt without
 *    the extinction filter -- so trading off your last knight and drawing a Knight card
 *    for it showed you the card, then swapped it at the start of your next turn;
 *  - taking a player's last knight makes their Knight cards dead immediately, but they
 *    were only swapped when that player's own turn opened, so they sat and watched a card
 *    they could no longer use until it changed in front of them.
 *
 * Pruning both hands at the end of every ply closes both: by the time a hand is next
 * pushed to anyone, it no longer holds a card for a piece that is not on the board.
 */
export function pruneExtinct(room: Room): void {
  if (!room.cards) return;
  for (const color of ['white', 'black'] as Color[]) {
    const side = room.cards[color];
    const replaced = replaceExtinct(side, extinctTypes(room.chess, color));
    // appended, not assigned: the note has to survive from the moment the swap happens
    // until the player is next on turn and can actually be shown it
    if (replaced.length > 0) side.lastReplaced.push(...replaced);
  }
}

/** Validate and apply one ply, advancing only the moving team's cursor. */
export function applyMove(room: Room, m: MovePayload,
                          opts: { auto?: boolean } = {}): ApplyResult {
  const mover: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  const team = teamFor(room, mover);
  const seat = activeSeat(room, team);

  // In cards mode the move has to be paid for. Work out which card covers the piece that
  // is about to move and refuse outright if none does -- the board is never touched by a
  // move the hand cannot afford, so there is no half-applied state to unwind.
  const cardsBefore = room.cards ? snapshotCards(room.cards) : null;
  let spend: Spend | null = null;
  if (room.cards) {
    const peek = peekMove(room.chess, m);
    if (!peek) return FAIL;
    // A named sacrifice is tried first and never falls back: a player who offered three
    // cards and got them refused must be told so, not quietly charged one card instead
    // for a move that happened to be affordable anyway.
    //
    // The king is the exception, and has to be: he moves for free, so a sacrifice aimed
    // at him buys nothing and would burn three cards for it. Dropping the sacrifice
    // rather than refusing the move is the kinder of the two -- the move was legal and
    // free all along, and the cards simply stay in the hand.
    spend = m.sacrificeIds != null && (peek.piece !== FREE_PIECE || peek.castling)
      ? resolveSacrifice(room.cards[mover], m.sacrificeIds, room.history.length)
      : resolveSpend(room.cards[mover], peek.piece, m.cardId, peek.castling);
    if (!spend) return FAIL;
  }

  // Measured before the board is touched: the choice set is what the mover *had*, and the
  // hand is what they held while they had it. Both are gone a line later.
  const now = Date.now();
  const before = {
    choice: computeChoiceSet(room.chess, room.cards ? room.cards[mover] : null),
    inCheck: room.chess.inCheck(),
    cards: room.cards
      ? cardsSnapshot(room.chess, room.cards[mover], mover, room.history.length,
          paymentOf(spend), spend?.kind === 'card' ? spend.card.kind : null)
      : undefined,
    thinkMs: room.turnStartedAt ? Math.max(0, now - room.turnStartedAt) : 0,
    waitMs: seat?.lastMoveAt != null && room.turnStartedAt != null
      ? Math.max(0, room.turnStartedAt - seat.lastMoveAt)
      : null,
    clockRemainingMs: room.turnDeadline != null
      ? Math.max(0, room.turnDeadline - now) : null,
  };

  let res;
  try {
    res = room.chess.move({ from: m.from, to: m.to, promotion: (m.promotion as 'q') ?? 'q' });
  } catch {
    return FAIL;
  }
  if (!res) return FAIL;

  const capturedValue = res.captured ? pieceValue(res.captured) : 0;
  const auto = opts.auto === true;
  const byBot = seat?.kind === 'bot';

  const entry: HistoryEntry = {
    ply: room.history.length + 1,
    san: res.san,
    color: mover,
    seatId: seat ? seat.id : -1,
    playerName: seat?.name ?? (seat?.kind === 'bot' ? 'Bot' : 'Empty seat'),
    auto,
    bot: byBot && !auto,
    fen: room.chess.fen(),
    from: res.from,
    to: res.to,
  };

  room.frames.push({
    cursorWhite: room.white.cursor,
    cursorBlack: room.black.cursor,
    lastMove: room.lastMove,
    lastMoveAuto: room.lastMoveAuto,
    entry,
    capturedValue,
    cards: cardsBefore,
  });
  room.history.push(entry);

  if (seat) {
    if (auto) seat.stats.autoMoves++;
    else if (byBot) seat.stats.botMoves++;
    else {
      seat.stats.moves++;
      if (room.turnStartedAt) seat.stats.thinkMsTotal += Date.now() - room.turnStartedAt;
    }
    seat.stats.captured += capturedValue;
  }

  if (seat) seat.lastMoveAt = Date.now();

  room.lastMove = { from: res.from, to: res.to };
  room.lastMoveAuto = auto;
  // marks describe *this* position, so they expire with it -- and so does a draw offer,
  // which was made about a position that no longer exists
  room.marks.clear();
  clearDraw(room);

  // advance this team's rotation past the seat that just moved
  if (seat) team.cursor = (seat.id + 1) % team.seats.length;
  else team.cursor = (team.cursor + 1) % team.seats.length;

  // Pay for the move, then take the card a capture earns. Tempo is the whole reason to
  // go forward: an attack that lands widens the hand that has to sustain it.
  if (room.cards && spend) {
    const side = room.cards[mover];
    // The notes from the turn just played are spent along with it: whatever was swapped
    // or cycled has been shown, and anything that happens from here belongs to the next
    // turn's explanation rather than this one's.
    side.lastReplaced = [];
    side.lastCycled = [];
    commitSpend(side, spend);
    if (capturedValue > 0) drawBonus(side, handCapOf(room, mover));
    // A capture can end a piece type -- the mover's, by promoting away their last pawn,
    // or the opponent's, by taking their last knight -- so both hands are pruned against
    // the board as it now stands, before either player is shown a card that is already dead.
    pruneExtinct(room);
  }

  recordPly(room, {
    before,
    entry,
    res,
    capturedValue,
    auto,
    byBot,
    seatId: seat ? seat.id : -1,
    mover,
  });

  if (room.chess.isGameOver()) {
    room.status = 'finished';
    room.gameOver = classifyGameOver(room.chess, mover);
  }

  return {
    ok: true,
    captured: capturedValue > 0,
    castle: res.flags.includes('k') || res.flags.includes('q'),
    promotion: res.flags.includes('p'),
    check: room.chess.inCheck(),
    sacrifice: spend?.kind === 'sacrifice',
    san: res.san,
  };
}

/** Which of the four ways a move can be paid for was used. */
function paymentOf(spend: Spend | null): PlyCards['payment'] {
  if (!spend) return 'free';
  switch (spend.kind) {
    case 'card':      return 'card';
    case 'sacrifice': return 'sacrifice';
    case 'emergency': return 'emergency';
    default:          return 'free';
  }
}

interface RecordInput {
  before: {
    choice: ReturnType<typeof computeChoiceSet>;
    inCheck: boolean;
    cards: PlyCards | undefined;
    thinkMs: number;
    waitMs: number | null;
    clockRemainingMs: number | null;
  };
  entry: HistoryEntry;
  res: { from: string; to: string; piece: string; flags: string; captured?: string;
         promotion?: string };
  capturedValue: number;
  auto: boolean;
  byBot: boolean;
  seatId: number;
  mover: Color;
}

/**
 * Complete the row for a ply that has already been applied.
 *
 * The board is now in the position the move produced, which is exactly what the hanging
 * check needs -- one move generation, no search.
 */
function recordPly(room: Room, x: RecordInput): void {
  const { before, res } = x;
  const movedType = res.promotion ?? res.piece;
  const { hung, hungValue } = hangingAfter(room.chess, res.to, movedType, x.capturedValue);

  const materialAfter = materialBalance(room.chess);
  const timerMs = room.config.moveTimerSec != null ? room.config.moveTimerSec * 1000 : null;

  room.plyMetrics.push({
    ply: x.entry.ply,
    color: x.mover,
    seatId: x.seatId,
    bot: x.byBot && !x.auto,
    auto: x.auto,

    legalMoves: before.choice.legalMoves,
    legalTypes: before.choice.legalTypes,
    affordableMoves: before.choice.affordableMoves,
    affordableTypes: before.choice.affordableTypes,
    openTurn: before.choice.openTurn,
    onlyKing: before.choice.onlyKing,
    forced: before.choice.forced,
    inCheck: before.inCheck,

    piece: res.piece,
    captured: res.captured ?? null,
    promotion: res.flags.includes('p'),
    castle: res.flags.includes('k') || res.flags.includes('q'),
    // recorded from White's point of view; `swing` is from the mover's
    materialAfter,
    swing: x.mover === 'white' ? x.capturedValue : -x.capturedValue,
    hung,
    hungValue,
    bestCapture: before.choice.bestCapture,
    missed: Math.max(0, before.choice.bestCapture - x.capturedValue),

    thinkMs: before.thinkMs,
    waitMs: before.waitMs,
    clockRemainingMs: before.clockRemainingMs,
    // rounded, because eighteen digits of a ratio is seventeen digits of archive
    clockFraction: timerMs != null && before.clockRemainingMs != null
      ? Math.round((before.clockRemainingMs / timerMs) * 1000) / 1000
      : null,

    cards: before.cards,
  });
}

/** Rewind one ply, restoring rotation cursors and stats along with the board. */
export function undoPly(room: Room): boolean {
  const frame = room.frames.pop();
  if (!frame) return false;
  const undone = room.chess.undo();
  if (!undone) { room.frames.push(frame); return false; }

  room.history.pop();
  room.plyMetrics.pop();     // a ply that did not happen was not measured
  room.marks.clear();
  // The hands go back too, or a takeback would launder a spent Queen into a free one.
  if (frame.cards) room.cards = frame.cards;
  room.white.cursor = frame.cursorWhite;
  room.black.cursor = frame.cursorBlack;
  room.lastMove = frame.lastMove;
  room.lastMoveAuto = frame.lastMoveAuto;

  const team = teamFor(room, frame.entry.color);
  const seat = team.seats[frame.entry.seatId];
  if (seat) {
    if (frame.entry.auto) seat.stats.autoMoves = Math.max(0, seat.stats.autoMoves - 1);
    else if (frame.entry.bot) seat.stats.botMoves = Math.max(0, seat.stats.botMoves - 1);
    else seat.stats.moves = Math.max(0, seat.stats.moves - 1);
    seat.stats.captured = Math.max(0, seat.stats.captured - frame.capturedValue);
  }

  room.status = 'playing';
  room.gameOver = null;
  return true;
}

// ---------- clocks ----------

export function clearTimer(room: Room): void {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  room.turnDeadline = null;
}

export function clearTakeback(room: Room): void {
  if (room.takebackTimer) { clearTimeout(room.takebackTimer); room.takebackTimer = null; }
  room.pendingTakeback = null;
}

export function clearDraw(room: Room): void {
  if (room.drawTimer) { clearTimeout(room.drawTimer); room.drawTimer = null; }
  room.pendingDraw = null;
}

export interface TurnHooks {
  onTimeout: (room: Room) => void;
  onBotMove: (room: Room) => void;
}

/**
 * Start the clock for whoever is on move, and if that seat is a bot, schedule its move.
 * `ms` overrides the configured duration so a declined takeback resumes the banked
 * remainder rather than handing the player a fresh full clock.
 */
export function armTurn(room: Room, hooks: TurnHooks, ms?: number): void {
  clearTimer(room);
  if (room.status !== 'playing') return;

  beginCardTurn(room);
  room.turnStartedAt = Date.now();

  const configured = room.config.moveTimerSec != null ? room.config.moveTimerSec * 1000 : null;
  const duration = ms ?? configured;
  if (duration != null) {
    room.turnDeadline = Date.now() + duration;
    room.timer = setTimeout(() => hooks.onTimeout(room), duration);
  }

  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  const seat = activeSeat(room, teamFor(room, turn));
  if (seat?.kind === 'bot') {
    room.botTimer = setTimeout(() => hooks.onBotMove(room), 600 + Math.floor(Math.random() * 800));
  }
}

/**
 * Open the turn for whoever is on move in cards mode: deal this turn's cards, then work
 * out whether any card in the refreshed hand can move anything.
 *
 * Guarded against being opened twice. Every path that re-arms a turn calls through here --
 * a declined takeback, a seat becoming a bot mid-turn -- and a fixed deal would hand out
 * two more cards on each of them. `openedPly` is what makes the second call a no-op, and
 * it rides on the cards so a takeback restores it with the hands.
 */
export function beginCardTurn(room: Room): void {
  if (!room.cards || room.status !== 'playing') return;
  if (room.cards.openedPly === room.history.length) return;
  room.cards.openedPly = room.history.length;
  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  const side = room.cards[turn];

  // Deal first, then prune: a card dealt this turn is as subject to the piece being gone
  // as one that was already there, and pruning afterwards catches both.
  //
  // The first turn is the exception: the opening hand was the deal for it. Dealing again
  // here would put both players on a full seven before either had moved, and the opening
  // spread -- one card for each piece kind -- would never actually be a hand anyone saw.
  //
  // The cap falls as this side's army does, and nothing is confiscated when it falls: the
  // deal simply stops until the hand has been spent back down under it.
  const cap = handCapOf(room, turn);
  side.openedTurns++;
  side.lastDrawn = side.openedTurns > 1
    ? drawCards(side, drawPerTurnFor(room.history.length), cap)
    : side.hand.length;   // the opening hand *is* the first turn's deal
  // The prune after each ply does the real work; this catches the opening deal and any
  // path that reaches a turn without one. Appended, so a swap explained from the previous
  // ply is still on the note the player is about to read.
  side.lastReplaced.push(...replaceExtinct(side, extinctTypes(room.chess, turn)));

  // A dead hand with the king safe is a draw problem, and gets a draw answer: cycle until
  // something can move. Under check it is not -- the position is asking a question that
  // has to be answered this turn, and cycling might spend the whole deck without finding
  // a card that answers it -- so the emergency move stays for exactly that case.
  side.lastCycled = room.chess.inCheck() ? [] : cycleForPlayable(side, room.chess);

  refreshEmergency(side, room.chess);
}

/** The once-per-game hand reset. Only legal at the start of your own turn. */
export function useMulligan(room: Room, color: Color): boolean {
  if (!room.cards || room.status !== 'playing') return false;
  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  if (turn !== color) return false;
  const side = room.cards[color];

  // The fresh hand is dealt against the board as it stands, not against the board the
  // game started on. Dealing the opening spread blind handed back a Knight card to a
  // player with no knights left -- the one thing the extinction swap exists to prevent,
  // reintroduced by the button that is supposed to rescue a bad hand.
  if (!mulliganCards(side, {
    extinct: extinctTypes(room.chess, color),
    cap: handCapOf(room, color),
  })) return false;

  // and the usual end-of-deal tidying, so a mulligan cannot leave a hand that could not
  // have arrived any other way
  side.lastReplaced.push(...replaceExtinct(side, extinctTypes(room.chess, color)));
  if (!room.chess.inCheck()) side.lastCycled = cycleForPlayable(side, room.chess);
  refreshEmergency(side, room.chess);
  return true;
}

/**
 * The piece types the side on move can actually move right now, king included.
 *
 * The clock and the bots both need this: a forced move in cards mode has to be one the
 * hand could have paid for, or the timeout would play a move the player was never
 * allowed to make.
 */
export function canCastleNow(room: Room): boolean {
  if (!room.cards) return true;
  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  return canCastle(room.cards[turn]);
}

export function affordableTypes(room: Room): Set<string> | null {
  if (!room.cards) return null;
  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  return handReach(room.cards[turn], movableTypes(room.chess));
}

/** Play a move for a seat that ran out of time: a uniformly random legal move. */
/**
 * How much better an unaffordable move has to be before a bot burns three cards for it.
 *
 * Roughly a rook. Below that the sacrifice costs more than it wins: three cards is most
 * of a hand and two turns of dealing, and a bot that spends them to win a pawn has simply
 * found a slower way to lose. Mate scores a thousand, so it always clears this.
 */
const BOT_SACRIFICE_GAIN = 45;

export function playForcedMove(room: Room, style: MoveStyle = 'random'): ApplyResult | null {
  // Castling costs a Rook card, so the clock and the bots have to be told about it too --
  // otherwise a timeout could pick a castle the hand cannot pay for, `applyMove` would
  // refuse it, and the turn would hang on a move nobody could make.
  const allowCastle = canCastleNow(room);
  const affordable = affordableTypes(room) ?? undefined;

  // A bot in cards mode gets the sacrifice too, or it is playing a different game from
  // the one in front of it: it would sit on a mate it could not afford and shuffle a pawn
  // instead, which is exactly what "the bot ignores the mode" looks like from the other
  // side of the board. The clock never does this -- a timeout must stay arbitrary, and
  // spending a player's cards for them is not that.
  if (style === 'greedy' && room.cards) {
    const sacrificed = trySacrificeMove(room, affordable, allowCastle);
    if (sacrificed) return sacrificed;
  }

  const mv = pickMove(room.chess, style, affordable, { allowCastle });
  if (!mv) return null;
  return applyMove(room, mv, { auto: style === 'random' });
}

/**
 * Burn three cards for a move the hand could not otherwise reach, when it is worth it.
 *
 * The comparison is between the two pools rather than against a fixed idea of a good
 * move: what the hand can already afford, against what it could afford if it paid. Only
 * the gap matters, so a bot with a strong hand never sacrifices for a move it could have
 * played anyway.
 */
function trySacrificeMove(room: Room, affordable: Set<string> | undefined,
                          allowCastle: boolean): ApplyResult | null {
  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  const side = room.cards![turn];
  if (!canSacrifice(side, room.history.length)) return null;

  const canPay = rankMoves(room.chess, 'greedy', affordable, { allowCastle });
  const anything = rankMoves(room.chess, 'greedy', undefined, { allowCastle: true });
  const best = anything[0];
  if (!best) return null;

  const bestAffordable = canPay[0]?.score ?? -Infinity;
  if (best.score - bestAffordable < BOT_SACRIFICE_GAIN) return null;

  const cards = chooseSacrificeCards(side, room.chess);
  if (!cards) return null;

  return applyMove(room, {
    from: best.from, to: best.to, promotion: best.promotion,
    sacrificeIds: cards.map(c => c.id),
  });
}

// ---------- team coordination ----------

/** Which conversation a token belongs to: its own team, or the spectator channel. */
export function channelFor(room: Room, token: string): ChatChannel {
  return seatByToken(room, token)?.color ?? 'spectator';
}

const SQUARE_RE = /^[a-h][1-8]$/;

/** Strip control characters and clamp; the client is never trusted for either. */
export function cleanChatText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = Array.from(raw)
    .map(ch => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7F ? ' ' : ch))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!text) return null;
  return text.slice(0, 240);
}

export function pushChat(room: Room, channel: ChatChannel, name: string, text: string): ChatMessage {
  const msg: ChatMessage = {
    id: ++room.chatSeq,
    channel,
    name: name.slice(0, 24),
    text,
    at: Date.now(),
  };
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
  return msg;
}

export function chatFor(room: Room, channel: ChatChannel): ChatMessage[] {
  return room.chat.filter(m => m.channel === channel);
}

/**
 * Toggle a square in this player's mark set. Only a seated player may mark -- a mark is a
 * suggestion to teammates, and a spectator has no team to suggest to.
 */
export function toggleMark(room: Room, token: string, square: unknown,
                           to?: unknown): boolean {
  if (typeof square !== 'string' || !SQUARE_RE.test(square)) return false;
  // An arrow has to point somewhere else; one that points at its own square is the
  // highlight the player already has a gesture for.
  const far = typeof to === 'string' && SQUARE_RE.test(to) && to !== square ? to : null;
  const key = far ? `${square}>${far}` : square;
  const seat = seatByToken(room, token);
  if (!seat) return false;

  let entry = room.marks.get(token);
  if (!entry) {
    entry = { color: seat.color, name: seat.seat.name ?? 'Player', squares: [] };
    room.marks.set(token, entry);
  }
  entry.color = seat.color;
  entry.name = seat.seat.name ?? 'Player';

  const at = entry.squares.indexOf(key);
  if (at >= 0) entry.squares.splice(at, 1);
  else if (entry.squares.length < MAX_MARKS) entry.squares.push(key);
  else return false;

  if (entry.squares.length === 0) room.marks.delete(token);
  return true;
}

export function clearMarksFor(room: Room, token: string): void {
  room.marks.delete(token);
}

/** The marks one recipient may see: their own team's, flagged with which are theirs. */
export function marksFor(room: Room, token: string): MarkView[] {
  const seat = seatByToken(room, token);
  if (!seat) return [];
  const out: MarkView[] = [];
  for (const [owner, entry] of room.marks) {
    if (entry.color !== seat.color) continue;
    for (const mark of entry.squares) {
      const [square, far] = mark.split('>');
      out.push({ square, to: far, name: entry.name, own: owner === token });
    }
  }
  return out;
}

// ---------- serialization ----------

function seatView(s: InternalSeat): SeatView {
  return {
    id: s.id, name: s.name, kind: s.kind,
    occupied: isOccupied(s), connected: s.connected, stats: s.stats,
  };
}

function teamView(room: Room, team: Team): TeamView {
  const a = activeSeat(room, team);
  return { color: team.color, seats: team.seats.map(seatView), activeSeatId: a ? a.id : null };
}

export function serialize(room: Room): RoomState {
  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  const activeColor: Color | null = room.status === 'playing' ? turn : null;
  const a = activeColor ? activeSeat(room, teamFor(room, turn)) : null;
  return {
    id: room.id,
    gameSeq: room.gameSeq,
    status: room.status,
    fen: room.chess.fen(),
    turn,
    white: teamView(room, room.white),
    black: teamView(room, room.black),
    activeColor,
    activeSeatId: a ? a.id : null,
    activePlayerName: a ? (a.name ?? (a.kind === 'bot' ? 'Bot' : null)) : null,
    turnDeadline: room.turnDeadline,
    turnRemainingMs: room.turnDeadline != null
      ? Math.max(0, room.turnDeadline - Date.now())
      : null,
    lastMove: room.lastMove,
    lastMoveAuto: room.lastMoveAuto,
    history: room.history,
    inCheck: room.chess.inCheck(),
    gameOver: room.gameOver,
    spectatorCount: room.spectators.size,
    pendingTakeback: room.pendingTakeback && {
      ...room.pendingTakeback,
      remainingMs: Math.max(0, room.pendingTakeback.deadline - Date.now()),
    },
    cards: room.cards
      ? cardsPublic(room.cards, room.history.length,
          { white: handCapOf(room, 'white'), black: handCapOf(room, 'black') })
      : null,
    pendingDraw: room.pendingDraw && {
      ...room.pendingDraw,
      remainingMs: Math.max(0, room.pendingDraw.deadline - Date.now()),
    },
    config: room.config,
  };
}

export function resetGame(room: Room, status: 'lobby' | 'playing'): void {
  clearTimer(room);
  clearTakeback(room);
  clearDraw(room);
  room.chess = new Chess();
  room.gameSeq++;
  room.startFen = room.chess.fen();
  room.archived = false;
  room.status = status;
  room.gameOver = null;
  room.lastMove = null;
  room.lastMoveAuto = false;
  room.history = [];
  room.plyMetrics = [];
  room.clientSessions = { white: emptyClientSession(), black: emptyClientSession() };
  room.frames = [];
  room.marks.clear();
  room.bankedMs = null;
  room.turnStartedAt = null;
  // A fresh deal belongs to a game, not to a lobby: there is no hand to hold before the
  // first move exists to spend it on.
  room.cards = room.config.mode === 'cards' && status === 'playing' ? createCards() : null;
  room.white.cursor = 0;
  room.black.cursor = 0;
  for (const t of [room.white, room.black]) {
    for (const s of t.seats) { s.stats = emptyStats(); s.lastMoveAt = null; }
  }
}
