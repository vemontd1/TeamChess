import { Chess } from 'chess.js';
import { pickMove, pieceValue, type MoveStyle } from './bots.js';
import type {
  Color, RoomConfig, RoomState, SeatView, TeamView, GameOver, SeatKind,
  SeatStats, HistoryEntry, PendingTakeback, PendingDraw, MovePayload, ChatMessage,
  ChatChannel, MarkView,
} from './types.js';

export interface InternalSeat {
  id: number;
  name: string | null;
  token: string | null;
  kind: SeatKind;
  connected: boolean;
  stats: SeatStats;
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
  frames: PlyFrame[];
  gameOver: GameOver | null;
  chat: ChatMessage[];              // every channel; filtered when delivered
  chatSeq: number;
  marks: Map<string, TeamMarks>;    // seat token -> that player's flagged squares
}

/** Squares one seated player has flagged for their team this ply. */
export interface TeamMarks {
  color: Color;
  name: string;
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
      id, name: null, token: null, kind: 'human' as SeatKind,
      connected: false, stats: emptyStats(),
    })),
  };
}

export function sanitizeConfig(c: Partial<RoomConfig> | undefined): RoomConfig {
  const teamSize = Math.min(5, Math.max(1, Math.floor(Number(c?.teamSize) || 2)));
  let moveTimerSec: number | null = null;
  const raw = Number(c?.moveTimerSec);
  if (c?.moveTimerSec != null && Number.isFinite(raw) && raw > 0) {
    moveTimerSec = Math.min(600, Math.max(5, Math.floor(raw)));
  }
  return {
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
    frames: [],
    gameOver: null,
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
  san?: string;
}

const FAIL: ApplyResult = {
  ok: false, captured: false, castle: false, promotion: false, check: false,
};

/** Validate and apply one ply, advancing only the moving team's cursor. */
export function applyMove(room: Room, m: MovePayload, opts: { auto?: boolean } = {}): ApplyResult {
  const mover: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  const team = teamFor(room, mover);
  const seat = activeSeat(room, team);

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
  };

  room.frames.push({
    cursorWhite: room.white.cursor,
    cursorBlack: room.black.cursor,
    lastMove: room.lastMove,
    lastMoveAuto: room.lastMoveAuto,
    entry,
    capturedValue,
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

  room.lastMove = { from: res.from, to: res.to };
  room.lastMoveAuto = auto;
  // marks describe *this* position, so they expire with it -- and so does a draw offer,
  // which was made about a position that no longer exists
  room.marks.clear();
  clearDraw(room);

  // advance this team's rotation past the seat that just moved
  if (seat) team.cursor = (seat.id + 1) % team.seats.length;
  else team.cursor = (team.cursor + 1) % team.seats.length;

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
    san: res.san,
  };
}

/** Rewind one ply, restoring rotation cursors and stats along with the board. */
export function undoPly(room: Room): boolean {
  const frame = room.frames.pop();
  if (!frame) return false;
  const undone = room.chess.undo();
  if (!undone) { room.frames.push(frame); return false; }

  room.history.pop();
  room.marks.clear();
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

/** Play a move for a seat that ran out of time: a uniformly random legal move. */
export function playForcedMove(room: Room, style: MoveStyle = 'random'): ApplyResult | null {
  const mv = pickMove(room.chess, style);
  if (!mv) return null;
  return applyMove(room, mv, { auto: style === 'random' });
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
export function toggleMark(room: Room, token: string, square: unknown): boolean {
  if (typeof square !== 'string' || !SQUARE_RE.test(square)) return false;
  const seat = seatByToken(room, token);
  if (!seat) return false;

  let entry = room.marks.get(token);
  if (!entry) {
    entry = { color: seat.color, name: seat.seat.name ?? 'Player', squares: [] };
    room.marks.set(token, entry);
  }
  entry.color = seat.color;
  entry.name = seat.seat.name ?? 'Player';

  const at = entry.squares.indexOf(square);
  if (at >= 0) entry.squares.splice(at, 1);
  else if (entry.squares.length < MAX_MARKS) entry.squares.push(square);
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
    for (const square of entry.squares) {
      out.push({ square, name: entry.name, own: owner === token });
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
  room.status = status;
  room.gameOver = null;
  room.lastMove = null;
  room.lastMoveAuto = false;
  room.history = [];
  room.frames = [];
  room.marks.clear();
  room.bankedMs = null;
  room.turnStartedAt = null;
  room.white.cursor = 0;
  room.black.cursor = 0;
  for (const t of [room.white, room.black]) {
    for (const s of t.seats) s.stats = emptyStats();
  }
}
