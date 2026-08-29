import type { RoomState, You, ChatMessage, MarkView } from '../types';

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

// ---- derived helpers ----

/** Which way up the board should sit: your team if seated, else White. */
export function orientation(s: AppState = state): Orientation {
  if (s.orientationOverride) return s.orientationOverride;
  return s.you?.seat?.color ?? 'white';
}

/** True when it is this browser's turn to move. */
export function isMyTurn(s: AppState = state): boolean {
  const { room, you } = s;
  if (!room || !you?.seat || room.status !== 'playing') return false;
  if (room.pendingTakeback) return false;
  return room.activeColor === you.seat.color && room.activeSeatId === you.seat.seatId;
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

/** True when this browser may ask for a takeback (it played the last ply). */
export function canRequestTakeback(s: AppState = state): boolean {
  const { room, you } = s;
  if (!room || !you?.seat || room.status !== 'playing') return false;
  if (!room.config.allowTakeback || room.pendingTakeback) return false;
  const last = room.history[room.history.length - 1];
  return !!last && last.color === you.seat.color;
}
