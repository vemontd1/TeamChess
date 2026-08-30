import { io, type Socket } from 'socket.io-client';
import type {
  RoomState, JoinResult, RoomConfig, Color, MovePayload, MoveFx, ChatMessage, MarkView,
  GameEnded, HandState, ProfileView, ArchivedGame, GameSummary,
} from '../types';
import { setState } from '../state/store';

const TOKEN_KEY = 'bl.token';
const NAME_KEY = 'bl.name';

export function getToken(): string {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = (crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now().toString(36));
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

export function getName(): string {
  return localStorage.getItem(NAME_KEY) ?? '';
}

export function setName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
}

let socket: Socket | null = null;

export function connect(): Socket {
  if (socket) return socket;
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => setState({ connected: true }));
  socket.on('disconnect', () => setState({ connected: false }));
  socket.on('room:state', (state: RoomState) => setState({ room: state }));

  return socket;
}

function sock(): Socket {
  return socket ?? connect();
}

// ---- typed emitters ----

export function createRoom(name: string, config: Partial<RoomConfig>): Promise<string> {
  return new Promise(resolve => {
    sock().emit('room:create', { name, config }, (roomId: string) => resolve(roomId));
  });
}

export function joinRoom(roomId: string, name: string): Promise<JoinResult> {
  return new Promise(resolve => {
    sock().emit('room:join', { roomId, name, token: getToken() }, (res: JoinResult) => resolve(res));
  });
}

export function takeSeat(color: Color, seatId: number): Promise<JoinResult> {
  return new Promise(resolve => {
    sock().emit('seat:take', { color, seatId }, (res: JoinResult) => resolve(res));
  });
}

export function leaveSeat(): void { sock().emit('seat:leave'); }
export function sendChat(text: string): void { sock().emit('chat:send', { text }); }
export function toggleMark(square: string): void { sock().emit('mark:toggle', { square }); }
export function clearMarks(): void { sock().emit('mark:clear'); }
export function setSeatBot(color: Color, seatId: number, bot: boolean): void {
  sock().emit('seat:bot', { color, seatId, bot });
}
export function startGame(): void { sock().emit('game:start'); }
export function rematch(): void { sock().emit('game:rematch'); }
export function resetToLobby(): void { sock().emit('game:reset'); }
export function requestTakeback(): void { sock().emit('takeback:request'); }
export function respondTakeback(accept: boolean): void {
  sock().emit('takeback:respond', { accept });
}
export function resign(): void { sock().emit('game:resign'); }
export function mulligan(): void { sock().emit('cards:mulligan'); }
export function offerDraw(): void { sock().emit('draw:offer'); }
export function respondDraw(accept: boolean): void {
  sock().emit('draw:respond', { accept });
}

export function sendMove(m: MovePayload): Promise<boolean> {
  return new Promise(resolve => {
    sock().emit('game:move', m, (ok: boolean) => resolve(ok));
  });
}

// ---- the archive and profiles ----

/**
 * Your own profile and the games on it.
 *
 * The token goes in the payload because the home screen asks for this before it has
 * joined any room, so the socket has no token of its own to read yet. It is this
 * browser's own secret in both directions.
 */
export function myProfile(limit = 25): Promise<ProfileView | null> {
  return new Promise(resolve => {
    sock().emit('profile:me', { token: getToken(), limit },
      (res: ProfileView | null) => resolve(res));
  });
}

/** Finished games are plain HTTP: they are static once written, and cacheable. */
export async function fetchGame(id: string): Promise<ArchivedGame | null> {
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(id)}`);
    return res.ok ? (await res.json()) as ArchivedGame : null;
  } catch { return null; }
}

export async function fetchRecentGames(limit = 20): Promise<GameSummary[]> {
  try {
    const res = await fetch(`/api/games?limit=${limit}`);
    return res.ok ? (await res.json()) as GameSummary[] : [];
  } catch { return []; }
}

/** Where a game's PGN lives, for the download link on the review screen. */
export function pgnUrl(id: string): string {
  return `/api/games/${encodeURIComponent(id)}/pgn`;
}

// ---- inbound side-effect events ----

/**
 * Replace rather than add. The room view is torn down and rebuilt on every route change,
 * and a plain `on` left the previous view's handlers attached -- so re-entering a room
 * played every sound twice.
 */
function bind<T>(event: string, fn: (payload: T) => void): void {
  const s = sock();
  s.off(event);
  s.on(event, fn);
}

export function onFx(fn: (fx: MoveFx) => void): void { bind('game:fx', fn); }
export function onGameStart(fn: () => void): void { bind('game:start', fn); }
export function onSeatJoin(fn: () => void): void { bind('game:seat-join', fn); }
export function onTakebackResolved(fn: (r: { accepted: boolean }) => void): void {
  bind('takeback:resolved', fn);
}
export function onDrawResolved(fn: (r: { accepted: boolean }) => void): void {
  bind('draw:resolved', fn);
}
/** A game ended by something other than the board: a resignation or an agreed draw. */
export function onGameEnded(fn: (e: GameEnded) => void): void { bind('game:ended', fn); }
export function onChat(fn: (m: ChatMessage) => void): void { bind('chat:new', fn); }
export function onChatHistory(fn: (m: ChatMessage[]) => void): void { bind('chat:history', fn); }
export function onMarks(fn: (m: MarkView[]) => void): void { bind('mark:state', fn); }
/** Your own hand, sent per-socket -- never part of the broadcast room state. */
export function onHand(fn: (h: HandState | null) => void): void { bind('cards:hand', fn); }
export function onMulliganed(fn: (e: { color: Color }) => void): void {
  bind('cards:mulliganed', fn);
}
/** A finished game reached the archive, and can now be reviewed by its id. */
export function onArchived(fn: (g: GameSummary) => void): void { bind('game:archived', fn); }
