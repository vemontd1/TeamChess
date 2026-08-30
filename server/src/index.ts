import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { Server, Socket } from 'socket.io';
import {
  rooms, createRoom, sanitizeConfig, teamFor, activeSeat, seatByToken,
  occupiedCount, liveHumans, seatedHumans, firstFreeSeat, applyMove, undoPly, clearTimer,
  clearTakeback, armTurn,
  playForcedMove, serialize, resetGame, channelFor, chatFor, cleanChatText,
  pushChat, toggleMark, clearMarksFor, marksFor, clearDraw, useMulligan, handCapOf,
  type Room, type TurnHooks,
} from './room.js';
import { handView, canSacrifice, sacrificeReadyIn, canCastle, TUNING } from './cards.js';
import { summariseGame } from './metrics.js';
import { initArchive, saveGame, listGames, loadGame, toPgn } from './archive.js';
import {
  initInsights, insightsView, foldGame, noteFunnel, rebuildInsights,
} from './insights.js';
import {
  initProfiles, touchProfile, recordGame, profileView, profileCount,
} from './profiles.js';
import {
  initAccounts, register, login, accountFromSession, accountCount,
} from './accounts.js';
import {
  initReports, fileReport, listReports, setResolved, openCount, readAttachment,
  MAX_REPORT_CHARS,
} from './reports.js';
import {
  initFriends, friendsView, requestFriend, accept, unfriend, areFriends, friendIdsOf,
  nowOnline, nowOffline, socketsOf, onlineCount, friendshipCount,
  type FriendResult,
} from './friends.js';
import type {
  Color, CreatePayload, JoinPayload, SeatTakePayload, SeatBotPayload,
  MovePayload, TakebackRespondPayload, DrawRespondPayload, JoinResult, You,
  ChatSendPayload, MarkTogglePayload, GameResult, GameSummary, GameMetrics, ProfileView,
  Account, AuthPayload, AuthResult, SessionPayload,
  BugReport, ReportPayload, AdminOverview, Insights, ClientInfo,
  FriendsView, FriendInvite,
} from './types.js';

const TAKEBACK_WINDOW_MS = 20_000;
const DRAW_WINDOW_MS = 20_000;

/**
 * How long an empty room is kept before it is thrown away.
 *
 * Long enough to survive a refresh, a dropped connection or a walk to the kettle; short
 * enough that a room nobody came back to is not still holding a seat an hour later. The
 * timer is cancelled the moment anybody joins.
 *
 * Overridable so the integration suite can watch a room actually go rather than assert
 * that a timer was scheduled and hope.
 */
const ROOM_GRACE_MS = Number(process.env.ROOM_GRACE_MS) || 3 * 60_000;

// Chat is the one place a client can push arbitrary text at everyone else, so it gets a
// token bucket: a burst of six is fine, sustained is one every two seconds.
const CHAT_BURST = 6;
const CHAT_REFILL_MS = 2_000;

/**
 * Telemetry is chattier than chat and worth a great deal less, so it gets a bucket of its
 * own: a burst that covers an opening flurry of turns, refilling at about one a second.
 * Over budget is dropped, never queued and never answered -- the channel is advisory, and
 * a client that floods it should lose packets rather than get a reply worth retrying.
 */
const TELEMETRY_BURST = 20;
const TELEMETRY_REFILL_MS = 1_000;

/** What a client reports about the turn it just took. Every field is clamped on arrival. */
interface TelemetryTurnPayload {
  gameSeq: number;
  ply: number;
  pickups?: number;
  cardSelections?: number;
  timeToFirstTouchMs?: number | null;
  premove?: 'none' | 'played' | 'rejected';
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  // A bug report can carry screenshots, and the default 1MB frame would drop the whole
  // connection rather than the attachment -- a silent failure that looks like the report
  // button being broken. The server still refuses anything oversized on its own terms.
  maxHttpBufferSize: 12e6,
});

/** Occupied seats' names, in seat order -- who actually played for a side. */
function rosterOf(room: Room, color: Color): string[] {
  return teamFor(room, color).seats
    .filter(seat => seat.token != null || seat.kind === 'bot')
    .map(seat => seat.name ?? (seat.kind === 'bot' ? 'Bot' : 'Player'));
}

/**
 * Write a finished game out, once, and credit it to everyone who played it.
 *
 * Called from `broadcast`, which every path that can end a game already goes through --
 * a mate, a resignation, an agreed draw, a clock running out into a mate. Hanging it off
 * the one funnel rather than off five call sites is what stops the sixth ending, whenever
 * it is added, from quietly going unrecorded. The `archived` flag makes every call after
 * the first a no-op, so the cost of putting it here is one boolean test per broadcast.
 *
 * A failed archive returns null and is not fatal: a game that could not be written is
 * still a game that was played, and taking the room down over it would be the worse bug.
 */
function archiveIfFinished(room: Room): void {
  if (room.archived || room.status !== 'finished') return;
  room.archived = true;

  const winner = room.gameOver?.winner;
  const result: GameResult = winner === 'white' || winner === 'black' ? winner
    : winner === 'draw' ? 'draw' : 'unfinished';
  finishGame(room, result, room.gameOver?.reason ?? 'unknown');
}

/** An abandoned game: everyone left mid-play, so it is kept but scores nothing. */
function archiveUnfinished(room: Room): void {
  if (room.archived || room.status !== 'playing') return;
  room.archived = true;
  finishGame(room, 'unfinished', 'abandoned');
}

function finishGame(room: Room, result: GameResult, reason: string): void {
  const saved = saveGame({
    roomId: room.id,
    config: room.config,
    white: rosterOf(room, 'white'),
    black: rosterOf(room, 'black'),
    history: room.history,
    startFen: room.startFen,
    finalFen: room.chess.fen(),
    result,
    reason,
    metrics: gameMetricsFor(room, result),
  });
  if (!saved) return;

  if (!room.funnel.finished) { room.funnel.finished = true; noteFunnel('finished'); }
  // Folded here rather than inside the archive, so that writing a game and counting it
  // stay one step apart: a game that could not be written is not counted either.
  try { foldGame(saved.game); }
  catch (err) { console.warn('[insights] could not fold a game:', (err as Error).message); }

  creditPlayers(room, saved.summary, saved.game.metrics);
  io.to(room.id).emit('game:archived', saved.summary);
}

/**
 * Roll the per-ply record up, or return nothing when there is nothing to roll up.
 *
 * The check counts come from the history rather than from the metrics: a check lives in
 * the SAN, and copying the SAN into every metric row to save one argument would be the
 * worse trade.
 */
function gameMetricsFor(room: Room, result: GameResult): GameMetrics | undefined {
  if (room.plyMetrics.length === 0) return undefined;

  const checks = { white: 0, black: 0 };
  for (const h of room.history) if (/[+#]$/.test(h.san)) checks[h.color]++;

  // Time actually spent at the board, rather than wall clock: a room left open overnight
  // between two moves did not take nine hours to play.
  const durationMs = room.plyMetrics.reduce((a, p) => a + p.thinkMs, 0);

  const winner = result === 'white' || result === 'black' ? result
    : result === 'draw' ? 'draw' : null;
  return summariseGame(room.plyMetrics, durationMs, checks, winner, room.clientSessions);
}

/**
 * Put the game on the record of every signed-in player who held a seat in it.
 *
 * Bots have no record, and neither do guests -- there is nothing to record a guest
 * against. That is the whole reason accounts exist, and it is why the home screen says so
 * rather than silently keeping nothing.
 */
function creditPlayers(room: Room, summary: GameSummary,
                       metrics: GameMetrics | undefined): void {
  for (const color of ['white', 'black'] as Color[]) {
    for (const seat of teamFor(room, color).seats) {
      if (!seat.accountId) continue;
      try {
        // The side roll-up travels with the game onto the profile, because a trend over a
        // season cannot be rebuilt from a list of results -- and the archive is capped,
        // so it cannot be looked up later either.
        recordGame(seat.accountId, seat.name ?? 'Player', summary, color, metrics?.[color]);
      } catch (err) {
        console.warn('[profiles] could not record a game:', (err as Error).message);
      }
    }
  }
}

/**
 * Everything the admin panel shows, computed on demand from the archive index and the
 * stores rather than from a separate stream of counters.
 *
 * There is no analytics pipeline here and there does not need to be one: the archive
 * already holds every finished game, and a few hundred summaries add up faster than the
 * request that asked for them. If that ever stops being true, the shape of this function
 * is what a rolling aggregate would replace.
 */
function adminOverview(): AdminOverview {
  const games = listGames(1000);
  const byMode: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const setups = new Map<string, number>();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let plies = 0;
  let last7 = 0;
  for (const g of games) {
    byMode[g.mode] = (byMode[g.mode] ?? 0) + 1;
    byResult[g.result] = (byResult[g.result] ?? 0) + 1;
    byReason[g.reason] = (byReason[g.reason] ?? 0) + 1;
    plies += g.plies;
    if (g.finishedAt >= weekAgo) last7++;

    const c = g.config;
    const label = c
      ? `${c.mode === 'cards' ? 'Cards' : `Team ${c.teamSize}v${c.teamSize}`}`
        + ` · ${c.moveTimerSec ? `${c.moveTimerSec}s` : 'no clock'}`
        + `${c.mode === 'cards' ? '' : c.skipEmptySeats ? ' · skip empty' : ' · all seats'}`
        + `${c.allowTakeback ? '' : ' · no takebacks'}`
      : 'unknown';
    setups.set(label, (setups.get(label) ?? 0) + 1);
  }

  let live = 0;
  let playing = 0;
  for (const room of rooms.values()) {
    live++;
    if (room.status === 'playing') playing++;
  }

  return {
    games: {
      total: games.length,
      byMode, byResult, byReason,
      avgPlies: games.length > 0 ? Math.round(plies / games.length) : 0,
      last7,
    },
    setups: [...setups].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count).slice(0, 12),
    accounts: accountCount(),
    profiles: profileCount(),
    reportsOpen: openCount(),
    rooms: { live, playing },
    recent: games.slice(0, 25),
  };
}

/**
 * A room reaching a funnel step.
 *
 * Read off the room rather than hooked to the handlers that cause it, because there is
 * more than one way to reach each: a side is manned by a person sitting down or by the
 * host adding a bot, and a first move can be made by a player, a bot or the clock. The
 * flags make every step count once per room, so this can be asked on every broadcast.
 */
function noteProgress(room: Room): void {
  if (!room.funnel.seated && canStart(room)) {
    room.funnel.seated = true;
    noteFunnel('seated');
  }
  if (!room.funnel.firstMove && room.history.length > 0) {
    room.funnel.firstMove = true;
    noteFunnel('firstMove');
  }
}

/** A room starting a game, and a room starting another one. Each counted once. */
function noteStart(room: Room): void {
  if (!room.funnel.started) {
    room.funnel.started = true;
    noteFunnel('started');
    return;
  }
  if (!room.funnel.rematch) {
    room.funnel.rematch = true;
    noteFunnel('rematch');
  }
}

/**
 * Nobody is in this room. Keep it for a few minutes, then let it go.
 *
 * What was here counted *occupied* seats, and a bot occupies one -- so a room whose last
 * human left while a bot still sat at the board was never cleaned up. It stayed in memory
 * with the game it was in the middle of, and the player whose link pointed at it was
 * dropped straight back into a game nobody was playing. Bots do not keep a room alive.
 */
function reapLater(room: Room): void {
  if (room.reapTimer) return;
  room.reapTimer = setTimeout(() => {
    room.reapTimer = null;
    // Somebody came back while the clock ran; the room is theirs again.
    if (liveHumans(room) > 0) return;
    // Last one out: the room object is about to go, so anything worth keeping has to be
    // copied out now -- a game abandoned in progress is still reviewable.
    archiveIfFinished(room);
    archiveUnfinished(room);
    clearTimer(room);
    clearTakeback(room);
    clearDraw(room);
    rooms.delete(room.id);
    console.log(`[rooms] ${room.id} closed; ${rooms.size} left`);
  }, ROOM_GRACE_MS);
  room.reapTimer.unref?.();
}

function keepRoom(room: Room): void {
  if (!room.reapTimer) return;
  clearTimeout(room.reapTimer);
  room.reapTimer = null;
}

function broadcast(room: Room): void {
  archiveIfFinished(room);
  noteProgress(room);
  io.to(room.id).emit('room:state', serialize(room));
  void pushYou(room);
  void pushMarks(room);
  void pushHands(room);
}

/**
 * Tell each member who they currently are in this room.
 *
 * `You` used to be answered only where it was asked for -- joining, taking a seat -- so
 * anything that changed a seat from the outside left it stale. Leaving a seat has no
 * acknowledgement at all, so a player who stood up still believed they were sitting: when
 * the host then dropped a bot into the chair they had left, the roster drew the bot and
 * the "You" badge on the same row, which is exactly how somebody came to be a player and
 * a bot at once. It is broadcast state now, and it cannot drift.
 */
async function pushYou(room: Room): Promise<void> {
  await eachMember(room, (s, token) => {
    const name = room.spectators.get(token) ?? seatByToken(room, token)?.seat.name ?? '';
    s.emit('room:you', youFor(room, token, name));
  });
}

/**
 * Team-scoped delivery. Chat and marks must not reach the opposing team at all -- not
 * merely be hidden by the client -- so each socket is handed only what its own channel
 * may see, rather than everyone receiving everything and filtering.
 */
async function eachMember(
  room: Room,
  fn: (socket: { emit: (ev: string, payload: unknown) => void }, token: string) => void,
): Promise<void> {
  try {
    const socks = await io.in(room.id).fetchSockets();
    for (const s of socks) {
      const token = (s.data as SockData).token;
      if (token) fn(s, token);
    }
  } catch { /* the room emptied mid-flight */ }
}

async function pushMarks(room: Room): Promise<void> {
  await eachMember(room, (s, token) => s.emit('mark:state', marksFor(room, token)));
}

/**
 * Tell one or more accounts that their friend list has changed.
 *
 * Presence and friendship are both two-sided: accepting a request changes what two people
 * see, and coming online changes what everyone who has you on their list sees. Rather
 * than have clients poll, the list is pushed at whoever it just became wrong for.
 */
function pushFriends(...accountIds: string[]): void {
  for (const id of new Set(accountIds)) {
    const view = friendsView(id);
    for (const sid of socketsOf(id)) io.to(sid).emit('friends:state', view);
  }
}

/** Somebody signed in, moved room, or left: their friends' lists just went stale. */
function presenceChanged(accountId: string): void {
  pushFriends(accountId, ...friendIdsOf(accountId));
}

/**
 * Record this socket against its account, wherever it currently is.
 *
 * Called on every sign-in and on entering a room, because presence is two facts -- that
 * somebody is here, and which room they are in -- and the second changes far more often
 * than the first.
 */
function joinedPresence(socket: Socket): void {
  const data = socket.data as SockData;
  if (!data.account) return;
  nowOnline(data.account.id, socket.id, data.roomId ?? null);
  presenceChanged(data.account.id);
}

function goneFromPresence(socket: Socket): void {
  const data = socket.data as SockData;
  nowOffline(socket.id);
  if (data.account) presenceChanged(data.account.id);
}

/**
 * Hands go out one socket at a time, never in `room:state`.
 *
 * The whole mode rests on not knowing what the opponent holds, and a hand broadcast to
 * the room would be sitting in their network tab whatever the client chose to draw. A
 * spectator holds no seat and so is sent nothing at all.
 */
async function pushHands(room: Room): Promise<void> {
  if (!room.cards) return;
  const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
  await eachMember(room, (s, token) => {
    const found = seatByToken(room, token);
    if (!found) { s.emit('cards:hand', null); return; }
    const side = room.cards![found.color];
    const yourTurn = room.status === 'playing' && turn === found.color
      && !room.pendingTakeback;
    const plies = room.history.length;
    s.emit('cards:hand', {
      color: found.color,
      cards: handView(side, room.chess, yourTurn),
      emergency: yourTurn && side.emergency,
      mulliganAvailable: yourTurn && !side.mulliganUsed,
      yourTurn,
      replaced: yourTurn ? side.lastReplaced : [],
      cycled: yourTurn ? side.lastCycled : [],
      sacrificeCost: TUNING.sacrificeCost,
      sacrificeAvailable: yourTurn && canSacrifice(side, plies),
      sacrificeReadyIn: sacrificeReadyIn(side, plies),
      handCap: handCapOf(room, found.color),
      canCastle: canCastle(side),
    });
  });
}

/** Side effects the client needs to hear but cannot derive from state alone. */
interface MoveFx {
  captured: boolean; castle: boolean; promotion: boolean; check: boolean; auto: boolean;
  sacrifice: boolean;
}
function emitFx(room: Room, fx: MoveFx): void {
  io.to(room.id).emit('game:fx', fx);
}

// Hooks are defined once and shared, so every path that starts a turn -- a human move,
// a bot move, a timeout, an accepted takeback -- re-arms the clock identically.
const hooks: TurnHooks = {
  onTimeout(room) {
    if (room.status !== 'playing' || room.pendingTakeback) return;
    const res = playForcedMove(room, 'random');
    if (res?.ok) {
      emitFx(room, {
        captured: res.captured, castle: res.castle, promotion: res.promotion,
        check: res.check, auto: true, sacrifice: res.sacrifice,
      });
    }
    if (room.status === 'playing') armTurn(room, hooks); else clearTimer(room);
    broadcast(room);
  },
  onBotMove(room) {
    if (room.status !== 'playing' || room.pendingTakeback) return;
    const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
    const seat = activeSeat(room, teamFor(room, turn));
    if (seat?.kind !== 'bot') return;
    const res = playForcedMove(room, 'greedy');
    if (res?.ok) {
      emitFx(room, {
        captured: res.captured, castle: res.castle, promotion: res.promotion,
        check: res.check, auto: false, sacrifice: res.sacrifice,
      });
    }
    if (room.status === 'playing') armTurn(room, hooks); else clearTimer(room);
    broadcast(room);
  },
};

function youFor(room: Room, token: string, name: string): You {
  const found = seatByToken(room, token);
  return {
    token,
    name,
    isHost: room.hostToken === token,
    seat: found ? { color: found.color, seatId: found.seat.id } : null,
  };
}

/** Both teams need someone who can actually move before a game can start. */
function canStart(room: Room): boolean {
  return occupiedCount(room.white) >= 1 && occupiedCount(room.black) >= 1;
}

// Reports write a file each, so they get the same treatment chat does: a small burst,
// then a slow refill.
const REPORT_BURST = 5;
const REPORT_REFILL_MS = 20_000;

interface SockData {
  roomId?: string; token?: string; name?: string;
  reportTokens?: number; reportAt?: number;
  /** The signed-in account on this socket, if any. Guests leave it undefined. */
  account?: Account;
  chatTokens?: number; chatAt?: number;
  /** The browser on the other end of this socket, as it described itself. Advisory. */
  client?: ClientInfo;
  telTokens?: number; telAt?: number;
  /** Failed sign-in attempts on this socket, for the rate limit below. */
  authTries?: number; authAt?: number;
}

// Sign-in is the one place a client can make this server do expensive work (a scrypt
// hash) with an unauthenticated request, so it gets the same treatment chat does: a small
// burst, then one attempt every few seconds. It is per socket, which is not a serious
// defence against a determined attacker with many sockets -- it is there to make casual
// password guessing pointless.
const AUTH_BURST = 8;
const AUTH_REFILL_MS = 4_000;

io.on('connection', (socket: Socket) => {
  const data = socket.data as SockData;
  const roomOf = (): Room | undefined => (data.roomId ? rooms.get(data.roomId) : undefined);
  const isHost = (room: Room): boolean => !!data.token && data.token === room.hostToken;

  socket.on('room:create', (payload: CreatePayload, cb?: (roomId: string) => void) => {
    const room = createRoom(sanitizeConfig(payload?.config));
    noteFunnel('created');
    cb?.(room.id);
  });

  socket.on('room:join', (payload: JoinPayload, cb?: (res: JoinResult) => void) => {
    const room = rooms.get(payload?.roomId ?? '');
    if (!room) { cb?.({ ok: false, error: 'Room not found' }); return; }

    const token = payload.token || randomUUID();
    // A signed-in player is named by their account, not by whatever the client sent: the
    // name on a game's record has to be the one the account is known by, or the archive
    // would carry a name nobody can be looked up under.
    const account = accountFromSession(payload.session) ?? data.account ?? null;
    data.account = account ?? undefined;
    const name = account ? account.username : (payload.name || 'Player').slice(0, 24);

    data.roomId = room.id;
    data.token = token;
    data.name = name;
    socket.join(room.id);
    // Somebody is here again, so the room is not going anywhere.
    keepRoom(room);
    // Presence carries the room as well as the person: a friend list shows where a friend
    // is, and that is what makes "join them" possible.
    joinedPresence(socket);

    if (!room.hostToken) room.hostToken = token;

    // A join is the only moment this server reliably learns a signed-in player's current
    // name, so it is where the profile is created or brought up to date. Guests have no
    // profile to touch.
    if (account) {
      try { touchProfile(account.id, account.username); }
      catch { /* a profile is never worth a failed join */ }
    }

    // reconnect: reclaim a seat this token already holds
    const existing = seatByToken(room, token);
    if (existing) {
      existing.seat.connected = true;
      existing.seat.name = name;
      existing.seat.accountId = account?.id ?? null;
      room.spectators.delete(token);
    } else {
      room.spectators.set(token, name);
    }

    cb?.({ ok: true, you: youFor(room, token, name), state: serialize(room) });
    socket.emit('chat:history', chatFor(room, channelFor(room, token)));
    broadcast(room);
  });

  socket.on('seat:take', (payload: SeatTakePayload, cb?: (res: JoinResult) => void) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token) { cb?.({ ok: false, error: 'Not in a room' }); return; }
    if (room.status === 'finished') { cb?.({ ok: false, error: 'Game is over' }); return; }

    const team = teamFor(room, payload.color);

    // No seat named means "wherever there is room", which is what the Join button asks.
    const wanted = payload.seatId != null && payload.seatId >= 0
      ? team.seats[payload.seatId]
      : firstFreeSeat(team);
    const seat = wanted;
    if (!seat) { cb?.({ ok: false, error: 'That side is full' }); return; }

    // A bot holds no token, so the check below could not see one: a player could sit
    // straight on top of a bot and silently evict it, which is how the same slot ended up
    // being both sat in and botted. A seat is one thing at a time -- the host takes the
    // bot out first.
    if (seat.kind === 'bot') {
      cb?.({ ok: false, error: 'A bot has that seat — the host can remove it' }); return;
    }
    if (seat.token != null && seat.token !== token) {
      cb?.({ ok: false, error: 'Seat is taken' }); return;
    }

    // vacate whatever seat this token currently holds
    const prev = seatByToken(room, token);
    if (prev) {
      prev.seat.token = null; prev.seat.name = null; prev.seat.connected = false;
      prev.seat.accountId = null;
    }

    seat.token = token;
    seat.name = data.account?.username ?? data.name ?? 'Player';
    seat.accountId = data.account?.id ?? null;
    seat.kind = 'human';
    seat.connected = true;
    room.spectators.delete(token);

    clearMarksFor(room, token);
    cb?.({ ok: true, you: youFor(room, token, data.name ?? 'Player'), state: serialize(room) });
    socket.emit('chat:history', chatFor(room, channelFor(room, token)));
    io.to(room.id).emit('game:seat-join');
    broadcast(room);
  });

  socket.on('seat:leave', () => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token) return;
    const found = seatByToken(room, token);
    if (!found) return;
    found.seat.token = null;
    found.seat.name = null;
    found.seat.accountId = null;
    found.seat.connected = false;
    room.spectators.set(token, data.name ?? 'Player');
    clearMarksFor(room, token);
    socket.emit('chat:history', chatFor(room, 'spectator'));
    broadcast(room);
  });

  // Host may convert any seat between human and bot. Turning a seat into a bot evicts
  // whoever sat there; if it is that seat's turn right now, the bot must be scheduled
  // immediately or the rotation would stall until the clock ran out.
  socket.on('seat:bot', (payload: SeatBotPayload) => {
    const room = roomOf();
    if (!room || !isHost(room)) return;
    const team = teamFor(room, payload.color);

    // Adding: the first free seat, unless one is named. Removing: the named seat.
    const seat = payload.bot && (payload.seatId == null || payload.seatId < 0)
      ? firstFreeSeat(team)
      : team.seats[payload.seatId ?? -1];
    if (!seat) return;

    if (payload.bot) {
      // A bot never takes a seat a person is sitting in. Turning an occupied seat into a
      // bot evicted whoever was there -- which, next to a Sit button on the same row, is
      // how one slot could be both joined and botted.
      if (seat.token != null) return;
      seat.token = null;
      seat.accountId = null;
      seat.kind = 'bot';
      seat.name = `Bot ${seat.id + 1}`;
      seat.connected = true;
    } else {
      if (seat.kind !== 'bot') return;      // only a bot can be taken out
      seat.kind = 'human';
      seat.name = null;
      seat.accountId = null;
      seat.connected = false;
    }

    if (room.status === 'playing') armTurn(room, hooks);
    broadcast(room);
  });

  socket.on('game:start', () => {
    const room = roomOf();
    if (!room || !isHost(room) || room.status === 'playing' || !canStart(room)) return;
    noteStart(room);
    resetGame(room, 'playing');
    armTurn(room, hooks);
    io.to(room.id).emit('game:start');
    broadcast(room);
  });

  socket.on('game:rematch', () => {
    const room = roomOf();
    if (!room || !isHost(room) || !canStart(room)) return;
    noteStart(room);
    resetGame(room, 'playing');
    armTurn(room, hooks);
    io.to(room.id).emit('game:start');
    broadcast(room);
  });

  socket.on('game:reset', () => {
    const room = roomOf();
    if (!room || !isHost(room)) return;
    resetGame(room, 'lobby');
    broadcast(room);
  });

  socket.on('game:move', (payload: MovePayload, cb?: (ok: boolean) => void) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || room.status !== 'playing') { cb?.(false); return; }
    if (room.pendingTakeback) { cb?.(false); return; }

    const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
    const active = activeSeat(room, teamFor(room, turn));
    if (!active || active.token !== token) { cb?.(false); return; } // not this player's turn

    const res = applyMove(room, payload);
    if (!res.ok) { cb?.(false); return; }

    emitFx(room, {
      captured: res.captured, castle: res.castle, promotion: res.promotion,
      check: res.check, auto: false, sacrifice: res.sacrifice,
    });

    if (room.status === 'playing') armTurn(room, hooks); else clearTimer(room);
    cb?.(true);
    broadcast(room);
  });

  // ---- accounts ----

  /** True while this socket may still attempt a sign-in; refilled by elapsed time. */
  const authAllowed = (): boolean => {
    const now = Date.now();
    const refilled = Math.floor((now - (data.authAt ?? 0)) / AUTH_REFILL_MS);
    data.authTries = Math.min(AUTH_BURST, (data.authTries ?? AUTH_BURST) + refilled);
    data.authAt = now;
    if ((data.authTries ?? 0) <= 0) return false;
    data.authTries!--;
    return true;
  };

  socket.on('auth:register', async (payload: AuthPayload | undefined,
                                    cb?: (res: AuthResult) => void) => {
    if (!authAllowed()) { cb?.({ ok: false, error: 'Too many attempts. Wait a moment.' }); return; }
    const res = await register(payload?.username, payload?.password);
    if (res.ok && res.account) {
      data.account = res.account;
      // A brand-new account gets its profile straight away, so the panel has somewhere to
      // appear rather than waiting for the first finished game.
      try { touchProfile(res.account.id, res.account.username); } catch { /* not fatal */ }
      joinedPresence(socket);
    }
    cb?.(res);
  });

  socket.on('auth:login', async (payload: AuthPayload | undefined,
                                 cb?: (res: AuthResult) => void) => {
    if (!authAllowed()) { cb?.({ ok: false, error: 'Too many attempts. Wait a moment.' }); return; }
    const res = await login(payload?.username, payload?.password);
    if (res.ok && res.account) {
      data.account = res.account;
      joinedPresence(socket);
    }
    cb?.(res);
  });

  /** Resume a stored session, and hand back the profile in the same round trip. */
  socket.on('auth:resume', (payload: SessionPayload | undefined,
                            cb?: (res: { account: Account | null;
                                         profile: ProfileView | null }) => void) => {
    const account = accountFromSession(payload?.session);
    data.account = account ?? undefined;
    if (account) joinedPresence(socket);
    cb?.({
      account,
      profile: account ? profileView(account.id, 25) : null,
    });
  });

  socket.on('auth:logout', () => {
    // Signing out takes this socket off the board as far as friends are concerned, even
    // though the socket itself stays open.
    goneFromPresence(socket);
    data.account = undefined;
  });

  /**
   * The signed-in player's own profile and game list.
   *
   * Answered from the socket's account rather than from anything the caller sends, so
   * there is no id to guess and a guest simply gets nothing.
   */
  socket.on('profile:me', (payload: { limit?: number } | undefined,
                           cb?: (res: ProfileView | null) => void) => {
    if (!data.account) { cb?.(null); return; }
    const limit = Number(payload?.limit);
    cb?.(profileView(data.account.id, Number.isFinite(limit) ? limit : 25));
  });

  // ---- bug reports, filed from inside the app ----

  /**
   * One report. Rate limited on the same bucket chat uses, because it is the same risk:
   * a client that can write to disk as fast as it can emit.
   */
  socket.on('report:send', (payload: ReportPayload | undefined,
                            cb?: (res: { ok: boolean; error?: string }) => void) => {
    const now = Date.now();
    const refilled = Math.floor((now - (data.reportAt ?? 0)) / REPORT_REFILL_MS);
    data.reportTokens = Math.min(REPORT_BURST, (data.reportTokens ?? REPORT_BURST) + refilled);
    data.reportAt = now;
    if ((data.reportTokens ?? 0) <= 0) {
      cb?.({ ok: false, error: 'Too many reports just now. Try again in a minute.' });
      return;
    }
    data.reportTokens!--;

    const report = fileReport({
      text: payload?.text,
      context: payload?.context,
      attachments: payload?.attachments,
      accountId: data.account?.id ?? null,
      reporter: data.account?.username ?? data.name ?? 'Guest',
    });
    if (!report) {
      cb?.({ ok: false, error: `Say a little about what went wrong (up to ${MAX_REPORT_CHARS} characters).` });
      return;
    }
    console.log(`[reports] ${report.id} from ${report.reporter}`
      + `${report.attachments?.length ? ` (+${report.attachments.length} image)` : ''}`);
    cb?.({ ok: true });
  });

  // ---- admin ----

  /**
   * Admin is re-derived from the socket's account on every call, never trusted from the
   * client and never cached on the socket. A panel that asks nicely gets nothing.
   */
  const asAdmin = (): Account | null =>
    data.account?.isAdmin ? data.account : null;

  socket.on('admin:overview', (_payload: unknown,
                               cb?: (res: AdminOverview | null) => void) => {
    cb?.(asAdmin() ? adminOverview() : null);
  });

  socket.on('admin:insights', (_payload: unknown,
                              cb?: (res: Insights | null) => void) => {
    cb?.(asAdmin() ? insightsView() : null);
  });

  /**
   * Recompute from the archive.
   *
   * The aggregate is a cache, so there is always a way back to the games themselves --
   * which is what makes it safe to change how something is counted and then ask for the
   * old games to be counted the new way.
   */
  socket.on('admin:insights-rebuild', (_payload: unknown,
                                       cb?: (res: Insights | null) => void) => {
    if (!asAdmin()) { cb?.(null); return; }
    rebuildInsights();
    cb?.(insightsView());
  });

  socket.on('admin:reports', (payload: { limit?: number } | undefined,
                              cb?: (res: BugReport[] | null) => void) => {
    if (!asAdmin()) { cb?.(null); return; }
    const limit = Number(payload?.limit);
    cb?.(listReports(Number.isFinite(limit) ? limit : 100));
  });

  /**
   * One screenshot, as base64, for an admin.
   *
   * Served over the socket rather than as a URL on purpose: a screenshot is somebody's
   * screen, and an HTTP route would need the session in a query string -- which is the
   * one place a credential ends up in logs and referrers. The socket already knows who is
   * asking.
   */
  socket.on('admin:attachment',
    (payload: { reportId?: string; attachmentId?: string } | undefined,
     cb?: (res: { mime: string; base64: string } | null) => void) => {
      if (!asAdmin() || !payload?.reportId || !payload?.attachmentId) { cb?.(null); return; }
      cb?.(readAttachment(payload.reportId, payload.attachmentId));
    });

  socket.on('admin:report-resolve',
    (payload: { id?: string; resolved?: boolean } | undefined,
     cb?: (res: BugReport | null) => void) => {
      if (!asAdmin() || typeof payload?.id !== 'string') { cb?.(null); return; }
      cb?.(setResolved(payload.id, payload.resolved !== false));
    });

  // ---- team coordination: chat and marks, both team-scoped ----

  // ---- telemetry ----

  /**
   * What the browser saw.
   *
   * Best-effort in both directions: no acknowledgement goes back, and a packet that is
   * malformed, late, out of budget or about somebody else's ply is dropped in silence. A
   * dropped telemetry packet must never affect a game, and a client that gets this wrong
   * must never be able to tell that it did.
   *
   * Every number is clamped rather than trusted. These come from the one place in the
   * system that is not ours, and they end up in an aggregate that is read as evidence.
   */
  const telemetryBudget = (): boolean => {
    const now = Date.now();
    const since = now - (data.telAt ?? 0);
    data.telTokens = Math.min(TELEMETRY_BURST,
      (data.telTokens ?? TELEMETRY_BURST) + since / TELEMETRY_REFILL_MS);
    data.telAt = now;
    if (data.telTokens < 1) return false;
    data.telTokens -= 1;
    return true;
  };

  const clamp = (n: unknown, max: number): number => {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0;
  };

  socket.on('telemetry:client', (payload: ClientInfo | undefined) => {
    if (!payload || !telemetryBudget()) return;
    const device = payload.device;
    const pointer = payload.pointer;
    const fx = payload.fx;
    data.client = {
      device: device === 'phone' || device === 'tablet' ? device : 'desktop',
      pointer: pointer === 'touch' || pointer === 'pen' ? pointer : 'mouse',
      viewport: String(payload.viewport ?? '').slice(0, 16),
      fx: fx === 'calm' || fx === 'off' ? fx : 'full',
    };
  });

  /**
   * One turn, reported by the player who took it.
   *
   * Matched to the ply it claims rather than to the last one recorded: a packet that
   * arrives after the next move has been played still belongs to its own turn, and one
   * that names a ply this seat did not play belongs nowhere.
   */
  socket.on('telemetry:turn', (payload: TelemetryTurnPayload | undefined) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || !payload || !telemetryBudget()) return;
    if (payload.gameSeq !== room.gameSeq) return;

    const seat = seatByToken(room, token);
    if (!seat) return;

    const row = room.plyMetrics.find(
      p => p.ply === payload.ply && p.color === seat.color && p.seatId === seat.seat.id);
    if (!row || row.client) return;      // unknown ply, or already reported once

    const premove = payload.premove;
    row.client = {
      pickups: clamp(payload.pickups, 99),
      cardSelections: clamp(payload.cardSelections, 99),
      timeToFirstTouchMs: payload.timeToFirstTouchMs == null ? null
        : clamp(payload.timeToFirstTouchMs, 10 * 60_000),
      premove: premove === 'played' || premove === 'rejected' ? premove : 'none',
    };

    const session = room.clientSessions[seat.color];
    if (data.client) {
      session.devices[data.client.device] = (session.devices[data.client.device] ?? 0) + 1;
      session.pointers[data.client.pointer] =
        (session.pointers[data.client.pointer] ?? 0) + 1;
      session.fx[data.client.fx] = (session.fx[data.client.fx] ?? 0) + 1;
    }
  });

  /**
   * Something that is not a turn: the review opened, the phone drawer pulled out.
   *
   * Counted per side rather than per ply, because neither belongs to one -- a player who
   * steps back through the game is not doing it on any particular move.
   */
  socket.on('telemetry:event', (payload: { kind?: string } | undefined) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || !payload || !telemetryBudget()) return;
    const seat = seatByToken(room, token);
    if (!seat) return;
    const session = room.clientSessions[seat.color];
    if (payload.kind === 'review') session.reviewOpened++;
    else if (payload.kind === 'drawer') session.drawerOpened++;
  });

  // ---- friends ----

  /**
   * Every friend call needs an account, because a friend list belongs to one and a guest
   * has none. The account is re-read from the socket each time rather than captured, for
   * the same reason the admin check is: a socket can sign in and out.
   */
  const asAccount = (): Account | null => data.account ?? null;

  socket.on('friends:list', (_payload: unknown,
                             cb?: (res: FriendsView | null) => void) => {
    const me = asAccount();
    cb?.(me ? friendsView(me.id) : null);
  });

  socket.on('friends:add', (payload: { username?: string } | undefined,
                            cb?: (res: FriendResult) => void) => {
    const me = asAccount();
    if (!me) { cb?.({ ok: false, error: 'Sign in to keep a friend list' }); return; }
    const username = String(payload?.username ?? '').trim().slice(0, 24);
    if (!username) { cb?.({ ok: false, error: 'Who?' }); return; }

    const res = requestFriend(me.id, username);
    cb?.(res);
    // Both people's lists just changed, so both are told; the other one may be looking
    // at their own list while this happens.
    if (res.ok && res.otherId) pushFriends(me.id, res.otherId);
  });

  socket.on('friends:accept', (payload: { id?: string } | undefined,
                               cb?: (res: FriendResult) => void) => {
    const me = asAccount();
    if (!me) { cb?.({ ok: false, error: 'Sign in first' }); return; }
    const res = accept(me.id, String(payload?.id ?? ''));
    cb?.(res);
    if (res.ok && res.otherId) pushFriends(me.id, res.otherId);
  });

  socket.on('friends:remove', (payload: { id?: string } | undefined,
                               cb?: (res: FriendResult) => void) => {
    const me = asAccount();
    if (!me) { cb?.({ ok: false, error: 'Sign in first' }); return; }
    const res = unfriend(me.id, String(payload?.id ?? ''));
    cb?.(res);
    if (res.ok && res.otherId) pushFriends(me.id, res.otherId);
  });

  /**
   * Put an invitation on a friend's screen.
   *
   * Only to a friend, and only to a room the sender is actually in: an invitation is a
   * message from someone you have agreed to hear from, about a room they are standing in.
   * Both halves matter -- without the first it is a way to message strangers, and without
   * the second it is a way to send people anywhere.
   */
  socket.on('friends:invite', (payload: { id?: string } | undefined,
                               cb?: (res: { ok: boolean; error?: string }) => void) => {
    const me = asAccount();
    const room = roomOf();
    if (!me) { cb?.({ ok: false, error: 'Sign in first' }); return; }
    if (!room) { cb?.({ ok: false, error: 'You are not in a room' }); return; }

    const id = String(payload?.id ?? '');
    if (!areFriends(me.id, id)) { cb?.({ ok: false, error: 'Not on your friend list' }); return; }

    const invite: FriendInvite = {
      fromId: me.id, fromName: me.username, roomId: room.id,
      mode: room.config.mode, at: Date.now(),
    };
    const targets = socketsOf(id);
    for (const sid of targets) io.to(sid).emit('friends:invited', invite);
    cb?.(targets.length > 0
      ? { ok: true }
      : { ok: false, error: 'They are not online at the moment' });
  });

  socket.on('chat:send', (payload: ChatSendPayload) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token) return;

    // token bucket, refilled by elapsed time rather than a timer
    const now = Date.now();
    const refilled = Math.floor((now - (data.chatAt ?? 0)) / CHAT_REFILL_MS);
    data.chatTokens = Math.min(CHAT_BURST, (data.chatTokens ?? CHAT_BURST) + refilled);
    data.chatAt = now;
    if (data.chatTokens <= 0) return;
    data.chatTokens--;

    const text = cleanChatText(payload?.text);
    if (!text) return;

    const channel = channelFor(room, token);
    const msg = pushChat(room, channel, data.name ?? 'Player', text);
    void eachMember(room, (s, t) => {
      if (channelFor(room, t) === channel) s.emit('chat:new', msg);
    });
  });

  // A mark is a suggestion to teammates: "look at this square". It lives for one ply.
  socket.on('mark:toggle', (payload: MarkTogglePayload) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token) return;
    if (toggleMark(room, token, payload?.square, payload?.to)) void pushMarks(room);
  });

  socket.on('mark:clear', () => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token) return;
    clearMarksFor(room, token);
    void pushMarks(room);
  });

  // ---- takeback: the team that just moved asks, the team on move decides ----

  /**
   * Throw the hand away and take a fresh one, once per game. The move still has to be
   * made afterwards, so this buys a different hand rather than a free turn.
   */
  socket.on('cards:mulligan', () => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || !room.cards || room.pendingTakeback) return;
    const found = seatByToken(room, token);
    if (!found) return;
    if (!useMulligan(room, found.color)) return;
    io.to(room.id).emit('cards:mulliganed', { color: found.color });
    broadcast(room);
  });

  // ---- ending a game early: resign, or agree a draw ----

  /**
   * One player resigns for their whole team. Nobody else has to agree: a team that has
   * to poll itself before it can concede would sit in a lost position while a teammate
   * who has walked away never answers.
   */
  socket.on('game:resign', () => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || room.status !== 'playing') return;
    const found = seatByToken(room, token);
    if (!found) return;   // spectators have nothing to give up

    clearTimer(room);
    clearTakeback(room);
    clearDraw(room);
    room.status = 'finished';
    room.gameOver = {
      reason: 'resignation',
      winner: found.color === 'white' ? 'black' : 'white',
    };
    io.to(room.id).emit('game:ended', {
      kind: 'resign', byColor: found.color, byName: found.seat.name ?? 'Player',
    });
    broadcast(room);
  });

  /**
   * A draw offer, answered by the opposing team's active seat -- the same rule the
   * takeback uses, so exactly one player on the other side is ever on the hook for it.
   * Unlike a takeback it does not touch the clock: an offer that banked the mover's
   * remaining time would be a free way to stop thinking.
   */
  socket.on('draw:offer', () => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || room.status !== 'playing') return;
    if (room.pendingDraw || room.pendingTakeback) return;

    const asker = seatByToken(room, token);
    if (!asker) return;

    room.pendingDraw = {
      byColor: asker.color,
      byName: asker.seat.name ?? 'Player',
      deadline: Date.now() + DRAW_WINDOW_MS,
      remainingMs: DRAW_WINDOW_MS,
    };
    room.drawTimer = setTimeout(() => resolveDraw(room, false), DRAW_WINDOW_MS);
    broadcast(room);
  });

  socket.on('draw:respond', (payload: DrawRespondPayload) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || !room.pendingDraw) return;

    const answerer = seatByToken(room, token);
    if (!answerer || answerer.color === room.pendingDraw.byColor) return;
    const active = activeSeat(room, teamFor(room, answerer.color));
    if (!active || active.token !== token) return;

    resolveDraw(room, payload?.accept === true);
  });

  socket.on('takeback:request', () => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || room.status !== 'playing') return;
    if (!room.config.allowTakeback || room.pendingTakeback) return;
    if (room.history.length === 0) return;
    clearDraw(room);   // one question at a time

    // only the team that played the last ply may ask, and only via a seated player
    const lastEntry = room.history[room.history.length - 1];
    const asker = seatByToken(room, token);
    if (!asker || asker.color !== lastEntry.color) return;

    // bank the clock remainder so a decline resumes rather than refreshes the turn
    room.bankedMs = room.turnDeadline != null
      ? Math.max(1000, room.turnDeadline - Date.now())
      : null;
    clearTimer(room);

    room.pendingTakeback = {
      byColor: asker.color,
      byName: asker.seat.name ?? 'Player',
      deadline: Date.now() + TAKEBACK_WINDOW_MS,
      remainingMs: TAKEBACK_WINDOW_MS,
    };
    room.takebackTimer = setTimeout(() => resolveTakeback(room, false), TAKEBACK_WINDOW_MS);
    broadcast(room);
  });

  socket.on('takeback:respond', (payload: TakebackRespondPayload) => {
    const room = roomOf();
    const token = data.token;
    if (!room || !token || !room.pendingTakeback) return;

    // only the active player of the opposing team may answer
    const turn: Color = room.chess.turn() === 'w' ? 'white' : 'black';
    if (turn === room.pendingTakeback.byColor) return;
    const active = activeSeat(room, teamFor(room, turn));
    if (!active || active.token !== token) return;

    resolveTakeback(room, payload?.accept === true);
  });

  socket.on('disconnect', () => {
    const room = roomOf();
    const token = data.token;
    goneFromPresence(socket);
    if (!room || !token) return;
    const found = seatByToken(room, token);
    if (found) found.seat.connected = false;
    else room.spectators.delete(token);
    clearMarksFor(room, token);

    if (liveHumans(room) === 0) reapLater(room);
    else broadcast(room);
  });
});

/**
 * Settle a pending takeback. Accepting rewinds one ply and starts a fresh clock for the
 * restored position; declining resumes the banked remainder so the asker cannot buy time
 * by requesting a takeback they expect to be refused.
 */
/**
 * Settle a draw offer. Accepting ends the game by agreement; a decline (or the window
 * lapsing) simply drops the offer and leaves the clock exactly where it was.
 */
function resolveDraw(room: Room, accept: boolean): void {
  if (!room.pendingDraw) return;
  clearDraw(room);

  if (accept) {
    clearTimer(room);
    clearTakeback(room);
    room.status = 'finished';
    room.gameOver = { reason: 'agreement', winner: 'draw' };
    io.to(room.id).emit('game:ended', { kind: 'draw-agreed' });
  } else {
    io.to(room.id).emit('draw:resolved', { accepted: false });
  }
  broadcast(room);
}

function resolveTakeback(room: Room, accept: boolean): void {
  if (!room.pendingTakeback) return;
  const banked = room.bankedMs;
  clearTakeback(room);
  room.bankedMs = null;

  if (accept) {
    undoPly(room);
    io.to(room.id).emit('takeback:resolved', { accepted: true });
    armTurn(room, hooks);
  } else {
    io.to(room.id).emit('takeback:resolved', { accepted: false });
    armTurn(room, hooks, banked ?? undefined);
  }
  broadcast(room);
}

// ---------- the archive over HTTP ----------
//
// Read-only and unauthenticated, which is what a finished game is: the position, the
// moves and the names were already on both players' screens. Nothing here reads a hand,
// a token or a live room.

app.get('/api/games', (req, res) => {
  const limit = Number(req.query.limit);
  res.json(listGames(Number.isFinite(limit) ? limit : 40));
});

app.get('/api/games/:id', (req, res) => {
  const game = loadGame(req.params.id);
  if (!game) { res.status(404).json({ error: 'No such game' }); return; }
  res.json(game);
});

/** The same game as PGN, so it can be opened in anything that reads chess. */
app.get('/api/games/:id/pgn', (req, res) => {
  const game = loadGame(req.params.id);
  if (!game) { res.status(404).type('text/plain').send('No such game'); return; }
  res.type('text/plain').send(toPgn(game));
});

/**
 * Whether a room is still there, and how many people are in it.
 *
 * The room code is an invitation people paste to each other, so nothing here is secret --
 * and a room that has been closed should say so to anything that asks, not only to a
 * client that tries to walk into it.
 */
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  res.json({
    exists: room != null,
    status: room?.status ?? null,
    people: room ? liveHumans(room) : 0,
    seated: room ? seatedHumans(room) : 0,
  });
});

app.get('/api/profile/:id', (req, res) => {
  const limit = Number(req.query.limit);
  const view = profileView(req.params.id, Number.isFinite(limit) ? limit : 25);
  if (!view) { res.status(404).json({ error: 'No such profile' }); return; }
  res.json(view);
});

// ---------- static client (production) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res.send('Bolotnoye Logovo server running. Start the Vite client on :5173 in dev.'));
}

initArchive();
initInsights();
initProfiles();
initFriends();
initAccounts();
initReports();

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`Bolotnoye Logovo server listening on :${PORT}`);
});
