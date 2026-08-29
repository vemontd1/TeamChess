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
}

export interface CardsPublic {
  white: CardSidePublic;
  black: CardSidePublic;
  drawTarget: number;   // 5, or 6 once soft enrage is on
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
  /**
   * Kinds swapped out at the start of this turn because that piece is gone from the
   * board. Reported so the swap can be explained rather than just happening.
   */
  replaced: CardKind[];
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

export interface Seat { color: Color; seatId: number; }

export interface You {
  token: string;
  name: string;
  isHost: boolean;
  seat: Seat | null;
}

// --- socket event payloads ---
export interface CreatePayload { name: string; config: Partial<RoomConfig>; }
export interface JoinPayload { roomId: string; name: string; token?: string; }
export interface SeatTakePayload { color: Color; seatId: number; }
export interface SeatBotPayload { color: Color; seatId: number; bot: boolean; }
export interface MovePayload {
  from: string; to: string; promotion?: string;
  /** Cards mode: which card pays for this move. Omitted lets the server choose. */
  cardId?: number;
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
}
