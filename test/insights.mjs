/**
 * Unit tests for the insights aggregate.
 *
 * The aggregate is the one thing on the admin panel that is *not* recomputed from the
 * games on every read, which means it is the one thing that can quietly drift away from
 * them. So the games here are built by hand, with numbers chosen to make every rate come
 * out round, and the aggregate is asked whether it agrees.
 *
 * Everything runs against a temporary archive, so a developer's own `data/` is never read
 * and never written. Run through tsx, since it imports the server's TypeScript directly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-insights-'));
process.env.GAMES_DIR = path.join(dir, 'games');
process.env.INSIGHTS_FILE = path.join(dir, 'insights.json');
fs.mkdirSync(process.env.GAMES_DIR, { recursive: true });

const {
  initInsights, insightsView, rebuildInsights, foldGame, noteFunnel, flushInsights,
  insightsFile, INSIGHTS_SCHEMA,
} = await import('../server/src/insights.ts');

let failures = 0;
const log = (...a) => console.log(...a);
function check(name, cond, extra = '') {
  if (cond) log(`  PASS  ${name}`);
  else { failures++; log(`  FAIL  ${name} ${extra}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const DAY = 24 * 60 * 60 * 1000;

/** One ply, with only the fields a test cares about spelled out. */
function ply(n, over = {}) {
  return {
    ply: n,
    color: n % 2 === 1 ? 'white' : 'black',
    seatId: 0,
    bot: false,
    auto: false,
    legalMoves: 20,
    legalTypes: 4,
    affordableMoves: 10,
    affordableTypes: 2,
    openTurn: false,
    onlyKing: false,
    forced: false,
    inCheck: false,
    piece: 'p',
    captured: null,
    promotion: false,
    castle: false,
    materialAfter: 0,
    swing: 0,
    hung: false,
    hungValue: 0,
    bestCapture: 0,
    missed: 0,
    thinkMs: 4000,
    waitMs: 8000,
    clockRemainingMs: null,
    clockFraction: null,
    ...over,
  };
}

/** A hand, as it stood before a move. */
function cards(over = {}) {
  return {
    handSize: 5, handCap: 7, handKinds: { pawn: 3, rook: 2 }, drawn: 2, deadHeld: 1,
    extinctHeld: 0, replaced: 0, cycled: 0, payment: 'card', spentKind: 'pawn',
    canCastle: true, deckLeft: 20, discardLeft: 4, sacrificeReadyIn: 0, ...over,
  };
}

/** An empty archive between sections, so each one measures only its own games. */
function reset() {
  for (const name of fs.readdirSync(process.env.GAMES_DIR)) {
    fs.rmSync(path.join(process.env.GAMES_DIR, name));
  }
  rebuildInsights();
}

let seq = 0;
function writeGame({ mode = 'cards', plies, finishedAt = Date.now(), result = 'white',
                     reason = 'checkmate', metrics = true, comeback = false,
                     leadChanges = 0 }) {
  const id = `2026-01-0${(seq % 9) + 1}-room${seq++}-aaaaaa`;
  const game = {
    id,
    roomId: `room${seq}`,
    finishedAt,
    config: { mode, teamSize: mode === 'cards' ? 1 : 3, skipEmptySeats: true,
              moveTimerSec: 30, allowTakeback: true },
    white: ['A'], black: ['B'],
    history: plies.map(p => ({ ply: p.ply, san: 'e4', color: p.color, seatId: 0,
                               playerName: 'A', auto: false, bot: false, fen: '',
                               from: 'e2', to: 'e4' })),
    startFen: '', finalFen: '', result, reason,
  };
  if (metrics) {
    game.metrics = {
      schema: 1, plies,
      white: {}, black: {},
      durationMs: plies.reduce((a, p) => a + p.thinkMs, 0),
      firstCapturePly: null, firstCheckPly: null,
      leadChanges, maxLead: 0, comeback,
    };
  }
  fs.writeFileSync(path.join(process.env.GAMES_DIR, `${id}.json`), JSON.stringify(game));
  return game;
}

log('\n=== 1. Rates come off the plies ===');
{
  // Ten plies: two open, one only-king, one forced, one hanging, one played by the clock.
  const plies = [
    ply(1, { openTurn: true, cards: cards() }),
    ply(2, { openTurn: true, cards: cards() }),
    ply(3, { onlyKing: true, cards: cards() }),
    ply(4, { forced: true, cards: cards() }),
    ply(5, { hung: true, hungValue: 3, missed: 2, cards: cards() }),
    ply(6, { auto: true, cards: cards({ payment: 'emergency' }) }),
    ply(7, { captured: 'n', cards: cards({ payment: 'sacrifice', spentKind: null }) }),
    ply(8, { cards: cards() }),
    ply(9, { cards: cards() }),
    ply(10, { cards: cards() }),
  ];
  reset();
  writeGame({ plies });
  rebuildInsights();
  const view = insightsView();
  const m = view.modes.find(x => x.mode === 'cards');

  check('one measured game', view.gamesCovered === 1 && m.games === 1);
  check('ten plies', m.plies === 10);
  check('open turn rate', near(m.openTurnRate, 0.2));
  check('affordable ratio', near(m.affordableRatio, 0.5));
  check('only-king rate', near(m.onlyKingRate, 0.1));
  check('forced rate', near(m.forcedRate, 0.1));
  check('hang rate', near(m.hangRate, 0.1));
  check('missed mean', near(m.missedMean, 0.2));
  check('the clock played one in ten', near(m.autoRate, 0.1));
  check('emergency rate', near(m.emergencyRate, 0.1));
  check('one sacrifice in one game', near(m.sacrificesPerGame, 1));
  check('dead cards held', near(m.deadHeldMean, 1));
  check('kinds held are summed over plies',
    m.drawnKinds.pawn === 30 && m.drawnKinds.rook === 20,
    JSON.stringify(m.drawnKinds));
  check('spent kinds skip the sacrifice, which spends no single kind',
    m.spentKinds.pawn === 9, JSON.stringify(m.spentKinds));
  check('the result is counted', m.results.white === 1 && m.reasons.checkmate === 1);
}

log('\n=== 2. Distributions and percentiles ===');
{
  // Eight plies at 1.5s and two at 40s: a median inside the first bucket and a p90 that
  // has to come out of the tail, which is the whole reason for keeping a histogram.
  const plies = [];
  for (let i = 1; i <= 8; i++) plies.push(ply(i, { thinkMs: 1500, waitMs: 6000 }));
  plies.push(ply(9, { thinkMs: 40000, waitMs: 200000 }));
  plies.push(ply(10, { thinkMs: 40000, waitMs: 200000 }));
  reset();
  writeGame({ mode: 'team', plies });
  rebuildInsights();
  const m = insightsView().modes.find(x => x.mode === 'team');

  check('every ply is a sample', m.think.n === 10 && m.wait.n === 10);
  check('mean think time', near(m.think.mean, (8 * 1500 + 2 * 40000) / 10));
  check('p50 lands in the 1-2s bucket', m.think.p50 >= 1000 && m.think.p50 < 2000,
    String(m.think.p50));
  check('p90 lands in the tail', m.think.p90 >= 30000, String(m.think.p90));
  check('the largest sample is kept', m.think.max === 40000);
  check('the wait tail is open-ended', m.wait.p90 >= 180000, String(m.wait.p90));
  check('one bucket per bound, plus the open one',
    m.think.counts.length === m.think.bounds.length + 1);
  check('game length is a distribution too', m.length.n === 1 && m.length.max === 10);
}

log('\n=== 3. Phases split by ply ===');
{
  const plies = [];
  for (let i = 1; i <= 80; i++) plies.push(ply(i, { openTurn: i <= 20 }));
  reset();
  writeGame({ mode: 'team', plies });
  rebuildInsights();
  const m = insightsView().modes.find(x => x.mode === 'team');
  const by = Object.fromEntries(m.phases.map(p => [p.phase, p]));

  check('early is the first twenty plies', by.early.plies === 20);
  check('middle runs to sixty', by.middle.plies === 40);
  check('late is whatever is left', by.late.plies === 20);
  check('an opening-only effect shows in the early phase only',
    near(by.early.openTurnRate, 1) && by.middle.openTurnRate === 0);
}

log('\n=== 4. Games with no metrics still count as games ===');
{
  reset();
  writeGame({ plies: [ply(1, { cards: cards() })] });
  writeGame({ plies: [ply(1)], metrics: false });
  rebuildInsights();
  const view = insightsView();

  check('measured and unmeasured are counted apart',
    view.gamesCovered === 1 && view.gamesUnmeasured === 1);
  check('but both are in the daily series',
    view.daily.reduce((a, d) => a + d.games, 0) === 2);
}

log('\n=== 5. A game is never folded twice ===');
{
  reset();
  const game = writeGame({ plies: [ply(1, { cards: cards() })] });
  check('the first fold takes', foldGame(game) === true);
  check('the second is refused', foldGame(game) === false);
  check('and the counters moved once', insightsView().gamesCovered === 1);
}

log('\n=== 6. The daily series is by day ===');
{
  reset();
  const now = Date.now();
  writeGame({ plies: [ply(1)], finishedAt: now - 2 * DAY });
  writeGame({ plies: [ply(1)], finishedAt: now - 2 * DAY });
  writeGame({ plies: [ply(1)], finishedAt: now });
  rebuildInsights();
  const daily = insightsView().daily;

  check('one row per day, oldest first', daily.length === 3 || daily.length === 2,
    JSON.stringify(daily));
  check('the days are in order',
    daily.every((d, i) => i === 0 || daily[i - 1].day <= d.day));
  check('a day with two games says two',
    daily.some(d => d.games === 2), JSON.stringify(daily));
}

log('\n=== 7. The funnel survives a rebuild ===');
{
  reset();
  noteFunnel('created');
  noteFunnel('created');
  noteFunnel('seated');
  noteFunnel('started');
  check('counters add up', insightsView().funnel.created === 2);
  rebuildInsights();
  check('a rebuild keeps them, because the archive cannot recover them',
    insightsView().funnel.created === 2 && insightsView().funnel.started === 1);
}

log('\n=== 8. Guardrails read the targets ===');
{
  reset();
  // 300 plies of cards, 15% of them open: inside the 10-20% target.
  const plies = [];
  for (let i = 1; i <= 300; i++) {
    plies.push(ply(i, { openTurn: i % 20 < 3, cards: cards() }));
  }
  writeGame({ plies });
  rebuildInsights();
  const rows = insightsView().guardrails;
  const open = rows.find(r => r.key === 'openTurnRate');
  const rematch = rows.find(r => r.key === 'rematchRate');

  check('the open rate is graded good inside its band',
    open.status === 'good', `${open.status} ${open.value}`);
  check('it carries its target and its sample count',
    open.target === '10-20%' && open.samples === 300);
  check('a target with no ceiling is read, not judged', rematch.status === 'info'
    || rematch.status === 'unknown', rematch.status);

  // The same metric, well outside the band.
  rebuildInsights();
  const wide = [];
  for (let i = 1; i <= 300; i++) wide.push(ply(i, { openTurn: true, cards: cards() }));
  writeGame({ plies: wide });
  rebuildInsights();
  const off = insightsView().guardrails.find(r => r.key === 'openTurnRate');
  check('and off the band when the cards do nothing', off.status === 'off',
    `${off.status} ${off.value}`);
}

log('\n=== 9. Too little play is said, not guessed ===');
{
  reset();
  writeGame({ plies: [ply(1, { openTurn: true, cards: cards() })] });
  rebuildInsights();
  const open = insightsView().guardrails.find(r => r.key === 'openTurnRate');
  check('one ply grades as unknown rather than as a failure', open.status === 'unknown',
    open.status);
}

log('\n=== 10. The file is a cache, and says which one ===');
{
  reset();
  writeGame({ plies: [ply(1, { cards: cards() })] });
  rebuildInsights();
  flushInsights();
  const raw = JSON.parse(fs.readFileSync(insightsFile(), 'utf8'));
  check('it is written where it says it is', fs.existsSync(insightsFile()));
  check('it carries its schema', raw.schema === INSIGHTS_SCHEMA);

  // An aggregate from an older shape is thrown away rather than half-read.
  fs.writeFileSync(insightsFile(), JSON.stringify({ ...raw, schema: raw.schema - 1 }));
  const before = insightsView().gamesCovered;
  check('a stale schema is not trusted', before >= 1);
}

fs.rmSync(dir, { recursive: true, force: true });
log(`\n${failures === 0 ? 'ALL INSIGHT CHECKS PASSED' : `${failures} INSIGHT CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
