import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { Server, Socket } from 'socket.io';
import {
  rooms, createRoom, sanitizeConfig, teamFor, activeSeat, seatByToken,
  occupiedCount, applyMove, undoPly, clearTimer, clearTakeback, armTurn,
  playForcedMove, serialize, resetGame, channelFor, chatFor, cleanChatText,
  pushChat, toggleMark, clearMarksFor, marksFor, clearDraw, useMulligan,
  type Room, type TurnHooks,
} from './room.js';
import { handView, drawTargetFor } from './cards.js';
import type {
  Color, CreatePayload, JoinPayload, SeatTakePayload, SeatBotPayload,
  MovePayload, TakebackRespondPayload, DrawRespondPayload, JoinResult, You,
  ChatSendPayload, MarkTogglePayload,
} from './types.js';

const TAKEBACK_WINDOW_MS = 20_000;
const DRAW_WINDOW_MS = 20_000;

// Chat is the one place a client can push arbitrary text at everyone else, so it gets a
// token bucket: a burst of six is fine, sustained is one every two seconds.
const CHAT_BURST = 6;
const CHAT_REFILL_MS = 2_000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

function broadcast(room: Room): void {
  io.to(room.id).emit('room:state', serialize(room));
  void pushMarks(room);
  void pushHands(room);
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
    s.emit('cards:hand', {
      color: found.color,
      cards: handView(side, room.chess, yourTurn),
      emergency: yourTurn && side.emergency,
      mulliganAvailable: yourTurn && !side.mulliganUsed,
      yourTurn,
    });
  });
}

/** Side effects the client needs to hear but cannot derive from state alone. */
interface MoveFx {
  captured: boolean; castle: boolean; promotion: boolean; check: boolean; auto: boolean;
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
        check: res.check, auto: true,
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
        check: res.check, auto: false,
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

interface SockData {
  roomId?: string; token?: string; name?: string;
  chatTokens?: number; chatAt?: number;
}

io.on('connection', (socket: Socket) => {
  const data = socket.data as SockData;
  const roomOf = (): Room | undefined => (data.roomId ? rooms.get(data.roomId) : undefined);
  const isHost = (room: Room): boolean => !!data.token && data.token === room.hostToken;

  socket.on('room:create', (payload: CreatePayload, cb?: (roomId: string) => void) => {
    const room = createRoom(sanitizeConfig(payload?.config));
    cb?.(room.id);
  });

  socket.on('room:join', (payload: JoinPayload, cb?: (res: JoinResult) => void) => {
    const room = rooms.get(payload?.roomId ?? '');
    if (!room) { cb?.({ ok: false, error: 'Room not found' }); return; }

    const token = payload.token || randomUUID();
    const name = (payload.name || 'Player').slice(0, 24);

    data.roomId = room.id;
    data.token = token;
    data.name = name;
    socket.join(room.id);

    if (!room.hostToken) room.hostToken = token;

    // reconnect: reclaim a seat this token already holds
    const existing = seatByToken(room, token);
    if (existing) {
      existing.seat.connected = true;
      existing.seat.name = name;
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
    const seat = team.seats[payload.seatId];
    if (!seat) { cb?.({ ok: false, error: 'No such seat' }); return; }
    if (seat.token != null && seat.token !== token) {
      cb?.({ ok: false, error: 'Seat is taken' }); return;
    }

    // vacate whatever seat this token currently holds
    const prev = seatByToken(room, token);
    if (prev) {
      prev.seat.token = null; prev.seat.name = null; prev.seat.connected = false;
    }

    seat.token = token;
    seat.name = data.name ?? 'Player';
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
    const seat = team.seats[payload.seatId];
    if (!seat) return;

    if (payload.bot) {
      if (seat.token) {
        room.spectators.set(seat.token, seat.name ?? 'Player');
        clearMarksFor(room, seat.token);
      }
      seat.token = null;
      seat.kind = 'bot';
      seat.name = `Bot ${payload.seatId + 1}`;
      seat.connected = true;
    } else {
      seat.kind = 'human';
      seat.name = null;
      seat.connected = false;
    }

    if (room.status === 'playing') armTurn(room, hooks);
    broadcast(room);
  });

  socket.on('game:start', () => {
    const room = roomOf();
    if (!room || !isHost(room) || room.status === 'playing' || !canStart(room)) return;
    resetGame(room, 'playing');
    armTurn(room, hooks);
    io.to(room.id).emit('game:start');
    broadcast(room);
  });

  socket.on('game:rematch', () => {
    const room = roomOf();
    if (!room || !isHost(room) || !canStart(room)) return;
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
      check: res.check, auto: false,
    });

    if (room.status === 'playing') armTurn(room, hooks); else clearTimer(room);
    cb?.(true);
    broadcast(room);
  });

  // ---- team coordination: chat and marks, both team-scoped ----

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
    if (toggleMark(room, token, payload?.square)) void pushMarks(room);
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
    if (!room || !token) return;
    const found = seatByToken(room, token);
    if (found) found.seat.connected = false;
    else room.spectators.delete(token);
    clearMarksFor(room, token);

    // drop rooms nobody is left in
    if (room.spectators.size === 0 &&
        occupiedCount(room.white) === 0 && occupiedCount(room.black) === 0) {
      clearTimer(room);
      clearTakeback(room);
      clearDraw(room);
      rooms.delete(room.id);
    } else {
      broadcast(room);
    }
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

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`Bolotnoye Logovo server listening on :${PORT}`);
});
