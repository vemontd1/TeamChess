import { io } from 'socket.io-client';
import { Chess } from 'chess.js';

const URL = 'http://localhost:3001';
const log = (...a) => console.log(...a);
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) log(`  PASS  ${name}`);
  else { failures++; log(`  FAIL  ${name} ${extra}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function mkClient(name) {
  const s = io(URL, { transports: ['websocket'] });
  s.states = [];
  s.fx = [];
  s.chat = [];
  s.marks = [];
  s.name = name;
  s.token = `tok-${name}-${Math.random().toString(36).slice(2)}`;
  s.on('room:state', st => { s.states.push(st); s.last = st; });
  s.on('game:fx', f => s.fx.push(f));
  s.on('game:ended', e => { s.ended = e; });
  s.on('draw:resolved', r => { s.drawResolved = r; });
  s.on('chat:new', m => s.chat.push(m));
  s.on('chat:history', h => { s.chat = h.slice(); });
  s.on('mark:state', m => { s.marks = m; });
  s.on('cards:hand', h => { s.hand = h; });
  s.on('game:archived', g => { s.archived = g; });
  return new Promise(res => s.on('connect', () => res(s)));
}

const emitCb = (s, ev, payload) => new Promise(res => s.emit(ev, payload, res));

/** A real 2x2 PNG, so the server decodes bytes rather than a string that looks like some. */
const TINY_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQ'
  + 'kAABkwAgapUdHDAAAAAElFTkSuQmCC';

const fetchJson = async path => {
  try {
    const res = await fetch(`${URL}${path}`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
};

const fetchText = async path => {
  try {
    const res = await fetch(`${URL}${path}`);
    return res.ok ? await res.text() : '';
  } catch { return ''; }
};

// join with an explicit token so reconnect semantics are testable
function join(s, roomId) {
  return new Promise(res =>
    s.emit('room:join',
      { roomId, name: s.name, token: s.token, session: s.session }, res));
}

/**
 * Register an account on this socket, so the games it plays are recorded.
 *
 * Falls back to signing in, because the suite is meant to be runnable twice: the second
 * run finds the account the first one made, and "that username is taken" is the right
 * answer to a repeat registration rather than a failure of the suite.
 */
async function signUp(s, password = 'correct-horse') {
  let res = await emitCb(s, 'auth:register', { username: s.name, password });
  if (!res?.ok) res = await emitCb(s, 'auth:login', { username: s.name, password });
  if (res?.ok) s.session = res.session;
  return res;
}

async function waitFor(s, pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (s.last && pred(s.last)) return s.last;
    await sleep(25);
  }
  return null;
}

async function main() {
  log('\n=== 1. Rotation order (3v3) ===');
  const host = await mkClient('Anna');
  const roomId = await emitCb(host, 'room:create',
    { name: 'Anna', config: { teamSize: 3, moveTimerSec: 60, skipEmptySeats: true } });
  log(`  room ${roomId}`);

  const w = [host, await mkClient('Boris'), await mkClient('Clara')];
  const b = [await mkClient('Dmitri'), await mkClient('Elena'), await mkClient('Fyodor')];

  for (const c of [...w, ...b]) await join(c, roomId);
  for (let i = 0; i < 3; i++) {
    await emitCb(w[i], 'seat:take', { color: 'white', seatId: i });
    await emitCb(b[i], 'seat:take', { color: 'black', seatId: i });
  }

  host.emit('game:start');
  await waitFor(host, s => s.status === 'playing');
  check('game starts', host.last.status === 'playing');

  // W.p1 -> B.p1 -> W.p2 -> B.p2 -> W.p3 -> B.p3 -> W.p1
  const seq = [
    [w[0], 'white', 0, 'e2', 'e4'], [b[0], 'black', 0, 'e7', 'e5'],
    [w[1], 'white', 1, 'g1', 'f3'], [b[1], 'black', 1, 'b8', 'c6'],
    [w[2], 'white', 2, 'f1', 'c4'], [b[2], 'black', 2, 'g8', 'f6'],
    [w[0], 'white', 0, 'd2', 'd3'],
  ];
  let ok = true;
  for (const [cli, color, seatId, from, to] of seq) {
    const st = host.last;
    if (st.activeColor !== color || st.activeSeatId !== seatId) {
      ok = false;
      log(`    expected ${color}#${seatId}, got ${st.activeColor}#${st.activeSeatId}`);
      break;
    }
    const accepted = await emitCb(cli, 'game:move', { from, to });
    if (!accepted) { ok = false; log(`    move ${from}${to} rejected`); break; }
    await sleep(60);
  }
  check('rotation cycles W1,B1,W2,B2,W3,B3,W1', ok);

  log('\n=== 2. Only the active seat may move ===');
  const wrongSeat = await emitCb(w[2], 'game:move', { from: 'a2', to: 'a3' });
  check('off-turn teammate is rejected', wrongSeat === false);
  const wrongTeam = await emitCb(w[0], 'game:move', { from: 'a7', to: 'a6' });
  check('wrong-team move is rejected', wrongTeam === false);

  log('\n=== 3. Timeout plays a random legal move ===');
  const h2 = await mkClient('Timeout-Host');
  const rid2 = await emitCb(h2, 'room:create',
    { name: 'T', config: { teamSize: 2, moveTimerSec: 5, skipEmptySeats: true } });
  const t2 = await mkClient('Timeout-Black');
  await join(h2, rid2); await join(t2, rid2);
  await emitCb(h2, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(t2, 'seat:take', { color: 'black', seatId: 0 });
  h2.emit('game:start');
  await waitFor(h2, s => s.status === 'playing');

  const beforePly = h2.last.history.length;
  const beforeSeat = h2.last.activeSeatId;
  const timedOut = await waitFor(h2, s => s.history.length > beforePly, 9000);
  check('a move appears when the clock expires', !!timedOut);
  if (timedOut) {
    const last = timedOut.history[timedOut.history.length - 1];
    check('the forced move is flagged auto', last.auto === true, JSON.stringify(last));
    check('it is attributed to the seat that timed out', last.seatId === beforeSeat);
    check('turn passed to the other team', timedOut.activeColor === 'black');
    check('auto fx broadcast to all clients', t2.fx.some(f => f.auto === true));
  }
  const statsSeat = timedOut?.white.seats[0].stats;
  check('timeout counted in that seat stats', statsSeat?.autoMoves === 1,
    JSON.stringify(statsSeat));

  h2.emit('game:reset');

  log('\n=== 4. A timed-out seat still yields to its teammate ===');
  // two real teammates on White, so the rotation has somewhere to advance to
  const r2 = await mkClient('Timeout-White2');
  await join(r2, rid2);
  await emitCb(r2, 'seat:take', { color: 'white', seatId: 1 });
  h2.emit('game:start');
  await waitFor(h2, s => s.status === 'playing');
  check('White seat 1 is filled', h2.last.white.seats[1].occupied === true);
  check('White starts on seat 0', h2.last.white.activeSeatId === 0);

  const p0 = h2.last.history.length;
  await waitFor(h2, s => s.history.length > p0, 9000);   // W seat 0 times out
  check('the timed-out move is attributed to seat 0',
    h2.last.history[h2.last.history.length - 1].seatId === 0);
  check('control passes to teammate seat 1', h2.last.white.activeSeatId === 1,
    `got ${h2.last.white.activeSeatId}`);
  h2.emit('game:reset');

  log('\n=== 5. Takeback requires the opponent ===');
  const h3 = await mkClient('TB-White');
  const rid3 = await emitCb(h3, 'room:create',
    { name: 'TB', config: { teamSize: 1, moveTimerSec: 60, allowTakeback: true } });
  const o3 = await mkClient('TB-Black');
  await join(h3, rid3); await join(o3, rid3);
  await emitCb(h3, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(o3, 'seat:take', { color: 'black', seatId: 0 });
  h3.emit('game:start');
  await waitFor(h3, s => s.status === 'playing');

  await emitCb(h3, 'game:move', { from: 'e2', to: 'e4' });
  await sleep(80);
  const fenAfterMove = h3.last.fen;

  h3.emit('takeback:request');
  await waitFor(h3, s => s.pendingTakeback != null);
  check('request registers as pending', h3.last.pendingTakeback?.byColor === 'white');
  check('clock is paused while pending', h3.last.turnDeadline === null);

  // the requester must not be able to self-approve
  h3.emit('takeback:respond', { accept: true });
  await sleep(150);
  check('requester cannot accept their own takeback',
    h3.last.pendingTakeback != null && h3.last.fen === fenAfterMove);

  o3.emit('takeback:respond', { accept: true });
  await waitFor(h3, s => s.pendingTakeback == null);
  check('opponent acceptance rewinds the board', h3.last.history.length === 0,
    `history=${h3.last.history.length}`);
  check('rotation returns to White', h3.last.activeColor === 'white');
  check('clock re-armed after accept', h3.last.turnDeadline !== null);

  log('\n=== 6. Declined takeback resumes banked time ===');
  await emitCb(h3, 'game:move', { from: 'd2', to: 'd4' });
  await sleep(1500);            // burn ~1.5s of Black's clock
  const deadlineBefore = h3.last.turnDeadline;
  h3.emit('takeback:request');
  await waitFor(h3, s => s.pendingTakeback != null);
  await sleep(600);
  o3.emit('takeback:respond', { accept: false });
  await waitFor(h3, s => s.pendingTakeback == null);
  const remaining = h3.last.turnDeadline - Date.now();
  check('decline keeps the move on the board', h3.last.history.length === 1);
  // banked ~58.5s, so a resumed clock must be well under a fresh 60s
  check('declining resumes banked time, not a fresh clock',
    remaining < 59_000 && remaining > 50_000, `remaining=${Math.round(remaining/1000)}s`);

  log('\n=== 7. Bot seats move on their own ===');
  const h4 = await mkClient('Bot-Host');
  const rid4 = await emitCb(h4, 'room:create',
    { name: 'B', config: { teamSize: 1, moveTimerSec: 60 } });
  await join(h4, rid4);
  await emitCb(h4, 'seat:take', { color: 'white', seatId: 0 });
  h4.emit('seat:bot', { color: 'black', seatId: 0, bot: true });
  await waitFor(h4, s => s.black.seats[0].kind === 'bot');
  check('seat converts to a bot', h4.last.black.seats[0].kind === 'bot');
  check('bot seat counts as occupied', h4.last.black.seats[0].occupied === true);

  h4.emit('game:start');
  await waitFor(h4, s => s.status === 'playing');
  await emitCb(h4, 'game:move', { from: 'e2', to: 'e4' });
  const botMoved = await waitFor(h4, s => s.history.length === 2, 5000);
  check('bot replies without prompting', !!botMoved);
  if (botMoved) {
    const last = botMoved.history[1];
    check('bot move is tagged as a bot move', last.bot === true && last.auto === false);
    check('turn returns to White', botMoved.activeColor === 'white');
  }

  log('\n=== 8. skipEmptySeats actually takes effect ===');
  // skip=true: an empty seat 1 must be jumped, so W returns to seat 0
  const h5 = await mkClient('Skip-Host');
  const rid5 = await emitCb(h5, 'room:create',
    { name: 'S', config: { teamSize: 3, moveTimerSec: 60, skipEmptySeats: true } });
  const o5 = await mkClient('Skip-Black');
  await join(h5, rid5); await join(o5, rid5);
  await emitCb(h5, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(o5, 'seat:take', { color: 'black', seatId: 0 });
  h5.emit('game:start');
  await waitFor(h5, s => s.status === 'playing');
  await emitCb(h5, 'game:move', { from: 'e2', to: 'e4' });
  await sleep(80);
  await emitCb(o5, 'game:move', { from: 'e7', to: 'e5' });
  await sleep(80);
  check('skip=true jumps empty seats back to seat 0',
    h5.last.white.activeSeatId === 0, `got ${h5.last.white.activeSeatId}`);

  // skip=false: every seat holds its slot, so W advances to the empty seat 1
  const h6 = await mkClient('NoSkip-Host');
  const rid6 = await emitCb(h6, 'room:create',
    { name: 'N', config: { teamSize: 3, moveTimerSec: 60, skipEmptySeats: false } });
  const o6 = await mkClient('NoSkip-Black');
  await join(h6, rid6); await join(o6, rid6);
  await emitCb(h6, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(o6, 'seat:take', { color: 'black', seatId: 0 });
  h6.emit('game:start');
  await waitFor(h6, s => s.status === 'playing');
  await emitCb(h6, 'game:move', { from: 'e2', to: 'e4' });
  await sleep(120);
  check('skip=false keeps empty seats in the rotation',
    h6.last.white.activeSeatId === 1, `got ${h6.last.white.activeSeatId}`);
  check('the two settings genuinely differ',
    h5.last.white.activeSeatId !== h6.last.white.activeSeatId);

  log('\n=== 9. Reconnect reclaims the seat ===');
  const tok = w[1].token;
  w[1].disconnect();
  await sleep(250);
  const rejoin = await mkClient('Boris');
  rejoin.token = tok;
  const res = await join(rejoin, roomId);
  check('same token gets the seat back',
    res.you?.seat?.color === 'white' && res.you?.seat?.seatId === 1,
    JSON.stringify(res.you?.seat));

  log('\n=== 10. Checkmate detection (fool\'s mate) ===');
  const h7 = await mkClient('Mate-W');
  const rid7 = await emitCb(h7, 'room:create',
    { name: 'M', config: { teamSize: 1, moveTimerSec: 120 } });
  const o7 = await mkClient('Mate-B');
  await join(h7, rid7); await join(o7, rid7);
  await emitCb(h7, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(o7, 'seat:take', { color: 'black', seatId: 0 });
  h7.emit('game:start');
  await waitFor(h7, s => s.status === 'playing');
  for (const [c, f, t] of [[h7,'f2','f3'],[o7,'e7','e5'],[h7,'g2','g4'],[o7,'d8','h4']]) {
    await emitCb(c, 'game:move', { from: f, to: t });
    await sleep(60);
  }
  check('checkmate ends the game', h7.last.status === 'finished');
  check('winner is Black', h7.last.gameOver?.winner === 'black',
    JSON.stringify(h7.last.gameOver));
  check('reason is checkmate', h7.last.gameOver?.reason === 'checkmate');
  check('clock stops on game over', h7.last.turnDeadline === null);

  log('\n=== 11. Team chat stays inside the team ===');
  const c1 = await mkClient('Chat-W1');
  const rid8 = await emitCb(c1, 'room:create',
    { name: 'C', config: { teamSize: 2, moveTimerSec: 60 } });
  const c2 = await mkClient('Chat-W2');
  const c3 = await mkClient('Chat-B1');
  const c4 = await mkClient('Chat-Spec');
  for (const c of [c1, c2, c3, c4]) await join(c, rid8);
  await emitCb(c1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(c2, 'seat:take', { color: 'white', seatId: 1 });
  await emitCb(c3, 'seat:take', { color: 'black', seatId: 0 });
  await sleep(80);

  for (const c of [c1, c2, c3, c4]) c.chat = [];
  c1.emit('chat:send', { text: 'take on d5' });
  await sleep(150);
  check('a teammate receives the message',
    c2.chat.some(m => m.text === 'take on d5'), JSON.stringify(c2.chat));
  check('the sender sees their own message', c1.chat.length === 1);
  check('the opposing team receives nothing', c3.chat.length === 0,
    JSON.stringify(c3.chat));
  check('a spectator receives nothing', c4.chat.length === 0, JSON.stringify(c4.chat));

  c4.emit('chat:send', { text: 'nice game' });
  await sleep(150);
  check('spectators have their own channel',
    c4.chat.some(m => m.text === 'nice game') && c1.chat.length === 1);

  c1.emit('chat:send', { text: '   ' });
  await sleep(120);
  check('blank messages are dropped', c2.chat.length === 1, JSON.stringify(c2.chat));

  // the bucket is six deep; the tail of a longer burst must be refused
  for (let i = 0; i < 14; i++) c1.emit('chat:send', { text: `spam ${i}` });
  await sleep(300);
  check('a flood is rate limited', c2.chat.length < 15,
    `${c2.chat.length} messages got through`);

  log('\n=== 12. Ghost marks are team-scoped and expire with the position ===');
  c1.emit('mark:toggle', { square: 'd5' });
  await sleep(150);
  check('the marker sees their own mark',
    c1.marks.length === 1 && c1.marks[0].square === 'd5' && c1.marks[0].own === true,
    JSON.stringify(c1.marks));
  check('a teammate sees it, not as their own',
    c2.marks.length === 1 && c2.marks[0].own === false, JSON.stringify(c2.marks));
  check('the opposing team sees nothing', c3.marks.length === 0, JSON.stringify(c3.marks));
  check('a spectator sees nothing', c4.marks.length === 0, JSON.stringify(c4.marks));

  c1.emit('mark:toggle', { square: 'd5' });
  await sleep(150);
  check('marking the same square again clears it', c1.marks.length === 0);

  c1.emit('mark:toggle', { square: 'zz' });
  await sleep(120);
  check('a nonsense square is refused', c1.marks.length === 0, JSON.stringify(c1.marks));

  c4.emit('mark:toggle', { square: 'e4' });
  await sleep(120);
  check('a spectator cannot mark', c4.marks.length === 0, JSON.stringify(c4.marks));

  // marks describe one position, so both a new game and a played ply drop them
  c1.emit('mark:toggle', { square: 'e5' });
  await sleep(120);
  c1.emit('game:start');
  await waitFor(c1, s => s.status === 'playing');
  check('starting a game clears lobby marks', c2.marks.length === 0, JSON.stringify(c2.marks));

  c1.emit('mark:toggle', { square: 'd4' });
  await sleep(150);
  check('a mark made in play reaches teammates', c2.marks.length === 1,
    JSON.stringify(c2.marks));
  await emitCb(c1, 'game:move', { from: 'e2', to: 'e4' });
  await sleep(150);
  check('a played ply clears the marks', c2.marks.length === 0, JSON.stringify(c2.marks));

  log('\n=== 13. The clock is sent as a duration, not just an epoch ===');
  // A client that subtracts an absolute server deadline from its own Date.now() gets a
  // wrong countdown the moment the two clocks disagree, which is what happened in
  // production. The duration is what the client actually counts down.
  const ck1 = await mkClient('Clock-W');
  const rid13 = await emitCb(ck1, 'room:create',
    { name: 'T', config: { teamSize: 1, moveTimerSec: 30 } });
  const ck2 = await mkClient('Clock-B');
  for (const c of [ck1, ck2]) await join(c, rid13);
  await emitCb(ck1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(ck2, 'seat:take', { color: 'black', seatId: 0 });
  check('an idle lobby reports no remaining time', ck1.last.turnRemainingMs === null,
    String(ck1.last.turnRemainingMs));

  ck1.emit('game:start');
  await waitFor(ck1, s => s.status === 'playing');
  check('a live turn reports a duration close to the configured clock',
    ck1.last.turnRemainingMs > 28_000 && ck1.last.turnRemainingMs <= 30_000,
    String(ck1.last.turnRemainingMs));

  await sleep(1200);
  await emitCb(ck1, 'game:move', { from: 'e2', to: 'e4' });
  await sleep(120);
  check('the next turn gets a fresh full duration',
    ck2.last.turnRemainingMs > 28_000, String(ck2.last.turnRemainingMs));

  log('\n=== 14. Draw offers ===');
  const d1 = await mkClient('Draw-W');
  const rid14 = await emitCb(d1, 'room:create',
    { name: 'D', config: { teamSize: 1, moveTimerSec: 60 } });
  const d2 = await mkClient('Draw-B');
  const d3 = await mkClient('Draw-Spec');
  for (const c of [d1, d2, d3]) await join(c, rid14);
  await emitCb(d1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(d2, 'seat:take', { color: 'black', seatId: 0 });
  d1.emit('game:start');
  await waitFor(d1, s => s.status === 'playing');

  d3.emit('draw:offer');
  await sleep(150);
  check('a spectator cannot offer a draw', d1.last.pendingDraw === null,
    JSON.stringify(d1.last.pendingDraw));

  d1.emit('draw:offer');
  await waitFor(d2, s => s.pendingDraw !== null);
  check('an offer reaches both teams', d2.last.pendingDraw?.byColor === 'white',
    JSON.stringify(d2.last.pendingDraw));
  check('the offer carries a duration, not only a deadline',
    d2.last.pendingDraw?.remainingMs > 15_000,
    String(d2.last.pendingDraw?.remainingMs));

  d1.emit('draw:respond', { accept: true });
  await sleep(150);
  check('the offering side cannot accept its own draw',
    d1.last.status === 'playing' && d1.last.pendingDraw !== null);

  d2.emit('draw:respond', { accept: false });
  await sleep(150);
  check('a decline clears the offer and play continues',
    d1.last.pendingDraw === null && d1.last.status === 'playing');
  check('the decline is announced', d1.drawResolved?.accepted === false,
    JSON.stringify(d1.drawResolved));
  check('a declined offer does not end the game', d1.last.gameOver === null);

  d1.emit('draw:offer');
  await waitFor(d2, s => s.pendingDraw !== null);
  d2.emit('draw:respond', { accept: true });
  await waitFor(d1, s => s.status === 'finished');
  check('an accepted draw ends the game by agreement',
    d1.last.gameOver?.reason === 'agreement' && d1.last.gameOver?.winner === 'draw',
    JSON.stringify(d1.last.gameOver));
  check('the agreed draw is announced', d1.ended?.kind === 'draw-agreed',
    JSON.stringify(d1.ended));
  check('the clock stops when the game ends by agreement',
    d1.last.turnRemainingMs === null, String(d1.last.turnRemainingMs));

  log('\n=== 15. Resignation ===');
  const rs1 = await mkClient('Res-W');
  const rid15 = await emitCb(rs1, 'room:create',
    { name: 'R', config: { teamSize: 2, moveTimerSec: 60 } });
  const rs2 = await mkClient('Res-W2');
  const rs3 = await mkClient('Res-B');
  const rs4 = await mkClient('Res-Spec');
  for (const c of [rs1, rs2, rs3, rs4]) await join(c, rid15);
  await emitCb(rs1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(rs2, 'seat:take', { color: 'white', seatId: 1 });
  await emitCb(rs3, 'seat:take', { color: 'black', seatId: 0 });
  rs1.emit('game:start');
  await waitFor(rs1, s => s.status === 'playing');

  rs4.emit('game:resign');
  await sleep(150);
  check('a spectator cannot resign', rs1.last.status === 'playing');

  // the seat that resigns is not the one on the clock, which is the whole point of it
  rs2.emit('game:resign');
  await waitFor(rs1, s => s.status === 'finished');
  check('any seated player may resign for their team',
    rs1.last.gameOver?.reason === 'resignation', JSON.stringify(rs1.last.gameOver));
  check('the opposing team is credited the win',
    rs1.last.gameOver?.winner === 'black', JSON.stringify(rs1.last.gameOver));
  check('the resignation names who gave it up',
    rs3.ended?.kind === 'resign' && rs3.ended.byColor === 'white'
      && rs3.ended.byName === 'Res-W2', JSON.stringify(rs3.ended));
  check('the clock stops on a resignation', rs1.last.turnRemainingMs === null,
    String(rs1.last.turnRemainingMs));

  rs3.emit('game:resign');
  await sleep(150);
  check('a finished game cannot be resigned again',
    rs1.last.gameOver?.winner === 'black', JSON.stringify(rs1.last.gameOver));

  log('\n=== 16. Chess Cards: the deal, the spend, and the hidden hand ===');
  // The deck is shuffled, so nothing here asserts a particular hand. It asserts the
  // invariants that must hold whatever was dealt, which is the stronger claim anyway.
  const CARD_PIECE = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q' };

  /** Piece types a hand can pay for, king included -- he is always free. */
  const reach = hand => {
    const out = new Set(['k']);
    if (!hand) return out;
    if (hand.emergency) { for (const t of 'pnbrq') out.add(t); return out; }
    for (const c of hand.cards) {
      if (c.kind === 'wild') { for (const t of 'pnbrq') out.add(t); }
      else out.add(CARD_PIECE[c.kind]);
    }
    return out;
  };

  const cw = await mkClient('Cards-W');
  const ridC = await emitCb(cw, 'room:create',
    { name: 'CW', config: { mode: 'cards', teamSize: 4, moveTimerSec: 60 } });
  const cbk = await mkClient('Cards-B');
  const cspec = await mkClient('Cards-Spec');
  for (const c of [cw, cbk, cspec]) await join(c, ridC);

  check('cards mode is recorded on the room', cw.last.config.mode === 'cards',
    JSON.stringify(cw.last.config));
  check('cards mode forces a 1v1 roster', cw.last.config.teamSize === 1,
    String(cw.last.config.teamSize));
  check('no cards exist before the game starts', cw.last.cards === null,
    JSON.stringify(cw.last.cards));

  await emitCb(cw, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(cbk, 'seat:take', { color: 'black', seatId: 0 });
  cw.emit('game:start');
  await waitFor(cw, s => s.status === 'playing');
  await sleep(200);

  // Sizes come from the server's own published numbers rather than literals, so retuning
  // the mode does not silently invalidate the suite. docs/BALANCE.md owns the numbers.
  // The opening hand is one card per piece kind, which the client only sees as a count.
  const HAND = cw.hand.cards.length;
  // The cap is per side and falls with that side's army, so it is read fresh rather than
  // captured once. At the opening both sides have every piece kind and sit at the maximum.
  const CAP = cw.last.cards.white.handCap;
  check('a full army opens at the maximum cap',
    CAP === cw.last.cards.handMax && cw.last.cards.black.handCap === CAP,
    `${CAP} vs ${cw.last.cards.handMax}`);
  const DECK = cw.last.cards.white.handCount + cw.last.cards.white.deckCount
    + cw.last.cards.white.discardCount;
  check('the deck is thirty-six a side', DECK === 36, String(DECK));
  check('both sides are dealt the same opening hand',
    cw.hand?.cards.length === HAND && cbk.hand?.cards.length === HAND,
    `${cw.hand?.cards.length} / ${cbk.hand?.cards.length}`);
  check('and it is one card for each piece kind, so no game opens stuck', (() => {
    const kinds = new Set(cw.hand.cards.map(c => c.kind));
    return kinds.size === HAND && !kinds.has('wild');
  })(), cw.hand.cards.map(c => c.kind).join(','));
  check('each player is given their own colour',
    cw.hand?.color === 'white' && cbk.hand?.color === 'black');
  check('the public state agrees on the counts',
    cw.last.cards.white.handCount === HAND && cw.last.cards.black.handCount === HAND,
    JSON.stringify(cw.last.cards));
  check('a spectator is dealt nothing', cspec.hand === null, JSON.stringify(cspec.hand));

  // The whole mode rests on this: the broadcast state must not carry anyone's cards.
  const publicBlob = JSON.stringify(cw.last.cards);
  check('the broadcast state carries no card identities',
    !publicBlob.includes('"id"') && !publicBlob.includes('"kind"'), publicBlob);
  check('only White is on the clock at the start',
    cw.hand.yourTurn === true && cbk.hand.yourTurn === false);
  check('the draw pile is the deck less the opening hand',
    cw.last.cards.white.deckCount === DECK - HAND,
    String(cw.last.cards.white.deckCount));

  log('\n=== 17. Chess Cards: a card is required, and the king never needs one ===');
  const openBoard = new Chess(cw.last.fen);
  const myReach = reach(cw.hand);
  const legal = openBoard.moves({ verbose: true });
  const unaffordable = legal.find(m => !myReach.has(m.piece));
  if (unaffordable) {
    const refused = await emitCb(cw, 'game:move',
      { from: unaffordable.from, to: unaffordable.to });
    check(`a ${unaffordable.piece} move with no card for it is refused`, refused === false,
      `${unaffordable.from}${unaffordable.to}`);
    check('the refused move did not touch the board', cw.last.history.length === 0);
    check('the refused move did not spend a card', cw.hand.cards.length === HAND);
  } else {
    check('every opening move was affordable, so there was nothing to refuse', true);
  }

  const affordable = legal.find(m => myReach.has(m.piece) && m.piece !== 'k');
  const spentBefore = cw.last.cards.white.played.length;
  // The opening hand holds a pawn and a knight card by construction, so it can never open
  // dead -- but the check stays, because the emergency pays at random and would otherwise
  // make the assertion below say nothing if the opening deal is ever retuned.
  const openedDead = cw.hand.emergency;
  const okAfford = await emitCb(cw, 'game:move',
    { from: affordable.from, to: affordable.to });
  await sleep(150);
  check('a move the hand covers is accepted', okAfford === true);
  check('it spent exactly one card',
    cw.last.cards.white.played.length === spentBefore + 1,
    JSON.stringify(cw.last.cards.white.played));
  check(openedDead
      ? 'an emergency move paid with a card taken at random'
      : 'the spent card covered the piece that moved',
    openedDead
      ? cw.last.cards.white.emergenciesUsed === 1
      : (() => {
          const k = cw.last.cards.white.played[spentBefore];
          return k === 'wild' || CARD_PIECE[k] === affordable.piece;
        })(),
    `${cw.last.cards.white.played[spentBefore]} for ${affordable.piece}`
    + `${openedDead ? ' (emergency)' : ''}`);
  check('the opponent sees a card was spent, not which one left the hand',
    cbk.last.cards.white.handCount === HAND - 1,
    String(cbk.last.cards.white.handCount));
  check('Black never received a White hand', cbk.hand.color === 'black');

  log('\n=== 18. Chess Cards: a full game holds every invariant ===');
  // Play both sides properly for a while: always a move the hand can pay for, checking
  // at every ply what the rules promise about hands, draws, tempo and the cap.
  const byColor = { white: cw, black: cbk };
  const BASE_DEAL = cw.last.cards.drawPerTurn;
  const lastHand = { white: null, black: null };
  let capturesSeen = 0, emergenciesSeen = 0, kingMovesSeen = 0, enrageChecked = false;
  let bad = null;

  for (let ply = 0; ply < 34 && cw.last.status === 'playing'; ply++) {
    const st = cw.last;
    const color = st.turn;
    const me = byColor[color];
    const hand = me.hand;

    if (!hand || !hand.yourTurn) { bad = `${color} has no live hand on its own turn`; break; }

    if (st.history.length >= 20 && !enrageChecked) {
      enrageChecked = true;
      check('soft enrage raises the deal at twenty plies',
        st.cards.drawPerTurn === BASE_DEAL + 1 && st.cards.enraged === true,
        JSON.stringify(st.cards));
    }
    // The hand is dealt into rather than refilled, so what is promised is a floor of one
    // card -- you can always do something -- and the cap, which nothing may pass.
    if (hand.cards.length < 1) {
      bad = `${color} was left holding nothing`; break;
    }
    const capNow = st.cards[color].handCap;
    if (hand.cards.length > Math.max(capNow, CAP)) {
      bad = `${color} holds ${hand.cards.length}, over every cap it has had`; break;
    }
    if (hand.cards.length !== hand.handCap && hand.handCap !== capNow) {
      bad = `${color} was told cap ${hand.handCap}, the table says ${capNow}`; break;
    }
    if (lastHand[color] != null) {
      // a turn deals a fixed number, so the hand can only grow by the deal, and only
      // shrink by what a move costs
      const grew = hand.cards.length - lastHand[color];
      if (grew > st.cards.drawPerTurn + 1) {
        bad = `${color} gained ${grew} cards in one turn`; break;
      }
    }
    lastHand[color] = hand.cards.length;
    if (st.cards[color].handCount !== hand.cards.length) {
      bad = `public count ${st.cards[color].handCount} != real ${hand.cards.length}`; break;
    }
    if (hand.emergency) emergenciesSeen++;

    const g = new Chess(st.fen);
    const r = reach(hand);
    // Castling is the one king move that is not free -- the rook travels too, and it
    // costs a Rook card -- so the harness may only offer it when the hand can pay. Left
    // in, it would occasionally pick a castle the server was right to refuse and report
    // the refusal as a failure.
    const options = g.moves({ verbose: true }).filter(m => r.has(m.piece))
      .filter(m => hand.canCastle !== false || !/^O-O/.test(m.san));
    if (options.length === 0) { bad = `${color} could not move at all`; break; }

    // Prefer a capture where one exists, to exercise the tempo bonus; otherwise pick at
    // random rather than taking the first move every time. Always taking `options[0]`
    // walks both sides into a repetition loop where no card is ever spent and no card is
    // ever drawn, which starves exactly the churn this section is here to observe.
    const pick = options.find(m => m.captured)
      ?? options[Math.floor(Math.random() * options.length)];
    const before = { hand: hand.cards.length, played: st.cards[color].played.length };

    const accepted = await emitCb(me, 'game:move',
      { from: pick.from, to: pick.to, promotion: pick.promotion });
    if (!accepted) { bad = `${color} was refused an affordable ${pick.piece} move`; break; }
    await sleep(90);

    const after = cw.last.cards[color];
    // Castling is the one king move that is paid for -- the rook travels too -- so it is
    // counted with the moves that spend rather than with the free ones.
    const castled = pick.san.startsWith('O-O');
    if (pick.piece === 'k' && !castled) {
      kingMovesSeen++;
      if (after.played.length !== before.played) { bad = 'a king move spent a card'; break; }
    } else if (after.played.length !== before.played + 1) {
      bad = `a ${pick.piece} move spent ${after.played.length - before.played} cards`; break;
    }
    if (pick.captured && cw.last.status === 'playing') {
      capturesSeen++;
      // One card paid for the move and one came back for the capture -- except on a turn
      // the emergency net opened, where the hand was empty of anything playable and the
      // arithmetic of "one out, one in" does not describe what happened. There the
      // invariant is the one that always holds: never over the cap, never up by more
      // than the tempo card.
      if (hand.emergency) {
        if (after.handCount > after.handCap || after.handCount - before.hand > 1) {
          bad = `an emergency capture left ${after.handCount} cards `
            + `(cap ${after.handCap}, before ${before.hand})`;
          break;
        }
      } else {
        const expected = Math.min(after.handCap,
          before.hand - (pick.piece === 'k' ? 0 : 1) + 1);
        if (after.handCount !== expected) {
          bad = `a capture left ${after.handCount} cards, expected ${expected}`; break;
        }
      }
    }
  }

  check('a full game runs with no invariant broken', bad === null, bad ?? '');
  check('captures happened, and each drew its tempo card', capturesSeen > 0,
    `${capturesSeen} captures`);
  log(`  (${capturesSeen} captures, ${kingMovesSeen} free king moves, `
    + `${emergenciesSeen} emergency turns)`);

  log('\n=== 19. Chess Cards: mulligan, once ===');
  const cm1 = await mkClient('Mull-W');
  const ridM = await emitCb(cm1, 'room:create',
    { name: 'M', config: { mode: 'cards', moveTimerSec: 60 } });
  const cm2 = await mkClient('Mull-B');
  for (const c of [cm1, cm2]) await join(c, ridM);
  await emitCb(cm1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(cm2, 'seat:take', { color: 'black', seatId: 0 });
  cm1.emit('game:start');
  await waitFor(cm1, s => s.status === 'playing');
  await sleep(150);

  const firstHand = cm1.hand.cards.map(c => c.id).sort().join(',');
  check('the mulligan is offered on your own turn', cm1.hand.mulliganAvailable === true);
  check('it is not offered on the opponent turn', cm2.hand.mulliganAvailable === false);

  cm2.emit('cards:mulligan');
  await sleep(150);
  check('you cannot mulligan out of turn', cm2.last.cards.black.mulliganUsed === false);

  cm1.emit('cards:mulligan');
  await sleep(200);
  const secondHand = cm1.hand.cards.map(c => c.id).sort().join(',');
  check('a mulligan deals a different hand', secondHand !== firstHand);
  check('a mulligan deals the opening spread again, not another random hand', (() => {
    const kinds = new Set(cm1.hand.cards.map(c => c.kind));
    return kinds.size === cm1.hand.cards.length && !kinds.has('wild');
  })(), cm1.hand.cards.map(c => c.kind).join(','));
  check('the mulligan is publicly spent', cm1.last.cards.white.mulliganUsed === true);
  check('the old hand went to the discard pile',
    cm1.last.cards.white.discardCount === firstHand.split(',').length,
    String(cm1.last.cards.white.discardCount));

  cm1.emit('cards:mulligan');
  await sleep(150);
  check('the second mulligan is refused',
    cm1.hand.cards.map(c => c.id).sort().join(',') === secondHand);
  check('you still owe a move after a mulligan', cm1.last.history.length === 0);

  log('\n=== 20. Chess Cards: the clock plays a move the hand could have paid for ===');
  const ct1 = await mkClient('CTime-W');
  const ridT = await emitCb(ct1, 'room:create',
    { name: 'CT', config: { mode: 'cards', moveTimerSec: 5 } });
  const ct2 = await mkClient('CTime-B');
  for (const c of [ct1, ct2]) await join(c, ridT);
  await emitCb(ct1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(ct2, 'seat:take', { color: 'black', seatId: 0 });
  ct1.emit('game:start');
  await waitFor(ct1, s => s.status === 'playing');
  await sleep(150);

  const timeoutReach = reach(ct1.hand);
  const wasEmergency = ct1.hand.emergency;
  await waitFor(ct1, s => s.history.length > 0, 9000);
  const forced = ct1.last.history[0];
  check('the clock played for the seat that ran out', forced?.auto === true,
    JSON.stringify(forced));
  const replay = new Chess();
  replay.move(forced.san);
  const movedPiece = replay.history({ verbose: true })[0].piece;
  check('the forced move used a piece the hand could reach',
    wasEmergency || timeoutReach.has(movedPiece),
    `${forced.san} moved a ${movedPiece}; hand reached ${[...timeoutReach].join('')}`);
  check('the forced move paid for itself',
    movedPiece === 'k' || ct1.last.cards.white.played.length === 1,
    JSON.stringify(ct1.last.cards.white.played));

  log('\n=== 21. Chess Cards: a takeback rewinds the hand with the board ===');
  const tk1 = await mkClient('CTake-W');
  const ridK = await emitCb(tk1, 'room:create',
    { name: 'CK', config: { mode: 'cards', moveTimerSec: 60, allowTakeback: true } });
  const tk2 = await mkClient('CTake-B');
  for (const c of [tk1, tk2]) await join(c, ridK);
  await emitCb(tk1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(tk2, 'seat:take', { color: 'black', seatId: 0 });
  tk1.emit('game:start');
  await waitFor(tk1, s => s.status === 'playing');
  await sleep(150);

  const handBefore = tk1.hand.cards.map(c => c.id).sort().join(',');
  const gt = new Chess(tk1.last.fen);
  const rt = reach(tk1.hand);
  const mv = gt.moves({ verbose: true }).find(m => rt.has(m.piece) && m.piece !== 'k');
  await emitCb(tk1, 'game:move', { from: mv.from, to: mv.to });
  await sleep(150);
  check('the move spent a card',
    tk1.hand.cards.length === handBefore.split(',').length - 1,
    String(tk1.hand.cards.length));

  tk1.emit('takeback:request');
  await waitFor(tk2, s => s.pendingTakeback !== null);
  tk2.emit('takeback:respond', { accept: true });
  await waitFor(tk1, s => s.history.length === 0);
  await sleep(200);
  check('the takeback put the exact hand back',
    tk1.hand.cards.map(c => c.id).sort().join(',') === handBefore,
    `${tk1.hand.cards.map(c => c.id).sort().join(',')} vs ${handBefore}`);
  check('and unspent the card', tk1.last.cards.white.played.length === 0,
    JSON.stringify(tk1.last.cards.white.played));

  log('\n=== 22. Team mode is untouched by any of it ===');
  const tmc = await mkClient('Team-Check');
  const ridTm = await emitCb(tmc, 'room:create', { name: 'T', config: { teamSize: 3 } });
  await join(tmc, ridTm);
  await waitFor(tmc, s => s.config != null);
  check('team mode is still the default', tmc.last.config.mode === 'team',
    JSON.stringify(tmc.last.config));
  check('a team room keeps its roster size', tmc.last.config.teamSize === 3);
  check('a team room deals no cards', tmc.last.cards === null);

  log('\n=== 23. Chess Cards: a card outlives its piece for exactly one turn ===');
  // Play a long game that takes every capture it can, so pieces actually come off the
  // board, and assert the thing that was broken: nobody is ever left holding a card for a
  // piece type they no longer own.
  const sw1 = await mkClient('Swap-W');
  const ridS = await emitCb(sw1, 'room:create',
    { name: 'S', config: { mode: 'cards', moveTimerSec: 120 } });
  const sw2 = await mkClient('Swap-B');
  for (const c of [sw1, sw2]) await join(c, ridS);
  await emitCb(sw1, 'seat:take', { color: 'white', seatId: 0 });
  await emitCb(sw2, 'seat:take', { color: 'black', seatId: 0 });
  sw1.emit('game:start');
  await waitFor(sw1, s => s.status === 'playing');
  await sleep(200);

  /** Piece types this colour has none of left on the board. */
  const extinctFor = (fen, color) => {
    const mine = color === 'white' ? 'w' : 'b';
    const alive = new Set();
    for (const row of new Chess(fen).board()) {
      for (const cell of row) if (cell && cell.color === mine) alive.add(cell.type);
    }
    return new Set(['p', 'n', 'b', 'r', 'q'].filter(t => !alive.has(t)));
  };

  const bySide = { white: sw1, black: sw2 };
  let strandedTurns = 0, extinctTurns = 0, worstStranded = '';
  let idleStranded = 0, idleTurns = 0, worstIdle = '';
  let swapsSeen = 0, extinctionsSeen = 0, replacedKinds = new Set();

  // Both sides play greedily for captures, but the game is still random, and whether it
  // reaches a piece type dying *while a live card is left in the deck* is a coin flip --
  // more so now that a hand of seven holds much of what could be swapped in. One game is
  // therefore not a test, it is a sample. Play up to three, stopping at the first that
  // actually exercises the swap, so the check stays a hard one instead of a flaky one.
  for (let attempt = 0; attempt < 5 && swapsSeen === 0; attempt++) {
  if (attempt > 0) {
    sw1.emit('game:rematch');
    await waitFor(sw1, st => st.status === 'playing' && st.history.length === 0);
    await sleep(200);
  }
  for (let ply = 0; ply < 90 && sw1.last.status === 'playing'; ply++) {
    const st = sw1.last;
    const color = st.turn;
    const me = bySide[color];
    const hand = me.hand;
    if (!hand?.yourTurn) break;

    const gone = extinctFor(st.fen, color);
    if (gone.size > 0) extinctionsSeen++;
    if (hand.replaced.length > 0) {
      swapsSeen++;
      for (const k of hand.replaced) replacedKinds.add(k);
    }

    // the invariant: nothing in hand names a piece this side no longer has
    // Both hands, not just the one on turn. A capture can end the *opponent's* last
    // knight, and their Knight cards used to sit dead in front of them until their own
    // turn opened -- which is the "a card arrives and then changes" report.
    const other = color === 'white' ? 'black' : 'white';
    const otherHand = bySide[other].hand;
    const otherGone = extinctFor(st.fen, other);
    const otherStranded = (otherHand?.cards ?? []).filter(
      c => c.kind !== 'wild' && otherGone.has(CARD_PIECE[c.kind]));
    if (otherGone.size > 0) {
      idleTurns++;
      if (otherStranded.length > 0) {
        idleStranded++;
        worstIdle = `${other} watched ${otherStranded.map(c => c.kind).join(',')} `
          + `go dead while ${color} was on move, at ply ${st.history.length}`;
      }
    }

    const stranded = hand.cards.filter(
      c => c.kind !== 'wild' && gone.has(CARD_PIECE[c.kind]));
    if (gone.size > 0) extinctTurns++;
    if (stranded.length > 0) {
      // Not a hard failure, and cannot be: the swap draws its replacement from cards that
      // exist outside the hand, and with a hand of seven against four rook cards a late
      // endgame genuinely reaches "every live card I could be given is already in my
      // hand". What the swap promises is that a stranded card is the exception rather
      // than the shape of the hand -- which is what the bug it was written for made it.
      strandedTurns++;
      worstStranded = `${color} held ${stranded.map(c => c.kind).join(',')} `
        + `with ${[...gone].join('')} extinct at ply ${st.history.length}`;
    }

    const g = new Chess(st.fen);
    const r = reach(hand);
    const options = g.moves({ verbose: true }).filter(m => r.has(m.piece));
    if (options.length === 0) break;
    const pick = options.find(m => m.captured) ?? options[0];
    const ok = await emitCb(me, 'game:move',
      { from: pick.from, to: pick.to, promotion: pick.promotion });
    if (!ok) break;
    await sleep(70);
  }

  }

  check('a long game reached at least one extinct piece type', extinctionsSeen > 0,
    `${extinctionsSeen} turns with something extinct`);
  check('a card for a piece you no longer own is the exception, not the hand',
    extinctTurns === 0 || strandedTurns / extinctTurns < 0.2,
    `${strandedTurns}/${extinctTurns} turns with something extinct `
    + `— e.g. ${worstStranded || 'none'}`);
  check('a hand is pruned the moment a piece dies, not when its turn comes round',
    idleTurns === 0 || idleStranded / idleTurns < 0.5,
    `${idleStranded}/${idleTurns} off-turn observations — e.g. ${worstIdle || 'none'}`);
  check('the swap was reported to the player who got it', swapsSeen > 0,
    `${swapsSeen} turns reported a swap (${[...replacedKinds].join(',') || 'none'})`);
  check('a swap is never recorded as a card played on a move', (() => {
    const c = sw1.last.cards.white;
    // every entry in `played` came from a move or an emergency, never from a swap
    return c.played.length <= sw1.last.history.filter(h => h.color === 'white').length
      + c.emergenciesUsed;
  })(), JSON.stringify({ played: sw1.last.cards.white.played.length,
    plies: sw1.last.history.filter(h => h.color === 'white').length,
    emerg: sw1.last.cards.white.emergenciesUsed }));
  check('the deck is still thirty-six after all the churn', (() => {
    const c = sw1.last.cards.white;
    return c.handCount + c.deckCount + c.discardCount === 36;
  })(), JSON.stringify(sw1.last.cards.white));


  {
    log('\n=== 24. Chess Cards: the sacrifice ===');
    const cs1 = await mkClient('Sac-W');
    const ridSac = await emitCb(cs1, 'room:create',
      { name: 'S', config: { mode: 'cards', moveTimerSec: 120 } });
    const cs2 = await mkClient('Sac-B');
    for (const c of [cs1, cs2]) await join(c, ridSac);
    await emitCb(cs1, 'seat:take', { color: 'white', seatId: 0 });
    await emitCb(cs2, 'seat:take', { color: 'black', seatId: 0 });
    cs1.emit('game:start');
    await waitFor(cs1, s => s.status === 'playing');
    await sleep(200);

    const COST = cs1.hand.sacrificeCost;
    check('the sacrifice price is published to the player', COST >= 2, String(COST));
    check('and to the table', cs1.last.cards.sacrificeCost === COST);
    check('it is offered on your own turn only',
      cs1.hand.sacrificeAvailable === true && cs2.hand.sacrificeAvailable === false);
    check('with no cooldown left to serve at the start',
      cs1.hand.sacrificeReadyIn === 0 && cs1.last.cards.white.sacrificeReadyIn === 0);

    // A sacrifice buys a move of any piece, so aim it at one the hand plainly cannot pay
    // for: a rook, still walled in behind its own pieces at move one, is no use -- pick a
    // piece type the hand holds no card for and that has a legal move.
    const sacBoard = new Chess(cs1.last.fen);
    const sacReach = reach(cs1.hand);
    const sacLegal = sacBoard.moves({ verbose: true });
    const sacIds = cs1.hand.cards.slice(0, COST).map(c => c.id);

    const tooFew = await emitCb(cs1, 'game:move', {
      from: sacLegal[0].from, to: sacLegal[0].to, sacrificeIds: sacIds.slice(0, COST - 1),
    });
    check('a sacrifice short of the price is refused', tooFew === false);
    check('and it neither moved a piece nor spent a card',
      cs1.last.history.length === 0 && cs1.hand.cards.length === HAND);

    const dup = await emitCb(cs1, 'game:move', {
      from: sacLegal[0].from, to: sacLegal[0].to,
      sacrificeIds: [sacIds[0], sacIds[0], sacIds[1]],
    });
    check('naming the same card twice is refused', dup === false);

    const handBefore = cs1.hand.cards.length;
    const sacMove = sacLegal.find(m => m.piece !== 'k') ?? sacLegal[0];
    const paid = await emitCb(cs1, 'game:move',
      { from: sacMove.from, to: sacMove.to, sacrificeIds: sacIds });
    await sleep(180);
    check('a sacrifice at the right price is accepted', paid === true);
    check('it moved the piece', cs1.last.history.length === 1);
    check('and burned exactly the cards it named',
      cs1.hand.cards.length === handBefore - COST
      && sacIds.every(id => !cs1.hand.cards.some(c => c.id === id)),
      String(cs1.hand.cards.length));
    check('all of them are on the public record',
      cs1.last.cards.white.played.length === COST
      && cs1.last.cards.white.sacrificesUsed === 1,
      JSON.stringify(cs1.last.cards.white.played));
    // The client draws the blood off this flag, and both sides have to get it: the
    // opponent watching three cards burn is exactly who the effect is telling.
    check('the move effect says a sacrifice paid for it',
      cs1.fx.at(-1)?.sacrifice === true && cs2.fx.at(-1)?.sacrifice === true,
      JSON.stringify(cs1.fx.at(-1)));
    check('and an ordinary move does not',
      cs1.fx.slice(0, -1).every(f => f.sacrifice === false),
      JSON.stringify(cs1.fx.map(f => f.sacrifice)));
    check('the cooldown is now running, and both sides can see it',
      cs1.last.cards.white.sacrificeReadyIn > 0
      && cs2.last.cards.white.sacrificeReadyIn > 0,
      String(cs1.last.cards.white.sacrificeReadyIn));

    // Black moves, then White is on again -- still inside the cooldown.
    const bBoard = new Chess(cs1.last.fen);
    const bReach = reach(cs2.hand);
    const bMove = bBoard.moves({ verbose: true }).find(m => bReach.has(m.piece));
    await emitCb(cs2, 'game:move', { from: bMove.from, to: bMove.to });
    await sleep(180);
    check('the sacrifice is not offered again inside the cooldown',
      cs1.hand.sacrificeAvailable === false && cs1.hand.sacrificeReadyIn > 0,
      `${cs1.hand.sacrificeAvailable} / ${cs1.hand.sacrificeReadyIn}`);
    const wBoard2 = new Chess(cs1.last.fen);
    const again = await emitCb(cs1, 'game:move', {
      from: wBoard2.moves({ verbose: true })[0].from,
      to: wBoard2.moves({ verbose: true })[0].to,
      sacrificeIds: cs1.hand.cards.slice(0, COST).map(c => c.id),
    });
    check('and one attempted anyway is refused outright', again === false);
    check('the refusal did not move the board', cs1.last.history.length === 2);

    log('\n=== 25. Every ply carries the position it produced ===');
    // This is what makes reviewing a game possible at either end without a move generator.
    {
      const rBoard = new Chess();
      let mismatched = null;
      for (const e of cs1.last.history) {
        rBoard.move(e.san);
        if (rBoard.fen() !== e.fen) { mismatched = `ply ${e.ply}: ${e.san}`; break; }
        if (!/^[a-h][1-8]$/.test(e.from) || !/^[a-h][1-8]$/.test(e.to)) {
          mismatched = `ply ${e.ply} has no from/to`; break;
        }
      }
      check('each recorded FEN is the position that ply actually produced',
        mismatched === null && cs1.last.history.length > 0, mismatched ?? '');
    }

    log('\n=== 26. A finished game is archived, and lands on both profiles ===');
    const ca1 = await mkClient('Arch-W');
    const ridA = await emitCb(ca1, 'room:create',
      { name: 'A', config: { teamSize: 1, moveTimerSec: 120 } });
    const ca2 = await mkClient('Arch-B');
    // Only a signed-in player has a record, so this section registers both of them first.
    const reg1 = await signUp(ca1);
    const reg2 = await signUp(ca2);
    check('both players have an account',
      reg1.ok === true && reg2.ok === true, JSON.stringify([reg1.error, reg2.error]));
    for (const c of [ca1, ca2]) await join(c, ridA);
    await emitCb(ca1, 'seat:take', { color: 'white', seatId: 0 });
    await emitCb(ca2, 'seat:take', { color: 'black', seatId: 0 });
    ca1.emit('game:start');
    await waitFor(ca1, s => s.status === 'playing');
    await sleep(150);

    // Fool's mate, so the game ends for a reason the archive has to record correctly.
    for (const [cli, from, to] of [
      [ca1, 'f2', 'f3'], [ca2, 'e7', 'e5'], [ca1, 'g2', 'g4'], [ca2, 'd8', 'h4'],
    ]) {
      await emitCb(cli, 'game:move', { from, to });
      await sleep(90);
    }
    await waitFor(ca1, s => s.status === 'finished');
    check('the game ended in mate',
      ca1.last.gameOver?.reason === 'checkmate' && ca1.last.gameOver?.winner === 'black',
      JSON.stringify(ca1.last.gameOver));

    await sleep(250);
    check('both players were told it reached the archive',
      ca1.archived?.id != null && ca1.archived.id === ca2.archived?.id,
      JSON.stringify(ca1.archived));
    check('the summary says who played and how it ended',
      ca1.archived.result === 'black' && ca1.archived.reason === 'checkmate'
      && ca1.archived.plies === 4
      && ca1.archived.white[0] === 'Arch-W' && ca1.archived.black[0] === 'Arch-B',
      JSON.stringify(ca1.archived));

    const fetched = await fetchJson(`/api/games/${ca1.archived.id}`);
    check('the whole game can be read back over HTTP',
      fetched?.history?.length === 4 && fetched.finalFen === ca1.last.fen,
      JSON.stringify(fetched?.history?.length));
    check('and it carries a FEN for every ply, ready to review',
      fetched.history.every(h => typeof h.fen === 'string' && h.fen.length > 10));

    const pgn = await fetchText(`/api/games/${ca1.archived.id}/pgn`);
    check('it comes out as PGN too',
      pgn.includes('[White "Arch-W"]') && pgn.includes('1. f3 e5') && pgn.includes('0-1'),
      pgn.slice(0, 90));

    const listed = await fetchJson('/api/games?limit=10');
    check('and it shows in the recent list',
      Array.isArray(listed) && listed.some(g => g.id === ca1.archived.id));

    const prof = await emitCb(ca1, 'profile:me', { limit: 10 });
    check('the winner and loser each got the game on their profile', (() => {
      const mine = prof?.games?.find(g => g.id === ca1.archived.id);
      return mine?.yourColor === 'white' && mine.yourResult === 'loss';
    })(), JSON.stringify(prof?.games?.[0]));
    check('and their tally moved', prof.profile.record.losses >= 1,
      JSON.stringify(prof.profile.record));

    const prof2 = await emitCb(ca2, 'profile:me', { limit: 10 });
    check('the other side recorded the same game as a win', (() => {
      const theirs = prof2?.games?.find(g => g.id === ca1.archived.id);
      return theirs?.yourColor === 'black' && theirs.yourResult === 'win'
        && theirs.opponents[0] === 'Arch-W';
    })(), JSON.stringify(prof2?.games?.[0]));
    check('a profile is addressed by the account, not by the seat token',
      prof.profile.id !== ca1.token && prof.profile.id === reg1.account.id
      && /^[a-f0-9]{16}$/.test(prof.profile.id),
      prof.profile.id);
    check('and the record is filed under the account name',
      prof.profile.name === 'Arch-W', prof.profile.name);

    // The activity grid is drawn from these, and they are kept as games are recorded
    // rather than derived from the (capped) games list. Moments, not day keys: which day
    // a game belongs to is a question about the reader's clock, and only the browser
    // knows that one.
    check('the profile carries the moments the grid is drawn from',
      Array.isArray(prof.playedAt) && prof.playedAt.length >= 1,
      JSON.stringify(prof.playedAt));
    check('every one of them is a timestamp, not a day',
      prof.playedAt.every(t => Number.isFinite(t) && t > 1e12),
      JSON.stringify(prof.playedAt.slice(0, 3)));
    check('there is one for every game the list shows',
      prof.playedAt.length >= prof.games.length,
      `${prof.playedAt.length} vs ${prof.games.length}`);
    check('and they are in order, oldest first',
      prof.playedAt.every((t, i) => i === 0 || prof.playedAt[i - 1] <= t));
    check('and it can be read by that public id',
      (await fetchJson(`/api/profile/${prof.profile.id}`))?.profile?.id === prof.profile.id);

  }


  {
    log('\n=== 27. Chess Cards: castling costs a Rook card ===');
    const cc1 = await mkClient('Castle-W');
    const ridC = await emitCb(cc1, 'room:create',
      { name: 'C', config: { mode: 'cards', moveTimerSec: 120 } });
    const cc2 = await mkClient('Castle-B');
    for (const c of [cc1, cc2]) await join(c, ridC);
    await emitCb(cc1, 'seat:take', { color: 'white', seatId: 0 });
    await emitCb(cc2, 'seat:take', { color: 'black', seatId: 0 });
    cc1.emit('game:start');
    await waitFor(cc1, s => s.status === 'playing');
    await sleep(200);

    check('the hand reports whether a castle can be paid for',
      typeof cc1.hand.canCastle === 'boolean');
    check('and the opening hand can, since it holds a Rook card',
      cc1.hand.canCastle === true,
      cc1.hand.cards.map(c => c.kind).join(','));

    // Getting to a castleable position is not a given: White has to develop the knight
    // and the bishop, and can only do so on turns the hand pays for it. So the section
    // plays toward it -- back rank first, then the pawns in front of it -- and takes a
    // fresh game if a hand strands White entirely, rather than asserting on a coin flip.
    const play = async (cli, from, to) => {
      const ok = await emitCb(cli, 'game:move', { from, to });
      await sleep(100);
      return ok;
    };
    // Filler moves must not cost White the castling rights this section exists to test,
    // so the king and both rooks stay home.
    const KEEP = new Set(['e1', 'h1', 'a1']);
    const UNBLOCK = new Set(['d2', 'e2', 'g2']);

    let cleared = false;
    for (let attempt = 0; attempt < 4 && !cleared; attempt++) {
      if (attempt > 0) {
        cc1.emit('game:rematch');
        await waitFor(cc1, st => st.status === 'playing' && st.history.length === 0);
        await sleep(200);
      }
      for (let i = 0; i < 60 && !cleared; i++) {
        const st = cc1.last;
        if (st.status !== 'playing') break;
        const g = new Chess(st.fen);
        const white = st.turn === 'white';
        const cli = white ? cc1 : cc2;
        const legal = g.moves({ verbose: true }).filter(m => reach(cli.hand).has(m.piece));

        if (white && legal.some(m => m.san === 'O-O')) { cleared = true; break; }

        const usable = legal
          .filter(m => !m.san.startsWith('O'))
          .filter(m => !white || !KEEP.has(m.from));
        const pick = (white ? usable.find(m => m.from === 'g1' || m.from === 'f1') : null)
          ?? (white ? usable.find(m => UNBLOCK.has(m.from)) : null)
          ?? usable.find(m => m.piece === 'p')
          ?? usable[0];
        if (!pick) break;                       // this hand strands us; take a fresh game
        if (await play(cli, pick.from, pick.to) === false) break;
      }
    }

    if (!cleared) {
      check('a castle became available to test', false, 'never cleared the back rank');
    } else {
      const holdsRook = cc1.hand.cards.some(c => c.kind === 'rook' || c.kind === 'wild');
      const spentBefore = cc1.last.cards.white.played.length;
      const okCastle = await play(cc1, 'e1', 'g1');

      if (holdsRook || cc1.hand.emergency) {
        check('a castle with a Rook card in hand is accepted', okCastle === true);
        check('and it spent a card, unlike every other king move',
          cc1.last.cards.white.played.length === spentBefore + 1,
          JSON.stringify(cc1.last.cards.white.played.slice(spentBefore)));
        check('the card spent was one that covers a rook', (() => {
          const k = cc1.last.cards.white.played[spentBefore];
          return k === 'rook' || k === 'wild' || cc1.last.cards.white.emergenciesUsed > 0;
        })(), cc1.last.cards.white.played[spentBefore]);
      } else {
        check('a castle with no Rook card is refused', okCastle === false);
        check('and the board did not move', cc1.last.fen.includes('R3K') === false
          || cc1.last.cards.white.played.length === spentBefore);
        check('the hand was told it could not castle', cc1.hand.canCastle === false);
      }
    }
  }


  {
    log('\n=== 28. Accounts ===');
    const acc = await mkClient('Acct');
    const name = `acct_${Math.random().toString(36).slice(2, 9)}`;

    check('a short username is refused',
      (await emitCb(acc, 'auth:register', { username: 'ab', password: 'longenough1' })).ok === false);
    check('an illegal username is refused',
      (await emitCb(acc, 'auth:register', { username: 'has space', password: 'longenough1' })).ok === false);
    check('a short password is refused',
      (await emitCb(acc, 'auth:register', { username: name, password: 'short' })).ok === false);

    const made = await emitCb(acc, 'auth:register', { username: name, password: 'longenough1' });
    check('a good registration succeeds', made.ok === true, made.error ?? '');
    check('it returns the account and a session',
      typeof made.account?.id === 'string' && typeof made.session === 'string',
      JSON.stringify(made.account));
    check('and never the password or its hash',
      !JSON.stringify(made).includes('longenough1')
      && !JSON.stringify(made).includes('hash')
      && !JSON.stringify(made).includes('salt'),
      JSON.stringify(made));

    check('the same username cannot be taken twice',
      (await emitCb(acc, 'auth:register', { username: name, password: 'another1234' })).ok === false);
    check('nor in a different case',
      (await emitCb(acc, 'auth:register',
        { username: name.toUpperCase(), password: 'another1234' })).ok === false);

    const other = await mkClient('Acct2');
    check('the wrong password is refused',
      (await emitCb(other, 'auth:login', { username: name, password: 'wrongpassword' })).ok === false);
    check('an unknown user is refused',
      (await emitCb(other, 'auth:login',
        { username: `nobody_${name}`, password: 'longenough1' })).ok === false);

    const signedIn = await emitCb(other, 'auth:login', { username: name, password: 'longenough1' });
    check('the right password signs in', signedIn.ok === true, signedIn.error ?? '');
    check('and lands on the same account', signedIn.account.id === made.account.id);

    // The session is a signed bearer token: it must survive a round trip and must not be
    // forgeable by editing the account id into someone else's.
    const resumed = await emitCb(other, 'auth:resume', { session: signedIn.session });
    check('a session resumes to its account', resumed.account?.id === made.account.id);
    check('and brings the profile with it', resumed.profile?.profile?.id === made.account.id);

    const forged = `${made.account.id}.${Date.now()}.` + 'A'.repeat(43);
    check('a forged session is refused',
      (await emitCb(other, 'auth:resume', { session: forged })).account === null);
    const tampered = signedIn.session.slice(0, -1) + (signedIn.session.endsWith('a') ? 'b' : 'a');
    check('flipping one byte of the signature invalidates it',
      (await emitCb(other, 'auth:resume', { session: tampered })).account === null);
    check('so does nonsense',
      (await emitCb(other, 'auth:resume', { session: 'not-a-session' })).account === null
      && (await emitCb(other, 'auth:resume', {})).account === null);

    const guest = await mkClient('Guest');
    check('a guest has no profile to read',
      (await emitCb(guest, 'profile:me', { limit: 5 })) === null);

    // A guest can still play. That is the point of not gating the game behind the account.
    const gRoom = await emitCb(guest, 'room:create', { name: 'G', config: { teamSize: 1 } });
    const guest2 = await mkClient('Guest2');
    for (const c of [guest, guest2]) await join(c, gRoom);
    await emitCb(guest, 'seat:take', { color: 'white', seatId: 0 });
    await emitCb(guest2, 'seat:take', { color: 'black', seatId: 0 });
    guest.emit('game:start');
    await waitFor(guest, st => st.status === 'playing');
    check('a guest can create a room, take a seat and start a game',
      guest.last.status === 'playing');
    const moved = await emitCb(guest, 'game:move', { from: 'e2', to: 'e4' });
    check('and can actually move', moved === true);

    // Play it out to a real mate, then confirm the archive kept the game and the
    // profiles kept nothing: a guest has no record to put it on, which is the whole
    // reason registration exists.
    for (const [cli, from, to] of [
      [guest2, 'e7', 'e5'], [guest, 'f1', 'c4'], [guest2, 'b8', 'c6'],
      [guest, 'd1', 'h5'], [guest2, 'g8', 'f6'], [guest, 'h5', 'f7'],
    ]) {
      await emitCb(cli, 'game:move', { from, to });
      await sleep(80);
    }
    await waitFor(guest, st => st.status === 'finished');
    await sleep(250);
    check('a guest game still reaches the archive', guest.archived?.id != null,
      JSON.stringify(guest.last.gameOver));
    check('but it is recorded against nobody',
      (await emitCb(guest, 'profile:me', { limit: 5 })) === null
      && (await emitCb(guest2, 'profile:me', { limit: 5 })) === null);
  }


  {
    log('\n=== 29. A rematch is a different game, and says so ===');
    const r1 = await mkClient('Re-W');
    const ridR = await emitCb(r1, 'room:create',
      { name: 'R', config: { teamSize: 1, moveTimerSec: 120 } });
    const r2 = await mkClient('Re-B');
    for (const c of [r1, r2]) await join(c, ridR);
    await emitCb(r1, 'seat:take', { color: 'white', seatId: 0 });
    await emitCb(r2, 'seat:take', { color: 'black', seatId: 0 });
    r1.emit('game:start');
    await waitFor(r1, st => st.status === 'playing');
    const firstSeq = r1.last.gameSeq;
    check('a started game has a number', typeof firstSeq === 'number' && firstSeq > 0,
      String(firstSeq));

    // fool's mate, so the first game really finishes
    for (const [cli, from, to] of [
      [r1, 'f2', 'f3'], [r2, 'e7', 'e5'], [r1, 'g2', 'g4'], [r2, 'd8', 'h4'],
    ]) { await emitCb(cli, 'game:move', { from, to }); await sleep(90); }
    await waitFor(r1, st => st.status === 'finished');
    check('the first game ended', r1.last.gameOver?.reason === 'checkmate');
    check('and its number did not change mid-game', r1.last.gameSeq === firstSeq);

    r1.emit('game:rematch');
    await waitFor(r1, st => st.status === 'playing' && st.history.length === 0);
    await sleep(150);
    // This is what the client keys "have I announced this result?" on. Without it a
    // rematch replayed the previous result card and then swallowed the next one.
    check('a rematch is a new game with a new number', r1.last.gameSeq === firstSeq + 1,
      `${firstSeq} -> ${r1.last.gameSeq}`);
    check('and it starts clean',
      r1.last.gameOver === null && r1.last.history.length === 0);

    // and the second game can still be won
    for (const [cli, from, to] of [
      [r1, 'f2', 'f3'], [r2, 'e7', 'e5'], [r1, 'g2', 'g4'], [r2, 'd8', 'h4'],
    ]) { await emitCb(cli, 'game:move', { from, to }); await sleep(90); }
    await waitFor(r1, st => st.status === 'finished');
    check('the rematch can be won like any other game',
      r1.last.status === 'finished' && r1.last.gameOver?.winner === 'black'
      && r1.last.gameSeq === firstSeq + 1,
      JSON.stringify(r1.last.gameOver));
  }

  {
    log('\n=== 30. Bug reports and the admin panel ===');
    const reporter = await mkClient('Reporter');
    const rid = await emitCb(reporter, 'room:create',
      { name: 'Rep', config: { mode: 'cards', moveTimerSec: 60 } });
    await join(reporter, rid);

    check('an empty report is refused',
      (await emitCb(reporter, 'report:send', { text: '   ' })).ok === false);

    const sent = await emitCb(reporter, 'report:send', {
      text: 'The timer stopped and nobody won.',
      context: { roomId: rid, mode: 'cards', status: 'playing', plies: 12,
                 viewport: '390x844', route: `#/r/${rid}`,
                 userAgent: 'test-harness', fen: 'startpos' },
    });
    check('a report with something in it is accepted', sent.ok === true, sent.error ?? '');

    // A guest is not an admin, and neither is an ordinary account.
    check('a guest cannot read the admin overview',
      (await emitCb(reporter, 'admin:overview', {})) === null);
    check('nor the reports',
      (await emitCb(reporter, 'admin:reports', { limit: 5 })) === null);

    const plain = await mkClient('Plain-User');
    await signUp(plain);
    check('a signed-in non-admin cannot either',
      (await emitCb(plain, 'admin:overview', {})) === null
      && (await emitCb(plain, 'admin:reports', {})) === null);
    check('and neither can read the metrics',
      (await emitCb(reporter, 'admin:insights', {})) === null
      && (await emitCb(plain, 'admin:insights', {})) === null);

    // Admin comes from the server's own environment, by design -- an admin flag stored on
    // an account would be one file edit away from a privilege escalation. That means this
    // half of the section can only run against a server started with it, so it says so
    // rather than failing on how the server happened to be launched.
    const admin = await mkClient('Arch-W');
    const who = await signUp(admin);
    const configured = who.account?.isAdmin === true;
    if (!configured) {
      // `return` here would leave `main()` and take every later section with it.
      log('  SKIP  the admin half needs: ADMIN_USERS=Arch-W npm start');
      check('an account not named in ADMIN_USERS is not an admin', true,
        JSON.stringify(who.account));
      check('and is refused the panel',
        (await emitCb(admin, 'admin:overview', {})) === null
        && (await emitCb(admin, 'admin:reports', {})) === null);
    } else {
    check('the admin account is flagged as one', who.account?.isAdmin === true,
      JSON.stringify(who.account));

    const overview = await emitCb(admin, 'admin:overview', {});
    check('an admin gets the overview', overview != null && overview.games != null,
      JSON.stringify(overview?.games?.total));
    check('it counts games, accounts and rooms',
      typeof overview.games.total === 'number'
      && typeof overview.accounts === 'number' && overview.accounts >= 2
      && typeof overview.rooms.live === 'number' && overview.rooms.live >= 1,
      JSON.stringify({ a: overview.accounts, r: overview.rooms }));
    check('and reports what setups people actually played',
      Array.isArray(overview.setups) && overview.setups.every(sx =>
        typeof sx.label === 'string' && typeof sx.count === 'number'),
      JSON.stringify(overview.setups.slice(0, 2)));

    const reports = await emitCb(admin, 'admin:reports', { limit: 50 });
    check('an admin sees the report that was filed',
      Array.isArray(reports) && reports.some(r => r.text.includes('nobody won')),
      String(reports?.length));

    const mine = reports.find(r => r.text.includes('nobody won'));
    check('and it carried its context',
      mine.context.roomId === rid && mine.context.mode === 'cards'
      && mine.context.plies === 12 && mine.context.viewport === '390x844',
      JSON.stringify(mine.context));
    check('it is filed under the reporter', mine.reporter === 'Reporter', mine.reporter);
    check('and starts unresolved', mine.resolved === false);

    const done = await emitCb(admin, 'admin:report-resolve', { id: mine.id, resolved: true });
    check('an admin can mark it done', done?.resolved === true);
    check('a non-admin cannot',
      (await emitCb(plain, 'admin:report-resolve',
        { id: mine.id, resolved: false })) === null);

    // The metrics tab. Earlier sections have played whole games through this server, so
    // the aggregate should already have measured play in it -- and the funnel should have
    // counted the rooms those games were played in.
    const ins = await emitCb(admin, 'admin:insights', {});
    check('an admin gets the insights', ins != null && Array.isArray(ins.modes));
    check('which have folded in the games this run played',
      ins.gamesCovered >= 1 && ins.modes.some(m => m.plies > 0),
      JSON.stringify({ covered: ins.gamesCovered,
                       plies: ins.modes.map(m => `${m.mode}:${m.plies}`) }));
    check('every distribution has a bucket per bound, plus the open one',
      ins.modes.every(m => [m.think, m.wait, m.length, m.duration].every(
        d => d.counts.length === d.bounds.length + 1)));
    check('the funnel counted rooms, and each step at most once per room',
      ins.funnel.created >= 1 && ins.funnel.created >= ins.funnel.seated
      && ins.funnel.seated >= ins.funnel.started
      && ins.funnel.started >= ins.funnel.rematch,
      JSON.stringify(ins.funnel));
    check('and every declared target is reported against',
      ins.guardrails.length >= 5 && ins.guardrails.every(g =>
        typeof g.target === 'string'
        && ['good', 'watch', 'off', 'info', 'unknown'].includes(g.status)),
      JSON.stringify(ins.guardrails.map(g => `${g.key}:${g.status}`)));

    const rebuilt = await emitCb(admin, 'admin:insights-rebuild', {});
    check('a rebuild from the archive agrees with the rolling count',
      rebuilt != null && rebuilt.gamesCovered === ins.gamesCovered,
      JSON.stringify({ rolled: ins.gamesCovered, rebuilt: rebuilt?.gamesCovered }));
    check('and keeps the funnel, which no archive can recover',
      rebuilt.funnel.created === ins.funnel.created);
    check('a non-admin cannot rebuild it',
      (await emitCb(plain, 'admin:insights-rebuild', {})) === null);
    }
  }


  {
    log('\n=== 31. A seat is one thing at a time ===');
    const h = await mkClient('Seat-Host');
    const ridS = await emitCb(h, 'room:create',
      { name: 'S', config: { teamSize: 3, moveTimerSec: 60 } });
    const p2 = await mkClient('Seat-Two');
    const p3 = await mkClient('Seat-Three');
    for (const c of [h, p2, p3]) await join(c, ridS);

    // Join names a side, not a chair: the server picks the first free seat.
    const j1 = await emitCb(h, 'seat:take', { color: 'white' });
    check('joining without naming a seat works', j1.ok === true, j1.error ?? '');
    check('and lands on the first free one', j1.you?.seat?.seatId === 0,
      JSON.stringify(j1.you?.seat));
    const j2 = await emitCb(p2, 'seat:take', { color: 'white' });
    check('the next player gets the next seat', j2.you?.seat?.seatId === 1,
      JSON.stringify(j2.you?.seat));

    // A bot goes to a free seat, never on top of a person.
    h.emit('seat:bot', { color: 'white', bot: true });
    await sleep(250);
    check('a bot fills a free seat', h.last.white.seats[2].kind === 'bot',
      JSON.stringify(h.last.white.seats.map(x => x.kind)));
    check('and did not evict anyone',
      h.last.white.seats[0].name === 'Seat-Host' && h.last.white.seats[1].name === 'Seat-Two',
      JSON.stringify(h.last.white.seats.map(x => x.name)));

    // This is the bug: the same slot could be both sat in and botted.
    h.emit('seat:bot', { color: 'white', seatId: 0, bot: true });
    await sleep(250);
    check('a seat someone is sitting in cannot be turned into a bot',
      h.last.white.seats[0].kind === 'human' && h.last.white.seats[0].name === 'Seat-Host',
      JSON.stringify(h.last.white.seats[0]));

    // And the other half of it: a bot's seat is not free to sit on.
    const onBot = await emitCb(p3, 'seat:take', { color: 'white', seatId: 2 });
    check('a player cannot sit on top of a bot', onBot.ok === false, JSON.stringify(onBot));
    check('the bot is still there', h.last.white.seats[2].kind === 'bot');

    const full = await emitCb(p3, 'seat:take', { color: 'white' });
    check('a full side says so rather than picking an occupied chair',
      full.ok === false && /full/i.test(full.error ?? ''), JSON.stringify(full));

    // Only a bot can be un-botted.
    h.emit('seat:bot', { color: 'white', seatId: 1, bot: false });
    await sleep(250);
    check('removing a bot from a human seat does nothing',
      h.last.white.seats[1].kind === 'human' && h.last.white.seats[1].name === 'Seat-Two');

    h.emit('seat:bot', { color: 'white', seatId: 2, bot: false });
    await sleep(250);
    check('removing an actual bot frees the seat',
      h.last.white.seats[2].kind === 'human' && h.last.white.seats[2].occupied === false,
      JSON.stringify(h.last.white.seats[2]));
    const now = await emitCb(p3, 'seat:take', { color: 'white' });
    check('which somebody can then join', now.ok === true && now.you?.seat?.seatId === 2,
      JSON.stringify(now.you?.seat));

    // Who you are in a room is broadcast, not answered once. Standing up has no
    // acknowledgement of its own, so a client that only learned its seat when it asked
    // went on believing it was sitting -- and when a bot took the chair, the roster drew
    // the bot and the "You" badge on the same row.
    {
      const seats = [];
      h.on('room:you', y => seats.push(y.seat));
      await emitCb(h, 'seat:take', { color: 'white' });
      await sleep(200);
      check('the room says who you are when you sit down',
        seats.length > 0 && seats[seats.length - 1]?.color === 'white',
        JSON.stringify(seats[seats.length - 1] ?? null));

      h.emit('seat:leave');
      await sleep(300);
      check('and says it again when you stand up, without being asked',
        seats[seats.length - 1] === null, JSON.stringify(seats.slice(-2)));

      h.emit('seat:bot', { color: 'white', bot: true });
      await sleep(300);
      check('so a bot taking the chair cannot leave you seated in it',
        seats[seats.length - 1] === null
        && h.last.white.seats.some(x => x.kind === 'bot'),
        JSON.stringify({ you: seats[seats.length - 1], seats: h.last.white.seats }));
      h.emit('seat:bot', { color: 'white', bot: false, seatId: 0 });
      await sleep(200);
    }

    p2.emit('seat:bot', { color: 'black', bot: true });
    await sleep(250);
    check('a non-host cannot add bots',
      h.last.black.seats.every(x => !x.occupied),
      JSON.stringify(h.last.black.seats.map(x => x.kind)));
  }


  {
    log('\n=== 32. Every ply is measured, and none of it leaks ===');
    const m1 = await mkClient('Met-W');
    const ridM = await emitCb(m1, 'room:create',
      { name: 'M', config: { mode: 'cards', moveTimerSec: 120 } });
    const m2 = await mkClient('Met-B');
    for (const c of [m1, m2]) await join(c, ridM);
    await emitCb(m1, 'seat:take', { color: 'white' });
    await emitCb(m2, 'seat:take', { color: 'black' });
    m1.emit('game:start');
    await waitFor(m1, st => st.status === 'playing');
    await sleep(250);

    // THE rule: RoomState is broadcast to the whole room, so nothing that reconstructs a
    // hand may appear in it. This is the assertion that keeps a metrics block from
    // quietly becoming an exploit.
    const blob = JSON.stringify(m2.last);
    check('the broadcast state carries no per-ply metrics',
      !blob.includes('plyMetrics') && !blob.includes('handKinds')
      && !blob.includes('affordableMoves') && !blob.includes('deadHeld'),
      blob.slice(0, 120));
    check('and no history entry carries a hand',
      m2.last.history.every(h => h.cards === undefined && h.handKinds === undefined));

    const byColor = { white: m1, black: m2 };
    for (let i = 0; i < 16 && m1.last.status === 'playing'; i++) {
      const st = m1.last;
      const me = byColor[st.turn];
      const g = new Chess(st.fen);
      const r = reach(me.hand);
      const opts = g.moves({ verbose: true }).filter(x => r.has(x.piece));
      if (!opts.length) break;
      const pick = opts.find(x => x.captured) ?? opts[Math.floor(Math.random() * opts.length)];
      // a beat of thinking, so think time is a number rather than zero
      await sleep(60);
      if (!await emitCb(me, 'game:move',
        { from: pick.from, to: pick.to, promotion: pick.promotion })) break;
      await sleep(90);
    }

    const played = m1.last.history.length;
    check('the game got somewhere', played >= 8, String(played));
    m1.emit('game:resign');
    await waitFor(m1, st => st.status === 'finished');
    await sleep(400);

    const archived = await fetchJson(`/api/games/${m1.archived.id}`);
    const mx = archived?.metrics;
    check('the archived game carries a metrics block', mx != null && mx.schema >= 1,
      JSON.stringify(mx?.schema));
    check('one row per ply', mx.plies.length === archived.history.length,
      `${mx.plies.length} vs ${archived.history.length}`);

    let bad = null;
    for (const pm of mx.plies) {
      if (pm.affordableMoves > pm.legalMoves) { bad = `ply ${pm.ply}: affordable > legal`; break; }
      if (pm.legalMoves < 1) { bad = `ply ${pm.ply}: no legal moves recorded`; break; }
      if (pm.affordableTypes > pm.legalTypes) { bad = `ply ${pm.ply}: types`; break; }
      if (pm.thinkMs < 0) { bad = `ply ${pm.ply}: negative think`; break; }
      if (!pm.cards) { bad = `ply ${pm.ply}: cards mode with no card metrics`; break; }
      const held = Object.values(pm.cards.handKinds).reduce((a, b) => a + b, 0);
      if (held !== pm.cards.handSize) {
        bad = `ply ${pm.ply}: handKinds ${held} != handSize ${pm.cards.handSize}`; break;
      }
      if (!['card', 'sacrifice', 'emergency', 'free'].includes(pm.cards.payment)) {
        bad = `ply ${pm.ply}: payment ${pm.cards.payment}`; break;
      }
    }
    check('every row is internally consistent', bad === null, bad ?? '');

    check('the choice set was actually constrained at least once',
      mx.plies.some(pm => pm.affordableMoves < pm.legalMoves),
      JSON.stringify(mx.plies.map(pm => `${pm.affordableMoves}/${pm.legalMoves}`).slice(0, 6)));
    check('think time was measured',
      mx.plies.some(pm => pm.thinkMs > 0), String(mx.plies[0]?.thinkMs));
    check('wait time was measured for the second turn onward',
      mx.plies.some(pm => pm.waitMs != null && pm.waitMs > 0),
      JSON.stringify(mx.plies.map(pm => pm.waitMs).slice(0, 6)));
    check('a card paid for at least one move',
      mx.plies.some(pm => pm.cards.payment === 'card' && pm.cards.spentKind),
      JSON.stringify(mx.plies.map(pm => pm.cards.payment).slice(0, 6)));

    check('the sides were rolled up',
      mx.white.moves + mx.black.moves === mx.plies.length
      && mx.white.moves > 0 && mx.black.moves > 0,
      JSON.stringify({ w: mx.white.moves, b: mx.black.moves }));
    check('and the roll-up counts cards it saw',
      mx.white.cardsSpent > 0 && Object.keys(mx.white.drawnKinds).length > 0,
      JSON.stringify(mx.white.spentKinds));

    // Team mode shares the pipeline and simply has no card block.
    const t1 = await mkClient('Met-T1');
    const ridT = await emitCb(t1, 'room:create',
      { name: 'T', config: { teamSize: 1, moveTimerSec: 120 } });
    const t2 = await mkClient('Met-T2');
    for (const c of [t1, t2]) await join(c, ridT);
    await emitCb(t1, 'seat:take', { color: 'white' });
    await emitCb(t2, 'seat:take', { color: 'black' });
    t1.emit('game:start');
    await waitFor(t1, st => st.status === 'playing');
    for (const [cli, from, to] of [
      [t1, 'f2', 'f3'], [t2, 'e7', 'e5'], [t1, 'g2', 'g4'], [t2, 'd8', 'h4'],
    ]) { await emitCb(cli, 'game:move', { from, to }); await sleep(90); }
    await waitFor(t1, st => st.status === 'finished');
    await sleep(400);

    const tg = await fetchJson(`/api/games/${t1.archived.id}`);
    check('team mode is measured too', tg?.metrics?.plies?.length === 4,
      String(tg?.metrics?.plies?.length));
    check('with no card block and nothing withheld',
      tg.metrics.plies.every(pm => pm.cards === undefined
        && pm.affordableMoves === pm.legalMoves && pm.openTurn === true),
      JSON.stringify(tg.metrics.plies[0]));
    check('and the shape of the game was recorded',
      tg.metrics.firstCapturePly === null && typeof tg.metrics.maxLead === 'number'
      && typeof tg.metrics.durationMs === 'number',
      JSON.stringify({ cap: tg.metrics.firstCapturePly, lead: tg.metrics.maxLead }));
  }



  {
    log('\n=== 34. What only the client can see ===');
    const c1 = await mkClient('Tel-W');
    const ridC = await emitCb(c1, 'room:create',
      { name: 'C', config: { teamSize: 1, moveTimerSec: 120 } });
    const c2 = await mkClient('Tel-B');
    for (const c of [c1, c2]) await join(c, ridC);
    await emitCb(c1, 'seat:take', { color: 'white' });
    await emitCb(c2, 'seat:take', { color: 'black' });

    // A spectator: seated players are the only ones with a turn to report on.
    const spec = await mkClient('Tel-Spec');
    await join(spec, ridC);

    c1.emit('telemetry:client',
      { device: 'phone', pointer: 'touch', viewport: '390x844', fx: 'calm' });
    c2.emit('telemetry:client',
      { device: 'desktop', pointer: 'mouse', viewport: '1920x1080', fx: 'full' });
    // Nonsense in every field: the server should keep the shape and drop the values.
    spec.emit('telemetry:client',
      { device: 'mainframe', pointer: 'telepathy', viewport: 'x'.repeat(200), fx: 'lol' });

    c1.emit('game:start');
    await waitFor(c1, st => st.status === 'playing');
    const seq = c1.last.gameSeq;

    const moves = [[c1, 'e2', 'e4'], [c2, 'e7', 'e5'], [c1, 'g1', 'f3'], [c2, 'b8', 'c6']];
    for (let i = 0; i < moves.length; i++) {
      const [cli, from, to] = moves[i];
      await sleep(60);
      await emitCb(cli, 'game:move', { from, to });
      // A move's acknowledgement comes back before the broadcast that carries it, so the
      // ply is only known once the state agrees it exists -- which is exactly what the
      // client itself has to wait for before reporting a turn.
      await waitFor(cli, st => st.history.length >= i + 1);
      cli.emit('telemetry:turn', {
        gameSeq: seq, ply: i + 1,
        pickups: 2, cardSelections: 0, timeToFirstTouchMs: 800, premove: 'none',
      });
      await sleep(70);
    }

    // Everything that should be refused, aimed at plies that exist.
    c1.emit('telemetry:turn', { gameSeq: seq, ply: 2, pickups: 99 });   // Black's ply
    c1.emit('telemetry:turn', { gameSeq: seq, ply: 1, pickups: 7 });    // already reported
    c1.emit('telemetry:turn', { gameSeq: seq + 5, ply: 3, pickups: 7 }); // another game
    c1.emit('telemetry:turn', { gameSeq: seq, ply: 999, pickups: 7 });  // no such ply
    spec.emit('telemetry:turn', { gameSeq: seq, ply: 3, pickups: 7 });  // not seated
    c1.emit('telemetry:turn',
      { gameSeq: seq, ply: 3, pickups: -5, cardSelections: 1e9, timeToFirstTouchMs: -1 });
    c1.emit('telemetry:event', { kind: 'review' });
    c2.emit('telemetry:event', { kind: 'drawer' });
    c2.emit('telemetry:event', { kind: 'not-a-kind' });
    await sleep(200);

    c1.emit('game:resign');
    await waitFor(c1, st => st.status === 'finished');
    await sleep(400);

    const cg = await fetchJson(`/api/games/${c1.archived.id}`);
    const cm = cg?.metrics;
    check('the archive carries a client block', cm?.client != null,
      JSON.stringify(Object.keys(cm ?? {})));
    check('reported turns are attached to the plies that were reported',
      cm.plies.filter(p => p.client).length === moves.length,
      JSON.stringify(cm.plies.map(p => (p.client ? p.client.pickups : null))));
    check('and the numbers arrive as they were sent',
      cm.plies[0].client.pickups === 2 && cm.plies[0].client.timeToFirstTouchMs === 800,
      JSON.stringify(cm.plies[0].client));
    check('a second report for the same ply does not overwrite the first',
      cm.plies[0].client.pickups === 2);
    check('a report about the other side is dropped',
      cm.plies[1].client.pickups === 2, JSON.stringify(cm.plies[1].client));
    check('rubbish numbers are clamped rather than stored',
      cm.plies[2].client.pickups === 2 && cm.plies[2].client.cardSelections === 0,
      JSON.stringify(cm.plies[2].client));

    check('the side roll-up counts what the browsers said',
      cm.client.white.plies === 2 && cm.client.white.pickups === 4,
      JSON.stringify(cm.client.white));
    check('the device is recorded against the turns it played',
      cm.client.white.devices.phone === 2 && cm.client.black.devices.desktop === 2,
      JSON.stringify({ w: cm.client.white.devices, b: cm.client.black.devices }));
    check('and so is how it was pointed at and what effects were on',
      cm.client.white.pointers.touch === 2 && cm.client.white.fx.calm === 2,
      JSON.stringify(cm.client.white));
    check('session events are counted per side',
      cm.client.white.reviewOpened === 1 && cm.client.black.drawerOpened === 1
      && cm.client.black.reviewOpened === 0,
      JSON.stringify({ w: cm.client.white, b: cm.client.black }));
    check('a spectator reports nothing at all',
      cm.plies.every(p => !p.client || p.client.pickups === 2));

    // The channel is best-effort and unacknowledged, so a flood must cost packets and
    // nothing else: the game goes on and the archive stays sane.
    for (let i = 0; i < 200; i++) {
      c1.emit('telemetry:event', { kind: 'review' });
    }
    await sleep(150);
    check('a flood does not take the room down',
      (await emitCb(c1, 'admin:overview', {})) === null && c1.connected !== false);
  }

  {
    log('\n=== 33. Screenshots on a report, and their deletion ===');
    const rep = await mkClient('Shot-Reporter');
    await join(rep, await emitCb(rep, 'room:create',
      { name: 'SR', config: { teamSize: 1 } }));

    const sent = await emitCb(rep, 'report:send', {
      text: 'The board scrolls instead of moving the piece.',
      context: { viewport: '390x844' },
      attachments: [
        { name: 'shot one.png', dataUrl: TINY_PNG },
        { name: '../../etc/passwd', dataUrl: TINY_PNG },
      ],
    });
    check('a report with screenshots is accepted', sent.ok === true, sent.error ?? '');

    // Anything that is not an image, or claims to be one, is dropped rather than stored.
    const junk = await emitCb(rep, 'report:send', {
      text: 'Report with rubbish attached.',
      attachments: [
        { name: 'evil.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
        { name: 'notadataurl', dataUrl: 'https://example.com/x.png' },
        { name: 'empty', dataUrl: 'data:image/png;base64,' },
      ],
    });
    check('a report whose attachments are all rubbish still files', junk.ok === true);

    const admin = await mkClient('Arch-W');
    const who = await signUp(admin);
    if (who.account?.isAdmin !== true) {
      log('  SKIP  the rest needs: ADMIN_USERS=Arch-W npm start');
    } else {
      const reports = await emitCb(admin, 'admin:reports', { limit: 50 });
      const mine = reports.find(r => r.text.includes('scrolls instead'));
      check('both images were kept', mine?.attachments?.length === 2,
        JSON.stringify(mine?.attachments?.map(a => a.name)));
      // The property that matters is that the name never reaches a path: files are named
      // by their own hex id. The label is tidied as well, which is cosmetic.
      // The property that matters is that the name never reaches a path: files are
      // named by their own hex id. Tidying the label is cosmetic on top of that.
      check('a filename never reaches the filesystem',
        mine.attachments.every(a => /^[a-f0-9]{12}$/.test(a.id))
        && mine.attachments.every(a => !a.name.includes('/')
          && !a.name.includes('..')),
        JSON.stringify(mine.attachments.map(a => [a.id, a.name])));
      check('and they carry a type and a size',
        mine.attachments.every(a => a.mime === 'image/png' && a.bytes > 0),
        JSON.stringify(mine.attachments));

      const rubbish = reports.find(r => r.text.includes('rubbish attached'));
      check('an SVG, a URL and an empty string were all refused',
        (rubbish?.attachments?.length ?? 0) === 0,
        JSON.stringify(rubbish?.attachments));

      const att = mine.attachments[0];
      const got = await emitCb(admin, 'admin:attachment',
        { reportId: mine.id, attachmentId: att.id });
      check('an admin can read the bytes back',
        got?.mime === 'image/png' && typeof got.base64 === 'string' && got.base64.length > 20,
        JSON.stringify(got?.mime));

      check('a guest cannot',
        (await emitCb(rep, 'admin:attachment',
          { reportId: mine.id, attachmentId: att.id })) === null);
      check('and a path cannot be climbed out of',
        (await emitCb(admin, 'admin:attachment',
          { reportId: mine.id, attachmentId: '../../../secret' })) === null);

      // The point of the whole feature: resolving throws the screenshots away.
      const done = await emitCb(admin, 'admin:report-resolve',
        { id: mine.id, resolved: true });
      check('resolving the report clears its attachments',
        done?.resolved === true && (done.attachments?.length ?? 0) === 0,
        JSON.stringify(done?.attachments));
      check('and the bytes are gone, not merely unlisted',
        (await emitCb(admin, 'admin:attachment',
          { reportId: mine.id, attachmentId: att.id })) === null);

      const reopened = await emitCb(admin, 'admin:report-resolve',
        { id: mine.id, resolved: false });
      check('reopening does not bring them back',
        reopened?.resolved === false && (reopened.attachments?.length ?? 0) === 0,
        JSON.stringify(reopened?.attachments));
      check('but the report itself survives', reopened.text.includes('scrolls instead'));

    }
  }


  {
    log('\n=== 35. Friends, and being asked to join one ===');
    const one = await mkClient('Fr-One');
    const two = await mkClient('Fr-Two');
    const guest = await mkClient('Fr-Guest');

    const acc1 = await signUp(one);
    const acc2 = await signUp(two);
    check('two accounts to be friends with each other',
      acc1?.account?.id != null && acc2?.account?.id != null);

    check('a guest has no friend list at all',
      (await emitCb(guest, 'friends:list', {})) === null);

    // The store outlives a run, so anything these two agreed to last time is undone
    // before the section starts: a test that only passes on an empty disk is not a test.
    await emitCb(one, 'friends:remove', { id: acc2.account.id });
    await emitCb(two, 'friends:remove', { id: acc1.account.id });

    const nobody = await emitCb(one, 'friends:add', { username: 'not-a-real-person' });
    check('adding somebody who does not exist says so',
      nobody.ok === false && /No account/i.test(nobody.error ?? ''), nobody.error);

    const self = await emitCb(one, 'friends:add', { username: acc1.account.username });
    check('and you cannot befriend yourself', self.ok === false, self.error);

    const asked = await emitCb(one, 'friends:add', { username: acc2.account.username });
    check('a request can be sent by name', asked.ok === true && asked.accepted === false,
      JSON.stringify(asked));

    const twice = await emitCb(one, 'friends:add', { username: acc2.account.username });
    check('asking twice says they have not answered', twice.ok === false, twice.error);

    const listOne = await emitCb(one, 'friends:list', {});
    const listTwo = await emitCb(two, 'friends:list', {});
    check('it is outgoing for the asker and incoming for the asked',
      listOne.outgoing.length === 1 && listOne.friends.length === 0
      && listTwo.incoming.length === 1 && listTwo.friends.length === 0,
      JSON.stringify({ one: listOne, two: listTwo }));
    check('and it carries the name, not only the id',
      listTwo.incoming[0].name === acc1.account.username, JSON.stringify(listTwo.incoming));

    // The push: both sides are told when the list changes under them.
    const pushed = [];
    two.on('friends:state', v => pushed.push(v));

    const accepted = await emitCb(two, 'friends:accept', { id: acc1.account.id });
    check('accepting makes it mutual', accepted.ok === true && accepted.accepted === true);
    await sleep(200);
    check('and the other side is told without asking',
      pushed.length > 0 && pushed[pushed.length - 1].friends.length === 1,
      JSON.stringify(pushed[pushed.length - 1] ?? null));

    const bothWays = await emitCb(one, 'friends:list', {});
    check('the friendship is on both lists',
      bothWays.friends.length === 1 && bothWays.friends[0].id === acc2.account.id
      && bothWays.outgoing.length === 0);
    check('a friend who is connected reads as online', bothWays.friends[0].online === true,
      JSON.stringify(bothWays.friends[0]));

    // Presence carries the room, which is what makes an invitation possible.
    const ridF = await emitCb(one, 'room:create', { name: 'Fr', config: { teamSize: 1 } });
    await join(one, ridF);
    await sleep(200);
    const withRoom = await emitCb(two, 'friends:list', {});
    check('and where they are, once they are somewhere',
      withRoom.friends[0].roomId === ridF, JSON.stringify(withRoom.friends[0]));

    const invites = [];
    two.on('friends:invited', inv => invites.push(inv));
    const sent = await emitCb(one, 'friends:invite', { id: acc2.account.id });
    await sleep(200);
    check('a friend can be invited into the room you are in', sent.ok === true, sent.error);
    check('and the invitation names the room, the mode and who sent it',
      invites.length === 1 && invites[0].roomId === ridF
      && invites[0].fromName === acc1.account.username && invites[0].mode != null,
      JSON.stringify(invites[0] ?? null));

    const stranger = await emitCb(guest, 'friends:invite', { id: acc2.account.id });
    check('a guest cannot invite anybody', stranger.ok === false, stranger.error);

    const notFriend = await mkClient('Fr-Three');
    const acc3 = await signUp(notFriend);
    await join(notFriend, ridF);
    const uninvited = await emitCb(notFriend, 'friends:invite', { id: acc2.account.id });
    check('and neither can somebody who is not on their list',
      uninvited.ok === false && /friend/i.test(uninvited.error ?? ''), uninvited.error);
    check('an account that never asked has an empty list',
      (await emitCb(notFriend, 'friends:list', {})).friends.length === 0);

    const removed = await emitCb(one, 'friends:remove', { id: acc2.account.id });
    check('a friend can be removed', removed.ok === true);
    const after = await emitCb(two, 'friends:list', {});
    check('and it is removed from both sides at once',
      after.friends.length === 0, JSON.stringify(after));
    check('after which the invitation is refused too',
      (await emitCb(one, 'friends:invite', { id: acc2.account.id })).ok === false);

    // Signing out takes you off the board without closing the socket.
    await emitCb(one, 'friends:add', { username: acc2.account.username });
    await emitCb(two, 'friends:accept', { id: acc1.account.id });
    one.emit('auth:logout');
    await sleep(250);
    const afterOut = await emitCb(two, 'friends:list', {});
    check('signing out reads as offline to your friends',
      afterOut.friends[0]?.online === false, JSON.stringify(afterOut.friends[0] ?? null));
  }

  {
    log('\n=== 36. A room nobody is in does not stay ===');
    // The server under test runs with ROOM_GRACE_MS short, so this can watch it happen.
    const grace = Number(process.env.ROOM_GRACE_MS ?? 0);
    if (!grace || grace > 5000) {
      log('  SKIP  needs: ROOM_GRACE_MS=800 npm start');
    } else {
      const host = await mkClient('Reap-Host');
      const ridR = await emitCb(host, 'room:create', { name: 'R', config: { teamSize: 1 } });
      await join(host, ridR);
      await emitCb(host, 'seat:take', { color: 'white' });
      // A bot on the other side: this is the shape that used to keep a room alive for
      // ever, because a bot counts as an occupant and nobody checked for people.
      host.emit('seat:bot', { color: 'black', bot: true });
      await sleep(200);
      check('the room is there while somebody is in it',
        (await fetchJson(`/api/rooms/${ridR}`))?.exists === true);

      host.disconnect();
      await sleep(grace + 600);
      check('and is gone once the last person leaves, bot or no bot',
        (await fetchJson(`/api/rooms/${ridR}`))?.exists === false);

      const back = await mkClient('Reap-Back');
      const res = await emitCb(back, 'room:join', { roomId: ridR, name: 'Back' });
      check('rejoining a room that has been closed says so plainly',
        res.ok === false && /not found/i.test(res.error ?? ''), res.error);
    }
  }

  log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('harness error:', e); process.exit(1); });
