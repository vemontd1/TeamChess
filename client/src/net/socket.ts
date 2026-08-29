import { io, type Socket } from 'socket.io-client';
import type {
  RoomState, JoinResult, RoomConfig, Color, MovePayload, MoveFx, ChatMessage, MarkView,
  GameEnded,
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
export function offerDraw(): void { sock().emit('draw:offer'); }
export function respondDraw(accept: boolean): void {
  sock().emit('draw:respond', { accept });
}

export function sendMove(m: MovePayload): Promise<boolean> {
  return new Promise(resolve => {
    sock().emit('game:move', m, (ok: boolean) => resolve(ok));
  });
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
