export type Color = 'white' | 'black';
export type Status = 'lobby' | 'playing' | 'finished';
export type SeatKind = 'human' | 'bot';

/**
 * `team` is the rotating-control team game. `cards` is Chess Cards: a strict 1v1 where a
 * player may only move a piece type they hold a card for, the king excepted.
 */
export type GameMode = 'team' | 'cards';

export interface RoomConfig {
  mode: GameMode;
  teamSize: number;            // 1..5, forced to 1 in cards mode
  skipEmptySeats: boolean;     // rotation only cycles occupied seats
  moveTimerSec: number | null; // per-move countdown, null = off
  allowTakeback: boolean;
}

// --- cards ---

export type CardKind = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'wild';

/** One card in your own hand, with whether it can actually move anything right now. */
export interface HandCard {
  id: number;
  kind: CardKind;
  playable: boolean;
}

/** What both players see of a side's cards: counts and a face-up discard, never a hand. */
export interface CardSidePublic {
  handCount: number;
  deckCount: number;
  discardCount: number;
  mulliganUsed: boolean;
  emergenciesUsed: number;
  played: CardKind[];
  sacrificesUsed: number;
  /** Plies until this side may sacrifice again; 0 means now. */
  sacrificeReadyIn: number;
  /**
   * How many cards this side may hold right now.
   *
   * Not a constant: it falls with the army, because a card is only worth holding while
   * you still own a piece it names. Public, because both players can count each other's
   * pieces anyway.
   */
  handCap: number;
}

export interface CardsPublic {
  white: CardSidePublic;
  black: CardSidePublic;
  /** Cards dealt at the start of a turn: two, or three once soft enrage is on. */
  drawPerTurn: number;
  handMax: number;
  sacrificeCost: number;
  enraged: boolean;
}

/**
 * Your own hand, delivered per-socket rather than in `RoomState` -- that object is
 * broadcast to the whole room, so a hand put in it would be readable in the opponent's
 * devtools, which in a game built on hidden information is the entire exploit.
 */
export interface HandState {
  color: Color;
  cards: HandCard[];
  /** True when no card in hand can move anything: the safety net is offered. */
  emergency: boolean;
  mulliganAvailable: boolean;
  yourTurn: boolean;
  /** Kinds cycled away this turn while looking for something that could move. */
  cycled: CardKind[];
  /**
   * Kinds swapped out at the start of this turn because that piece is gone from the
   * board. Reported so the swap can be explained rather than just happening.
   */
  replaced: CardKind[];
  /** Cards a sacrifice costs, and whether one can be paid out of this hand right now. */
  sacrificeCost: number;
  sacrificeAvailable: boolean;
  /** Plies until the sacrifice comes off cooldown; 0 when it is ready. */
  sacrificeReadyIn: number;
  /** The cap this hand is currently held to, which shrinks with the army. */
  handCap: number;
  /**
   * Whether a castle could be paid for out of this hand.
   *
   * Castling is the one king move that is not free -- the rook travels too, so it costs a
   * Rook card. The board needs to know, or it would offer a castle it is about to refuse.
   */
  canCastle: boolean;
}

export interface SeatStats {
  moves: number;          // moves this seat actually played
  autoMoves: number;      // moves forced by the clock running out
  botMoves: number;       // moves played by a bot occupying this seat
  thinkMsTotal: number;   // cumulative deliberation time
  captured: number;       // material points taken
}

export interface SeatView {
  id: number;
  name: string | null;
  kind: SeatKind;
  occupied: boolean;
  connected: boolean;
  stats: SeatStats;
}

export interface TeamView {
  color: Color;
  seats: SeatView[];
  activeSeatId: number | null;
}

export interface GameOver {
  reason: 'checkmate' | 'stalemate' | 'threefold' | 'fifty-move' | 'insufficient'
        | 'draw' | 'agreement' | 'resignation';
  winner: Color | 'draw' | null;
}

export interface HistoryEntry {
  ply: number;
  san: string;
  color: Color;
  seatId: number;
  playerName: string;
  auto: boolean;   // forced by timeout
  bot: boolean;    // played by a bot seat
  /**
   * The position this ply produced.
   *
   * Carried per ply rather than replayed from the SAN list on demand: a client stepping
   * back through the game then needs no chess engine and no replay loop, and an archived
   * game is reviewable exactly as it was even if the move generator ever changes under it.
   */
  fen: string;
  from: string;
  to: string;
}

export interface PendingTakeback {
  byColor: Color;       // team asking to take the move back
  byName: string;
  deadline: number;     // epoch ms when the request auto-declines
  remainingMs: number;  // the same window as a duration, immune to client clock skew
}

/** A draw offered by one team, awaiting the other team's active seat. */
export interface PendingDraw {
  byColor: Color;
  byName: string;
  deadline: number;     // epoch ms when the offer lapses
  remainingMs: number;  // time left on the offer, measured on the server's own clock
}

export interface RoomState {
  id: string;
  /**
   * Which game this is in this room, counting from one.
   *
   * A rematch resets everything else, so this is the only thing that tells two games
   * apart -- and "have I already announced this result?" has to mean *this* result.
   */
  gameSeq: number;
  status: Status;
  fen: string;
  turn: Color;
  white: TeamView;
  black: TeamView;
  activeColor: Color | null;
  activeSeatId: number | null;
  activePlayerName: string | null;
  turnDeadline: number | null;
  /**
   * Time left on the current turn, measured on the server's own clock at the instant this
   * snapshot was taken. `turnDeadline` alone is an absolute server epoch, and a client
   * whose clock is off by even a few seconds -- which is common, and was the case on the
   * deployed host -- subtracts it from its own `Date.now()` and gets a countdown that is
   * wrong or pinned at zero. A duration carries no clock in it, so it cannot skew.
   */
  turnRemainingMs: number | null;
  lastMove: { from: string; to: string } | null;
  lastMoveAuto: boolean;
  history: HistoryEntry[];
  inCheck: boolean;
  gameOver: GameOver | null;
  spectatorCount: number;
  pendingTakeback: PendingTakeback | null;
  pendingDraw: PendingDraw | null;
  /** Null in team mode. */
  cards: CardsPublic | null;
  config: RoomConfig;
}

// --- accounts ---

/** A registered player, as everyone else may see them. Never carries a hash or a salt. */
export interface Account {
  id: string;
  username: string;
  createdAt: number;
  /**
   * Set from the `ADMIN_USERS` environment variable, never from anything a client sends
   * and never stored on the account -- so admin is a property of the deployment rather
   * than of a row somebody might be able to edit.
   */
  isAdmin?: boolean;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  account?: Account;
  /**
   * The signed session the client stores. Separate from the seat token on purpose:
   * signing out must not cost you the seat you are sitting in, and reclaiming a seat
   * must not require being signed in.
   */
  session?: string;
}

export interface AuthPayload { username?: string; password?: string; }
export interface SessionPayload { session?: string; }

// --- the archive: finished games kept on disk ---

export type GameResult = 'white' | 'black' | 'draw' | 'unfinished';

/** Enough of a game to list it without opening the file it lives in. */
export interface GameSummary {
  id: string;
  roomId: string;
  mode: GameMode;
  /** The room's settings, so a listing can report what people actually play. */
  config?: RoomConfig;
  finishedAt: number;
  plies: number;
  white: string[];
  black: string[];
  result: GameResult;
  reason: string;
}

/**
 * A whole finished game. `history` carries a FEN per ply, so replaying this needs no move
 * generator at either end -- the archive is a record of positions, not of instructions
 * for reconstructing them.
 */
export interface ArchivedGame {
  id: string;
  finishedAt: number;
  roomId: string;
  config: RoomConfig;
  white: string[];
  black: string[];
  history: HistoryEntry[];
  startFen: string;
  finalFen: string;
  result: GameResult;
  reason: string;
}

// --- profiles ---

export interface ProfileRecord { wins: number; losses: number; draws: number; }

/**
 * A player, as thinly as a player can be recorded: a name, a tally, and the games behind
 * it. There is no account and no password -- the browser's own token is the identity, and
 * the id below is a hash of it, so a profile can be read from a URL without that URL
 * being the credential that reclaims the player's seats.
 */
export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  games: number;
  record: ProfileRecord;
}

/** One archived game as it looked from a particular player's side of the board. */
export interface ProfileGame extends GameSummary {
  yourColor: Color;
  yourResult: 'win' | 'loss' | 'draw';
  opponents: string[];
}

export interface ProfileView {
  profile: Profile;
  games: ProfileGame[];
  /**
   * Games finished per day, keyed `YYYY-MM-DD`, for the activity grid.
   *
   * Counted as games are recorded rather than derived from `games`, so the grid keeps
   * counting after a game has fallen off the end of the list -- the list is capped, and a
   * year of play would otherwise show a heatmap that quietly emptied from the left.
   */
  activity: Record<string, number>;
}

// --- bug reports ---

/** What the client knew when a report was filed. Every field is optional by nature. */
export interface ReportContext {
  route: string | null;
  roomId: string | null;
  mode: GameMode | null;
  gameSeq: number | null;
  status: string | null;
  fen: string | null;
  plies: number | null;
  userAgent: string | null;
  viewport: string | null;
}

export interface BugReport {
  id: string;
  at: number;
  text: string;
  /** The name the reporter was playing under; an account id when they had one. */
  reporter: string;
  accountId: string | null;
  context: ReportContext;
  resolved: boolean;
  resolvedAt?: number;
}

export interface ReportPayload { text?: string; context?: unknown; }

// --- admin ---

/** Everything the admin panel shows, computed from the archive and the stores. */
export interface AdminOverview {
  games: {
    total: number;
    byMode: Record<string, number>;
    byResult: Record<string, number>;
    byReason: Record<string, number>;
    avgPlies: number;
    last7: number;
  };
  /** Room configurations, most used first. */
  setups: Array<{ label: string; count: number }>;
  accounts: number;
  profiles: number;
  reportsOpen: number;
  rooms: { live: number; playing: number };
  recent: GameSummary[];
}

export interface Seat { color: Color; seatId: number; }

export interface You {
  token: string;
  name: string;
  isHost: boolean;
  seat: Seat | null;
}

// --- socket event payloads ---
export interface CreatePayload { name: string; config: Partial<RoomConfig>; }
export interface JoinPayload {
  roomId: string; name: string; token?: string;
  /** A signed session, if the player is signed in. The account names them if so. */
  session?: string;
}
/**
 * `seatId` is optional on both: omitted (or negative) means "the first free seat on that
 * team", resolved by the server. The client used to pick the seat itself, which made
 * every join a small race -- two people pressing Join at the same moment both named seat
 * 1 and one of them got an error about a seat they never chose.
 */
export interface SeatTakePayload { color: Color; seatId?: number; }
export interface SeatBotPayload { color: Color; seatId?: number; bot: boolean; }
export interface MovePayload {
  from: string; to: string; promotion?: string;
  /** Cards mode: which card pays for this move. Omitted lets the server choose. */
  cardId?: number;
  /**
   * Cards mode: burn these cards instead, and move whatever you like. Takes precedence
   * over `cardId`, and is refused outright unless it names exactly the cost, in cards the
   * hand actually holds, off cooldown.
   */
  sacrificeIds?: number[];
}
export interface TakebackRespondPayload { accept: boolean; }
export interface DrawRespondPayload { accept: boolean; }
export interface JoinResult {
  ok: boolean;
  error?: string;
  you?: You;
  state?: RoomState;
}

// --- team coordination ---

/**
 * Chat and marks are team-scoped: a message reaches your own team only, spectators talk
 * among themselves, and neither ever crosses to the opposing team. That is enforced on
 * delivery rather than by filtering in the client -- otherwise the opposing team could
 * simply read the traffic in devtools, which in a game about coordinating a team would be
 * the whole exploit.
 */
export type ChatChannel = 'white' | 'black' | 'spectator';

export interface ChatMessage {
  id: number;
  channel: ChatChannel;
  name: string;
  text: string;
  at: number;
}

/** A square a teammate has flagged as interesting. Cleared whenever a ply is played. */
export interface MarkView {
  square: string;
  name: string;
  own: boolean;   // computed per recipient
}

export interface ChatSendPayload { text: string; }
export interface MarkTogglePayload { square: string; }

// --- client-only ---

/** Announced when a game ends by agreement rather than on the board. */
export type GameEnded =
  | { kind: 'resign'; byColor: Color; byName: string }
  | { kind: 'draw-agreed' };

export interface MoveFx {
  captured: boolean; castle: boolean; promotion: boolean; check: boolean; auto: boolean;
  /** Cards mode: this move was bought by burning a hand of cards. */
  sacrifice: boolean;
}
