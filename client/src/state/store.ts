import { Chess } from 'chess.js';
import type {
  RoomState, You, ChatMessage, MarkView, HandState, HistoryEntry, GameSummary,
  Account, ProfileView,
} from '../types';

/** The position every game starts from, and what ply 0 shows in review. */
export const START_FEN = new Chess().fen();

export type Orientation = 'white' | 'black';

export interface AppState {
  connected: boolean;
  you: You | null;
  room: RoomState | null;
  /** null = follow your own team; set explicitly by the flip control. */
  orientationOverride: Orientation | null;
  soundOn: boolean;
  statsOpen: boolean;
  error: string | null;
  /** Team chat, accumulated from the socket -- never part of RoomState, which is
      broadcast to both teams. */
  chat: ChatMessage[];
  /** Squares your own team has flagged for the current position. */
  marks: MarkView[];
  /** The finished game's archive entry, once the server has written it. */
  archived: GameSummary | null;
  /**
   * The signed-in account, or null for a guest.
   *
   * Resolved once at startup from the stored session, then kept here rather than fetched
   * per page: the header on every page outside the room has to know the answer, and
   * asking again on each navigation would flash the signed-out header on the way in.
   */
  account: Account | null;
  /** The profile last fetched, so arriving at the profile page is not a spinner. */
  profile: ProfileView | null;
  /** Cards mode: your own hand. Null in team mode, or if you hold no seat. */
  hand: HandState | null;
  /** The card you have picked to pay for your next move; null lets the server choose. */
  selectedCardId: number | null;
  /**
   * Which ply the board is showing, or null for the live position.
   *
   * 0 is the starting position, 1 is after White's first move, and so on. Review is
   * strictly a client-side lens: the server is never told, nothing about the game pauses,
   * and the clock keeps running -- so stepping back to check what happened four moves ago
   * cannot cost a player the position they were about to play.
   */
  reviewPly: number | null;
}

type Listener = (s: AppState, prev: AppState) => void;

const state: AppState = {
  connected: false,
  you: null,
  room: null,
  orientationOverride: null,
  soundOn: true,
  statsOpen: false,
  error: null,
  chat: [],
  marks: [],
  archived: null,
  account: null,
  profile: null,
  hand: null,
  selectedCardId: null,
  reviewPly: null,
};

const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  const prev = { ...state };
  Object.assign(state, patch);
  for (const l of listeners) l(state, prev);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// ---- review ----

/**
 * The position on the board right now: the reviewed ply if one is being read, else live.
 *
 * The FEN comes from the history entry rather than being replayed, because the server
 * records one per ply. That is what makes review free at this end -- no move generator, no
 * loop from the start, and no chance of the two ends disagreeing about what a position was.
 */
export function shownPosition(s: AppState = state): {
  fen: string;
  lastMove: { from: string; to: string } | null;
  inCheck: boolean;
  live: boolean;
} {
  const room = s.room;
  if (!room) {
    return { fen: START_FEN, lastMove: null, inCheck: false, live: true };
  }
  const ply = s.reviewPly;
  if (ply == null || ply >= room.history.length) {
    return {
      fen: room.fen, lastMove: room.lastMove, inCheck: room.inCheck, live: true,
    };
  }
  if (ply <= 0) {
    return { fen: START_FEN, lastMove: null, inCheck: false, live: false };
  }
  const entry = room.history[ply - 1];
  return {
    fen: entry.fen,
    lastMove: { from: entry.from, to: entry.to },
    // A check flag is not recorded per ply, and the FEN alone does not carry one -- but
    // the SAN does, and it is what a move list already shows.
    inCheck: /[+#]$/.test(entry.san),
    live: false,
  };
}

/** True when the board is showing an earlier position rather than the live one. */
export function isReviewing(s: AppState = state): boolean {
  return !shownPosition(s).live;
}

/** Step review to a ply, clamped; anything at or past the end drops back to live. */
export function setReviewPly(ply: number | null): void {
  const room = state.room;
  if (ply == null || !room) { setState({ reviewPly: null }); return; }
  const clamped = Math.max(0, Math.min(room.history.length, Math.round(ply)));
  setState({ reviewPly: clamped >= room.history.length ? null : clamped });
}

/** The ply review is sitting on, resolved against the live end of the game. */
export function reviewAt(s: AppState = state): number {
  return s.reviewPly ?? (s.room?.history.length ?? 0);
}

/** The entry review is sitting on, for anything that needs to describe it. */
export function reviewEntry(s: AppState = state): HistoryEntry | null {
  const at = reviewAt(s);
  return at > 0 ? (s.room?.history[at - 1] ?? null) : null;
}

// ---- derived helpers ----

/** Which way up the board should sit: your team if seated, else White. */
export function orientation(s: AppState = state): Orientation {
  if (s.orientationOverride) return s.orientationOverride;
  return s.you?.seat?.color ?? 'white';
}

/**
 * True when it is this browser's turn to move.
 *
 * Reviewing an earlier position does not stop being your turn -- the clock says so -- but
 * it does stop you moving, because the pieces on screen are not where they are. The board
 * is disabled through `canMoveNow` rather than here, so everything else that asks "is it
 * my turn" (the alert, the chime, the card hand) still gets the honest answer.
 */
export function isMyTurn(s: AppState = state): boolean {
  const { room, you } = s;
  if (!room || !you?.seat || room.status !== 'playing') return false;
  if (room.pendingTakeback) return false;
  return room.activeColor === you.seat.color && room.activeSeatId === you.seat.seatId;
}

/** True when this browser may actually drag a piece: its turn, and looking at it. */
export function canMoveNow(s: AppState = state): boolean {
  return isMyTurn(s) && !isReviewing(s);
}

/** True when this browser holds a seat, and so may chat to a team and mark squares. */
export function isSeated(s: AppState = state): boolean {
  return !!s.you?.seat;
}

/** True when this browser must answer a pending takeback request. */
export function mustAnswerTakeback(s: AppState = state): boolean {
  const { room, you } = s;
  const pending = room?.pendingTakeback;
  if (!room || !you?.seat || !pending) return false;
  if (you.seat.color === pending.byColor) return false;
  return room.turn === you.seat.color && room.activeSeatId === you.seat.seatId;
}

/** True when this room is running Chess Cards rather than the team game. */
export function isCardsMode(s: AppState = state): boolean {
  return s.room?.config.mode === 'cards';
}

/**
 * True when this browser may offer a draw or resign: any seated player, at any point in a
 * live game. Unlike a takeback this is not tied to having just moved -- a player watching
 * a hopeless position through four teammates' turns is exactly who wants it.
 */
export function canEndGame(s: AppState = state): boolean {
  const { room, you } = s;
  return !!room && !!you?.seat && room.status === 'playing';
}

/** True when this browser may offer a draw right now. */
export function canOfferDraw(s: AppState = state): boolean {
  const { room } = s;
  return canEndGame(s) && !room!.pendingDraw && !room!.pendingTakeback;
}

/** True when this browser must answer a draw offer: the opposing team's active seat. */
export function mustAnswerDraw(s: AppState = state): boolean {
  const { room, you } = s;
  const pending = room?.pendingDraw;
  if (!room || !you?.seat || !pending) return false;
  if (you.seat.color === pending.byColor) return false;
  return room[you.seat.color].activeSeatId === you.seat.seatId;
}

/** True when this browser may ask for a takeback (it played the last ply). */
export function canRequestTakeback(s: AppState = state): boolean {
  const { room, you } = s;
  if (!room || !you?.seat || room.status !== 'playing') return false;
  if (!room.config.allowTakeback || room.pendingTakeback) return false;
  const last = room.history[room.history.length - 1];
  return !!last && last.color === you.seat.color;
}
