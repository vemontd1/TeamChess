/**
 * Draw the metrics tab to a file, from simulated play.
 *
 * The panel is only honest once there are games behind it, and the first hundred games of
 * a new mode do not exist yet. So this plays them: the real card engine, the real metric
 * module, the real aggregate, and then the real markup and stylesheet the admin page uses
 * -- rendered to `preview/metrics.html`, which opens in a browser with no server running.
 *
 * It is a looking glass, not a test. Nothing here asserts; the point is to be able to see
 * a chart before a player ever produces the data for it.
 *
 *   npm run preview:metrics            120 cards games, 40 team games
 *   GAMES=400 npm run preview:metrics  more of them
 *   MODE=team npm run preview:metrics  one mode only
 *
 * It writes two files: the admin tab, and one player's report on the last game played.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'preview');

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-preview-'));
process.env.GAMES_DIR = path.join(store, 'games');
process.env.INSIGHTS_FILE = path.join(store, 'insights.json');
fs.mkdirSync(process.env.GAMES_DIR, { recursive: true });

const CARDS_GAMES = Number(process.env.GAMES ?? 120);
// GAMES=0 draws the empty state, which is what a server with nothing measured shows.
const TEAM_GAMES = CARDS_GAMES === 0 ? 0 : Math.max(10, Math.round(CARDS_GAMES / 3));
const MAX_PLIES = 160;

/**
 * Random movers almost never mate, so a simulated game would otherwise run to the ply cap
 * every time and the length distribution would be one bar. These end games the way people
 * do: a resignation or an agreed draw, more likely the longer it has gone on.
 */
function endsHere(ply) {
  return Math.random() < Math.max(0, (ply - 24) / 900);
}

const {
  createCards, drawCards, drawPerTurnFor, extinctTypes, replaceExtinct, cycleForPlayable,
  resolveSpend, commitSpend, cardPlayable, drawBonus, canSacrifice, resolveSacrifice,
  chooseSacrificeCards,
} = await import('../server/src/cards.ts');
const {
  computeChoiceSet, cardsSnapshot, hangingAfter, materialBalance, summariseGame,
} = await import('../server/src/metrics.ts');
const { insightsView, foldGame, noteFunnel } = await import('../server/src/insights.ts');
const { metricsTab } = await import('../client/src/ui/adminMetrics.ts');
const { reportHtml } = await import('../client/src/ui/gameReport.ts');

/** A think time with a long tail, which is what a real one looks like. */
function thinkMs() {
  const u = Math.random();
  const v = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u || 1e-9)) * Math.cos(2 * Math.PI * v);
  return Math.max(400, Math.round(Math.exp(7.6 + normal * 0.85)));
}

const pieceValue = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * One game, measured the way the server measures one.
 *
 * The ply rows are built by the same functions `room.ts` calls, in the same order, so
 * what the panel draws here has the shape it will have in production -- only the moves
 * behind it are random.
 */
function playGame(mode, teamSize) {
  const chess = new Chess();
  const cards = mode === 'cards' ? createCards() : null;
  const plies = [];
  const history = [];
  const lastTurnEnd = { white: null, black: null };
  let clock = 0;

  let quit = false;
  for (let n = 1; n <= MAX_PLIES && !chess.isGameOver() && !quit; n++) {
    const color = chess.turn() === 'w' ? 'white' : 'black';
    const side = cards?.[color] ?? null;

    if (side) {
      if (n > 2) drawCards(side, drawPerTurnFor(n));
      replaceExtinct(side, extinctTypes(chess, color));
      if (!chess.inCheck()) cycleForPlayable(side, chess);
    }

    const legal = chess.moves({ verbose: true });
    if (legal.length === 0) break;
    if (side) {
      const movable = new Set(legal.map(m => m.piece));
      side.emergency = side.hand.length === 0
        || !side.hand.some(c => cardPlayable(c, movable));
    }

    const choice = computeChoiceSet(chess, side);
    let affordable = legal.filter(m => choice.reach.has(m.piece));
    let payment = side ? 'card' : 'free';

    // A sacrifice when the hand is holding the board shut and one is available. A player
    // burns cards to reach a move they can see; the simulation approximates that with
    // "the hand can pay for very little, and the cooldown is up".
    let sacrifice = null;
    const pinched = choice.legalMoves > 0
      && choice.affordableMoves / choice.legalMoves < 0.25;
    if (side && (affordable.length === 0 || pinched) && canSacrifice(side, n)
        && Math.random() < (affordable.length === 0 ? 0.7 : 0.06)) {
      const picked = chooseSacrificeCards(side, chess);
      sacrifice = picked && resolveSacrifice(side, picked.map(c => c.id), n);
      if (sacrifice) { affordable = legal; payment = 'sacrifice'; }
    }
    if (affordable.length === 0) {
      if (!side) break;
      affordable = legal;              // the emergency net
      payment = 'emergency';
    }

    const think = thinkMs();
    const auto = Math.random() < 0.02;
    const openedAt = clock;
    clock += think;

    const pick = affordable[Math.floor(Math.random() * affordable.length)];
    const spend = sacrifice ?? (side ? resolveSpend(side, pick.piece) : null);
    // The payment is whatever the engine resolved, not what was hoped for: a king move
    // costs nothing, and a hand that can pay for nothing opens the safety net.
    if (spend) {
      payment = spend.kind === 'none' ? 'free'
        : spend.kind === 'emergency' ? 'emergency'
        : spend.kind === 'sacrifice' ? 'sacrifice' : 'card';
    }

    // The hand as it stood before the move, which is what the server records.
    const snapshot = side
      ? cardsSnapshot(chess, side, color, n, payment,
          spend?.kind === 'card' ? spend.card.kind : null)
      : undefined;

    const captured = pick.captured ? pieceValue[pick.captured] : 0;
    if (side && spend) commitSpend(side, spend);
    const res = chess.move({ from: pick.from, to: pick.to, promotion: pick.promotion ?? 'q' });
    if (side && pick.captured) drawBonus(side);

    const { hung, hungValue } = hangingAfter(chess, pick.to, pick.promotion ?? pick.piece,
      captured);
    const waitMs = lastTurnEnd[color] == null ? null
      : openedAt - lastTurnEnd[color] + (teamSize - 1) * 4000;
    lastTurnEnd[color] = clock;

    // What a browser would have reported for this turn. The same shape the real channel
    // sends, so the figures that read it can be looked at before anyone has played a game
    // with the channel switched on.
    const client = Math.random() < 0.85 ? {
      pickups: Math.random() < 0.25 ? 1 + Math.floor(Math.random() * 2) : 0,
      cardSelections: mode === 'cards' && Math.random() < 0.3 ? 1 : 0,
      timeToFirstTouchMs: Math.round(300 + Math.random() * think * 0.6),
      premove: Math.random() < 0.06 ? (Math.random() < 0.7 ? 'played' : 'rejected') : 'none',
    } : undefined;

    plies.push({
      ply: n, color, seatId: n % teamSize, bot: false, auto,
      legalMoves: choice.legalMoves, legalTypes: choice.legalTypes,
      affordableMoves: choice.affordableMoves, affordableTypes: choice.affordableTypes,
      openTurn: choice.openTurn, onlyKing: choice.onlyKing, forced: choice.forced,
      inCheck: res.san.includes('+'),
      piece: pick.piece, captured: pick.captured ?? null,
      promotion: !!pick.promotion, castle: /[kq]/.test(pick.flags),
      materialAfter: materialBalance(chess),
      swing: color === 'white' ? captured : -captured,
      hung, hungValue,
      bestCapture: choice.bestCapture, missed: Math.max(0, choice.bestCapture - captured),
      thinkMs: auto ? 30000 : think,
      waitMs,
      clockRemainingMs: null, clockFraction: null,
      cards: snapshot,
      client,
    });
    history.push({ ply: n, san: res.san, color, seatId: 0, playerName: 'Sim',
                   auto, bot: false, fen: chess.fen(), from: pick.from, to: pick.to });
    quit = endsHere(n);
  }

  const winner = chess.isCheckmate()
    ? (chess.turn() === 'w' ? 'black' : 'white')
    : chess.isDraw() ? 'draw' : null;
  const roll = Math.random();
  const result = winner ?? (roll < 0.1 ? 'unfinished'
    : roll < 0.55 ? 'white' : roll < 0.9 ? 'black' : 'draw');
  const reason = chess.isCheckmate() ? 'checkmate'
    : chess.isStalemate() ? 'stalemate'
    : result === 'unfinished' ? 'abandoned'
    : chess.isDraw() ? 'fifty-move'
    : result === 'draw' ? 'agreed' : 'resigned';

  const checks = { white: 0, black: 0 };
  for (const h of history) if (/[+#]$/.test(h.san)) checks[h.color]++;

  return {
    roomId: Math.random().toString(36).slice(2, 7),
    config: { mode, teamSize, skipEmptySeats: true, moveTimerSec: 30, allowTakeback: true },
    white: ['Sim A'], black: ['Sim B'],
    history,
    startFen: new Chess().fen(),
    finalFen: chess.fen(),
    result,
    reason,
    metrics: summariseGame(plies, clock, checks, winner, {
      white: session(), black: session(),
    }),
  };
}

/** A side's session counters, in roughly the proportions a real one comes in. */
function session() {
  const phone = Math.random() < 0.35;
  const turns = 20 + Math.floor(Math.random() * 40);
  return {
    reviewOpened: Math.random() < 0.3 ? 1 : 0,
    drawerOpened: phone && Math.random() < 0.6 ? 1 + Math.floor(Math.random() * 3) : 0,
    devices: { [phone ? 'phone' : 'desktop']: turns },
    pointers: { [phone ? 'touch' : 'mouse']: turns },
    fx: { [Math.random() < 0.8 ? 'full' : 'calm']: turns },
  };
}

/**
 * Folded straight in rather than archived first.
 *
 * The aggregate takes a finished game, and nothing here needs the game to exist on disk
 * afterwards -- which also means the finishing times can be spread over a few weeks, so
 * the daily chart has a shape instead of one tall bar.
 */
const DAY = 24 * 60 * 60 * 1000;
let n = 0;
let lastGame = null;
function fold(mode, teamSize) {
  const game = playGame(mode, teamSize);
  lastGame = game;
  const daysAgo = Math.floor(Math.random() ** 1.6 * 21);
  game.id = `sim-${(n++).toString(36).padStart(6, '0')}`;
  game.finishedAt = Date.now() - daysAgo * DAY - Math.random() * DAY;
  foldGame(game);
}

console.log(`Simulating ${CARDS_GAMES} cards games and ${TEAM_GAMES} team games...`);
let lastCards = null;
for (let i = 0; i < CARDS_GAMES; i++) { fold('cards', 1); lastCards = lastGame; }
for (let i = 0; i < TEAM_GAMES; i++) fold('team', 3);

// A funnel needs rooms, which a simulation has none of: these are the shape of one, so
// the chart can be looked at rather than left empty.
const rooms = CARDS_GAMES + TEAM_GAMES;
for (const [step, n] of [['created', Math.round(rooms * 1.6)], ['seated', Math.round(rooms * 1.2)],
                         ['started', rooms], ['firstMove', Math.round(rooms * 0.95)],
                         ['finished', Math.round(rooms * 0.82)],
                         ['rematch', Math.round(rooms * 0.35)]]) {
  for (let i = 0; i < n; i++) noteFunnel(step);
}

const insights = insightsView();
const css = ['theme.css', 'layout.css', 'panels.css', 'controls.css', 'account.css',
             'charts.css']
  .map(name => fs.readFileSync(path.join(ROOT, 'client', 'src', 'styles', name), 'utf8'))
  .join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Metrics preview</title>
<style>${css}</style>
</head><body><div id="app"><div class="page page-wide">
<section class="panel edge sheen adm-head"><div><h1>Admin — metrics preview</h1>
<p>${insights.gamesCovered} simulated games. Not real play.</p></div></section>
${(process.env.MODE ? [process.env.MODE] : ['cards', 'team'])
  .map(m => metricsTab(insights, m))
  .join('<hr style="margin:32px 0;border:0;border-top:1px solid rgba(232,176,75,.2)">')}
</div></div></body></html>`;

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'metrics.html');
fs.writeFileSync(file, html, 'utf8');

// The other half of what this data feeds: one player's own report on one game.
const reportPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Report preview</title>
<style>${css}</style>
</head><body><div id="app"><div class="page">
<section class="panel edge sheen">
${reportHtml({ ...(lastCards ?? lastGame), id: 'preview' }, 'white')}
</section></div></div></body></html>`;
const reportFile = path.join(OUT, 'report.html');
fs.writeFileSync(reportFile, reportPage, 'utf8');
console.log(`Wrote ${reportFile}`);
fs.rmSync(store, { recursive: true, force: true });
console.log(`\nWrote ${file}`);
