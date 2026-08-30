import { io, type Socket } from 'socket.io-client';
import type {
  RoomState, JoinResult, RoomConfig, Color, MovePayload, MoveFx, ChatMessage, MarkView,
  GameEnded, HandState, ProfileView, ArchivedGame, GameSummary, Account, AuthResult,
  AdminOverview, BugReport, Insights, FriendsView, FriendInvite, You,
} from '../types';
import { setState } from '../state/store';
import { attachTelemetry } from './telemetry';

const TOKEN_KEY = 'bl.token';
const NAME_KEY = 'bl.name';
const SESSION_KEY = 'bl.session';

/**
 * The signed session, kept apart from the seat token on purpose.
 *
 * The token reclaims a seat after a refresh and says nothing about who is holding it; the
 * session says who you are. Signing out clears one and leaves the other, so leaving your
 * account does not also stand you up from the board you are sitting at.
 */
export function getSession(): string | null {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}

function setSession(session: string | null): void {
  try {
    if (session) localStorage.setItem(SESSION_KEY, session);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* a browser refusing storage is a guest, not an error */ }
}

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

  // Telemetry gets the socket handed to it rather than importing it, so that the one
  // module in the app allowed to fail silently cannot reach into the one that must not.
  attachTelemetry((event, payload) => { socket?.volatile.emit(event, payload); });

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
    sock().emit('room:join',
      { roomId, name, token: getToken(), session: getSession() ?? undefined },
      (res: JoinResult) => resolve(res));
  });
}

// ---- accounts ----

function authCall(event: string, username: string, password: string): Promise<AuthResult> {
  return new Promise(resolve => {
    sock().emit(event, { username, password }, (res: AuthResult) => {
      if (res?.ok && res.session) setSession(res.session);
      resolve(res ?? { ok: false, error: 'No answer from the server.' });
    });
  });
}

export function registerAccount(username: string, password: string): Promise<AuthResult> {
  return authCall('auth:register', username, password);
}

export function loginAccount(username: string, password: string): Promise<AuthResult> {
  return authCall('auth:login', username, password);
}

export function logoutAccount(): void {
  setSession(null);
  sock().emit('auth:logout');
}

/**
 * Resume a stored session, and get the profile back in the same round trip.
 *
 * One call rather than two because the home screen needs both before it can decide what
 * to draw, and two would flash the signed-out panel on every load.
 */
export function resumeSession(): Promise<{ account: Account | null; profile: ProfileView | null }> {
  const session = getSession();
  if (!session) return Promise.resolve({ account: null, profile: null });
  return new Promise(resolve => {
    sock().emit('auth:resume', { session },
      (res: { account: Account | null; profile: ProfileView | null } | null) => {
        // a session the server will not honour is a session worth forgetting
        if (!res?.account) setSession(null);
        resolve(res ?? { account: null, profile: null });
      });
  });
}

/** Join a side. The server picks the seat, so two people pressing Join cannot collide. */
export function takeSeat(color: Color, seatId?: number): Promise<JoinResult> {
  return new Promise(resolve => {
    sock().emit('seat:take', { color, seatId }, (res: JoinResult) => resolve(res));
  });
}

export function leaveSeat(): void { sock().emit('seat:leave'); }
export function sendChat(text: string): void { sock().emit('chat:send', { text }); }
export function toggleMark(square: string): void { sock().emit('mark:toggle', { square }); }
export function clearMarks(): void { sock().emit('mark:clear'); }
/** Add a bot to a side (no seat named), or take a named bot back out. */
export function setSeatBot(color: Color, seatId: number | undefined, bot: boolean): void {
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
 * Answered from the socket's signed-in account, so there is no id to pass and none to
 * guess. A guest gets null, which is the honest answer: nothing is being kept for them.
 */
export function myProfile(limit = 25): Promise<ProfileView | null> {
  return new Promise(resolve => {
    sock().emit('profile:me', { limit }, (res: ProfileView | null) => resolve(res));
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

// ---- bug reports and admin ----

/** File a report. The context is whatever the caller could see when it was written. */
export function sendReport(text: string, context: Record<string, unknown>,
                           attachments: Array<{ name: string; dataUrl: string }> = []):
    Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    sock().emit('report:send', { text, context, attachments },
      (res: { ok: boolean; error?: string } | undefined) =>
        resolve(res ?? { ok: false, error: 'No answer from the server.' }));
  });
}

/** One screenshot off a report, admin only. Null when it is gone or you may not see it. */
export function adminAttachment(reportId: string, attachmentId: string):
    Promise<{ mime: string; base64: string } | null> {
  return new Promise(resolve => {
    sock().emit('admin:attachment', { reportId, attachmentId },
      (res: { mime: string; base64: string } | null) => resolve(res ?? null));
  });
}

/**
 * The admin calls all answer null when the socket's account is not an administrator.
 * The check lives on the server and is re-derived per call, so these are requests rather
 * than assertions about who is asking.
 */
export function adminOverview(): Promise<AdminOverview | null> {
  return new Promise(resolve => {
    sock().emit('admin:overview', {}, (res: AdminOverview | null) => resolve(res ?? null));
  });
}

/** The archive rolled up: distributions, mode health, the funnel and the guardrails. */
export function adminInsights(): Promise<Insights | null> {
  return new Promise(resolve => {
    sock().emit('admin:insights', {}, (res: Insights | null) => resolve(res ?? null));
  });
}

/**
 * Recompute the aggregate from the archive.
 *
 * Slow by design -- it reads every game -- so it is a button rather than something the
 * page does on its own. It is what makes the counters safe to change: there is always a
 * way to have the old games counted the new way.
 */
export function adminRebuildInsights(): Promise<Insights | null> {
  return new Promise(resolve => {
    sock().emit('admin:insights-rebuild', {}, (res: Insights | null) => resolve(res ?? null));
  });
}

export function adminReports(limit = 200): Promise<BugReport[] | null> {
  return new Promise(resolve => {
    sock().emit('admin:reports', { limit }, (res: BugReport[] | null) => resolve(res ?? null));
  });
}

export function adminResolveReport(id: string, resolved: boolean): Promise<BugReport | null> {
  return new Promise(resolve => {
    sock().emit('admin:report-resolve', { id, resolved },
      (res: BugReport | null) => resolve(res ?? null));
  });
}

// ---- friends ----

/**
 * The friend list, as the server sees it right now.
 *
 * Null for a guest: a friend list belongs to an account, and the server says so rather
 * than the client guessing from whether it has one.
 */
export function friendsList(): Promise<FriendsView | null> {
  return new Promise(resolve => {
    sock().emit('friends:list', {}, (res: FriendsView | null) => resolve(res ?? null));
  });
}

export interface FriendReply { ok: boolean; error?: string; accepted?: boolean }

export function addFriend(username: string): Promise<FriendReply> {
  return new Promise(resolve => {
    sock().emit('friends:add', { username },
      (res: FriendReply | undefined) => resolve(res ?? { ok: false, error: 'No answer' }));
  });
}

export function acceptFriend(id: string): Promise<FriendReply> {
  return new Promise(resolve => {
    sock().emit('friends:accept', { id },
      (res: FriendReply | undefined) => resolve(res ?? { ok: false, error: 'No answer' }));
  });
}

export function removeFriend(id: string): Promise<FriendReply> {
  return new Promise(resolve => {
    sock().emit('friends:remove', { id },
      (res: FriendReply | undefined) => resolve(res ?? { ok: false, error: 'No answer' }));
  });
}

/** Put this room on a friend's screen. Only works for a friend, and only from a room. */
export function inviteFriend(id: string): Promise<FriendReply> {
  return new Promise(resolve => {
    sock().emit('friends:invite', { id },
      (res: FriendReply | undefined) => resolve(res ?? { ok: false, error: 'No answer' }));
  });
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
/**
 * Who you are in this room, sent per-socket on every broadcast.
 *
 * Answered only on join and on taking a seat, this went stale the moment anything else
 * moved you -- standing up, or a bot taking the chair you left.
 */
export function onYou(fn: (you: You) => void): void { bind('room:you', fn); }
/** The friend list changed: somebody accepted, or came online, or left. */
export function onFriends(fn: (view: FriendsView) => void): void { bind('friends:state', fn); }
/** A friend is asking you to join them. */
export function onInvited(fn: (invite: FriendInvite) => void): void {
  bind('friends:invited', fn);
}
export function onMulliganed(fn: (e: { color: Color }) => void): void {
  bind('cards:mulliganed', fn);
}
/** A finished game reached the archive, and can now be reviewed by its id. */
export function onArchived(fn: (g: GameSummary) => void): void { bind('game:archived', fn); }
