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
  return new Promise(res => s.on('connect', () => res(s)));
}

const emitCb = (s, ev, payload) => new Promise(res => s.emit(ev, payload, res));

// join with an explicit token so reconnect semantics are testable
function join(s, roomId) {
  return new Promise(res =>
    s.emit('room:join', { roomId, name: s.name, token: s.token }, res));
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

  check('both sides are dealt five',
    cw.hand?.cards.length === 5 && cbk.hand?.cards.length === 5,
    `${cw.hand?.cards.length} / ${cbk.hand?.cards.length}`);
  check('each player is given their own colour',
    cw.hand?.color === 'white' && cbk.hand?.color === 'black');
  check('the public state agrees on the counts',
    cw.last.cards.white.handCount === 5 && cw.last.cards.black.handCount === 5,
    JSON.stringify(cw.last.cards));
  check('a spectator is dealt nothing', cspec.hand === null, JSON.stringify(cspec.hand));

  // The whole mode rests on this: the broadcast state must not carry anyone's cards.
  const publicBlob = JSON.stringify(cw.last.cards);
  check('the broadcast state carries no card identities',
    !publicBlob.includes('"id"') && !publicBlob.includes('"kind"'), publicBlob);
  check('only White is on the clock at the start',
    cw.hand.yourTurn === true && cbk.hand.yourTurn === false);
  check('the deck is 36 less the opening hand', cw.last.cards.white.deckCount === 31,
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
    check('the refused move did not spend a card', cw.hand.cards.length === 5);
  } else {
    check('every opening move was affordable, so there was nothing to refuse', true);
  }

  const affordable = legal.find(m => myReach.has(m.piece) && m.piece !== 'k');
  const spentBefore = cw.last.cards.white.played.length;
  const okAfford = await emitCb(cw, 'game:move',
    { from: affordable.from, to: affordable.to });
  await sleep(150);
  check('a move the hand covers is accepted', okAfford === true);
  check('it spent exactly one card',
    cw.last.cards.white.played.length === spentBefore + 1,
    JSON.stringify(cw.last.cards.white.played));
  check('the spent card covered the piece that moved', (() => {
    const k = cw.last.cards.white.played[spentBefore];
    return k === 'wild' || CARD_PIECE[k] === affordable.piece;
  })(), `${cw.last.cards.white.played[spentBefore]} for ${affordable.piece}`);
  check('the opponent sees a card was spent, not which one left the hand',
    cbk.last.cards.white.handCount === 4, String(cbk.last.cards.white.handCount));
  check('Black never received a White hand', cbk.hand.color === 'black');

  log('\n=== 18. Chess Cards: a full game holds every invariant ===');
  // Play both sides properly for a while: always a move the hand can pay for, checking
  // at every ply what the rules promise about hands, draws, tempo and the cap.
  const byColor = { white: cw, black: cbk };
  let capturesSeen = 0, emergenciesSeen = 0, kingMovesSeen = 0, enrageChecked = false;
  let bad = null;

  for (let ply = 0; ply < 34 && cw.last.status === 'playing'; ply++) {
    const st = cw.last;
    const color = st.turn;
    const me = byColor[color];
    const hand = me.hand;

    if (!hand || !hand.yourTurn) { bad = `${color} has no live hand on its own turn`; break; }

    const target = st.history.length >= 20 ? 6 : 5;
    if (st.history.length >= 20 && !enrageChecked) {
      enrageChecked = true;
      check('soft enrage raises the draw target at twenty plies',
        st.cards.drawTarget === 6 && st.cards.enraged === true, JSON.stringify(st.cards));
    }
    // A hand may sit above the target after a capture bonus; it may never sit below the
    // target while cards remain, and it may never pass the cap.
    if (hand.cards.length < target) {
      bad = `${color} drew to ${hand.cards.length}, wanted ${target}`; break;
    }
    if (hand.cards.length > 7) {
      bad = `${color} holds ${hand.cards.length}, over the cap of 7`; break;
    }
    if (st.cards[color].handCount !== hand.cards.length) {
      bad = `public count ${st.cards[color].handCount} != real ${hand.cards.length}`; break;
    }
    if (hand.emergency) emergenciesSeen++;

    const g = new Chess(st.fen);
    const r = reach(hand);
    const options = g.moves({ verbose: true }).filter(m => r.has(m.piece));
    if (options.length === 0) { bad = `${color} could not move at all`; break; }

    // prefer a capture where one exists, to exercise the tempo bonus
    const pick = options.find(m => m.captured) ?? options[0];
    const before = { hand: hand.cards.length, played: st.cards[color].played.length };

    const accepted = await emitCb(me, 'game:move',
      { from: pick.from, to: pick.to, promotion: pick.promotion });
    if (!accepted) { bad = `${color} was refused an affordable ${pick.piece} move`; break; }
    await sleep(90);

    const after = cw.last.cards[color];
    if (pick.piece === 'k') {
      kingMovesSeen++;
      if (after.played.length !== before.played) { bad = 'a king move spent a card'; break; }
    } else if (after.played.length !== before.played + 1) {
      bad = `a ${pick.piece} move spent ${after.played.length - before.played} cards`; break;
    }
    if (pick.captured && cw.last.status === 'playing') {
      capturesSeen++;
      // one card paid for the move, one came back for the capture
      const expected = Math.min(7, before.hand - (pick.piece === 'k' ? 0 : 1) + 1);
      if (after.handCount !== expected) {
        bad = `a capture left ${after.handCount} cards, expected ${expected}`; break;
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
  check('the new hand is still five', cm1.hand.cards.length === 5,
    String(cm1.hand.cards.length));
  check('the mulligan is publicly spent', cm1.last.cards.white.mulliganUsed === true);
  check('the old hand went to the discard pile',
    cm1.last.cards.white.discardCount === 5, String(cm1.last.cards.white.discardCount));

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
  check('the move spent a card', tk1.hand.cards.length === 4,
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

  log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('harness error:', e); process.exit(1); });
