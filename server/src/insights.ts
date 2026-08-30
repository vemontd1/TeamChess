import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eachArchivedGame } from './archive.js';
import type {
  ArchivedGame, Distribution, FunnelInsights, GameMode, GuardrailRow, Insights,
  ModeInsights, Phase, PhaseInsights, PlyMetric,
} from './types.js';

/**
 * Insights: the archive, rolled up once and kept rolled up.
 *
 * The admin panel wants distributions across every game ever played, and a game's
 * measurements are the large part of its file -- roughly 790 bytes a ply, so a few
 * hundred games is tens of megabytes. Reading all of that on every page view would be a
 * dashboard that gets slower the more it has to say, which is the wrong direction for a
 * number to move in.
 *
 * So each finished game is folded into counters as it is archived, and the counters are
 * written to `data/insights.json`. Nothing here is a source of truth: every number can be
 * rebuilt from the archive, and is, whenever the shape below changes. That is what makes
 * it safe to add a counter -- bump the schema and the next start recomputes it from the
 * games, rather than carrying a field that has been half-filled since the day it landed.
 *
 * The one exception is the funnel, which counts rooms rather than games. A room that was
 * created and never started leaves nothing on disk, so those counters are live and a
 * rebuild deliberately keeps them.
 */

/**
 * 1: the server-measured half.
 * 2: the client half -- hesitation, premove outcomes, devices.
 *
 * A bump rebuilds from the archive on the next start, which is the whole reason it is
 * safe to add a counter here.
 */
export const INSIGHTS_SCHEMA = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.INSIGHTS_FILE
  ?? path.resolve(HERE, '..', '..', 'data', 'insights.json');

/**
 * Fixed buckets, because a rolling aggregate cannot keep the samples.
 *
 * They are uneven on purpose: the interesting part of a think time is its first ten
 * seconds and the interesting part of a wait is its first minute, so that is where the
 * resolution goes. Changing any of these is a schema bump -- old counts would be
 * silently re-labelled otherwise.
 */
const THINK_BOUNDS = [1e3, 2e3, 3e3, 5e3, 8e3, 12e3, 20e3, 30e3, 45e3, 60e3];
const WAIT_BOUNDS = [5e3, 10e3, 20e3, 30e3, 45e3, 60e3, 90e3, 120e3, 180e3];
const LENGTH_BOUNDS = [10, 20, 30, 40, 50, 60, 80, 100, 140];
const DURATION_BOUNDS = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3];
/**
 * Time to first touch is a reaction, so its interesting range is the first seconds.
 *
 * Coarser than the others on purpose: sub-second bounds make axis labels like
 * "250ms-500ms", which collide in a band this narrow. A bucket nobody can read the label
 * of is not resolution, it is clutter.
 */
const TOUCH_BOUNDS = [500, 1e3, 2e3, 4e3, 8e3, 15e3];

/** How many days of daily counts to keep. Enough for a quarter, and bounded. */
const DAILY_DAYS = 120;

/** Ids kept for de-duplication when catching up on games archived before a restart. */
const RECENT_IDS = 500;

/** Below this there is nothing to say, and saying it anyway is how targets get argued. */
const MIN_PLIES = 200;
const MIN_GAMES = 25;

// ---------- accumulators (what is actually stored) ----------

interface Hist { counts: number[]; n: number; sum: number; max: number; }

interface PhaseAcc {
  plies: number; open: number; ratio: number; emergency: number; hangs: number;
  auto: number;
}

interface ModeAcc {
  games: number;
  plies: number;
  open: number;
  ratio: number;
  ratioN: number;
  onlyKing: number;
  forced: number;
  checks: number;
  captures: number;
  hangs: number;
  missed: number;
  auto: number;
  bot: number;
  emergency: number;
  sacrifice: number;
  deadHeld: number;
  cardPlies: number;
  atCap: number;
  cycles: number;
  replacements: number;
  drawnKinds: Record<string, number>;
  spentKinds: Record<string, number>;
  results: Record<string, number>;
  reasons: Record<string, number>;
  comebacks: number;
  leadChanges: number;
  clientPlies: number;
  pickups: number;
  cardSelections: number;
  premovesPlayed: number;
  premovesRejected: number;
  reviewOpens: number;
  drawerOpens: number;
  devices: Record<string, number>;
  pointers: Record<string, number>;
  fx: Record<string, number>;
  touch: Hist;
  phases: Record<Phase, PhaseAcc>;
  think: Hist;
  wait: Hist;
  length: Hist;
  duration: Hist;
}

interface State {
  schema: number;
  updatedAt: number;
  covered: number;
  unmeasured: number;
  /** The newest `finishedAt` folded in, so a restart knows where to resume. */
  lastFinishedAt: number;
  recent: string[];
  modes: Record<string, ModeAcc>;
  daily: Record<string, { games: number; plies: number }>;
  funnel: FunnelInsights;
}

function hist(bounds: number[]): Hist {
  return { counts: new Array(bounds.length + 1).fill(0), n: 0, sum: 0, max: 0 };
}

function phaseAcc(): PhaseAcc {
  return { plies: 0, open: 0, ratio: 0, emergency: 0, hangs: 0, auto: 0 };
}

function modeAcc(): ModeAcc {
  return {
    games: 0, plies: 0, open: 0, ratio: 0, ratioN: 0, onlyKing: 0, forced: 0, checks: 0,
    captures: 0, hangs: 0, missed: 0, auto: 0, bot: 0, emergency: 0, sacrifice: 0,
    deadHeld: 0, cardPlies: 0, atCap: 0, cycles: 0, replacements: 0,
    drawnKinds: {}, spentKinds: {}, results: {}, reasons: {},
    comebacks: 0, leadChanges: 0,
    clientPlies: 0, pickups: 0, cardSelections: 0,
    premovesPlayed: 0, premovesRejected: 0, reviewOpens: 0, drawerOpens: 0,
    devices: {}, pointers: {}, fx: {}, touch: hist(TOUCH_BOUNDS),
    phases: { early: phaseAcc(), middle: phaseAcc(), late: phaseAcc() },
    think: hist(THINK_BOUNDS), wait: hist(WAIT_BOUNDS),
    length: hist(LENGTH_BOUNDS), duration: hist(DURATION_BOUNDS),
  };
}

function emptyFunnel(): FunnelInsights {
  return { created: 0, seated: 0, started: 0, firstMove: 0, finished: 0, rematch: 0 };
}

function emptyState(): State {
  return {
    schema: INSIGHTS_SCHEMA,
    updatedAt: 0,
    covered: 0,
    unmeasured: 0,
    lastFinishedAt: 0,
    recent: [],
    modes: {},
    daily: {},
    funnel: emptyFunnel(),
  };
}

let state = emptyState();
let ready = false;
let writeTimer: NodeJS.Timeout | null = null;

// ---------- folding a game in ----------

function push(h: Hist, bounds: number[], value: number): void {
  let i = 0;
  while (i < bounds.length && value >= bounds[i]) i++;
  h.counts[i]++;
  h.n++;
  h.sum += value;
  if (value > h.max) h.max = value;
}

function bump(into: Record<string, number>, key: string | null | undefined, by = 1): void {
  if (!key) return;
  into[key] = (into[key] ?? 0) + by;
}

/**
 * Plies, not moves: twenty plies is ten moves each, which is about where an opening stops
 * being an opening, and sixty is where pieces have come off and the hand cap has started
 * to shrink with the army.
 */
function phaseOf(ply: number): Phase {
  return ply <= 20 ? 'early' : ply <= 60 ? 'middle' : 'late';
}

function foldPly(acc: ModeAcc, p: PlyMetric): void {
  const ph = acc.phases[phaseOf(p.ply)];
  acc.plies++;
  ph.plies++;

  if (p.openTurn) { acc.open++; ph.open++; }
  if (p.legalMoves > 0) {
    const ratio = p.affordableMoves / p.legalMoves;
    acc.ratio += ratio;
    acc.ratioN++;
    ph.ratio += ratio;
  }
  if (p.onlyKing) acc.onlyKing++;
  if (p.forced) acc.forced++;
  if (p.inCheck) acc.checks++;
  if (p.captured) acc.captures++;
  if (p.hung) { acc.hangs++; ph.hangs++; }
  acc.missed += p.missed;
  if (p.auto) { acc.auto++; ph.auto++; }
  if (p.bot) acc.bot++;

  if (p.thinkMs > 0) push(acc.think, THINK_BOUNDS, p.thinkMs);
  if (p.waitMs != null && p.waitMs > 0) push(acc.wait, WAIT_BOUNDS, p.waitMs);

  const cl = p.client;
  if (cl) {
    acc.clientPlies++;
    acc.pickups += cl.pickups;
    acc.cardSelections += cl.cardSelections;
    if (cl.premove === 'played') acc.premovesPlayed++;
    if (cl.premove === 'rejected') acc.premovesRejected++;
    if (cl.timeToFirstTouchMs != null) push(acc.touch, TOUCH_BOUNDS, cl.timeToFirstTouchMs);
  }

  const c = p.cards;
  if (!c) return;
  acc.cardPlies++;
  if (c.payment === 'emergency') { acc.emergency++; ph.emergency++; }
  if (c.payment === 'sacrifice') acc.sacrifice++;
  acc.deadHeld += c.deadHeld;
  if (c.handSize >= c.handCap) acc.atCap++;
  acc.cycles += c.cycled;
  acc.replacements += c.replaced;
  bump(acc.spentKinds, c.spentKind);
  // What was dealt is only kept as a count, so the kinds a player saw are read off the
  // hand itself: it is the composition that answers "how many of each did I hold".
  for (const [kind, n] of Object.entries(c.handKinds)) bump(acc.drawnKinds, kind, n);
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function trimDaily(): void {
  const days = Object.keys(state.daily).sort();
  while (days.length > DAILY_DAYS) delete state.daily[days.shift()!];
}

/**
 * Fold one archived game into the counters. Returns false when it was already folded.
 *
 * Every game counts towards the daily series, and towards `unmeasured` if it carries no
 * metrics block -- a game played before metrics existed is still a game that happened,
 * and quietly dropping it would make the archive and the dashboard disagree about how
 * much has been played.
 */
export function foldGame(game: ArchivedGame): boolean {
  if (!ready) initInsights();
  if (state.recent.includes(game.id)) return false;

  state.recent.push(game.id);
  if (state.recent.length > RECENT_IDS) {
    state.recent.splice(0, state.recent.length - RECENT_IDS);
  }
  state.lastFinishedAt = Math.max(state.lastFinishedAt, game.finishedAt);

  const day = (state.daily[dayKey(game.finishedAt)] ??= { games: 0, plies: 0 });
  day.games++;
  day.plies += game.history.length;
  trimDaily();

  const m = game.metrics;
  if (!m || !Array.isArray(m.plies) || m.plies.length === 0) {
    state.unmeasured++;
    schedule();
    return true;
  }

  const mode: GameMode = game.config?.mode ?? 'team';
  const acc = (state.modes[mode] ??= modeAcc());

  acc.games++;
  bump(acc.results, game.result);
  bump(acc.reasons, game.reason || 'unknown');
  if (m.comeback) acc.comebacks++;
  acc.leadChanges += m.leadChanges;
  push(acc.length, LENGTH_BOUNDS, m.plies.length);
  push(acc.duration, DURATION_BOUNDS, m.durationMs);
  for (const p of m.plies) foldPly(acc, p);

  // The session half is per side rather than per ply: opening the review belongs to a
  // player's game, not to any move in it.
  for (const side of [m.client?.white, m.client?.black]) {
    if (!side) continue;
    acc.reviewOpens += side.reviewOpened;
    acc.drawerOpens += side.drawerOpened;
    for (const [k, n] of Object.entries(side.devices)) bump(acc.devices, k, n);
    for (const [k, n] of Object.entries(side.pointers)) bump(acc.pointers, k, n);
    for (const [k, n] of Object.entries(side.fx)) bump(acc.fx, k, n);
  }

  state.covered++;
  schedule();
  return true;
}

// ---------- the funnel ----------

export type FunnelStep = keyof FunnelInsights;

/** One room reaching one step, counted once by the caller that holds the room flags. */
export function noteFunnel(step: FunnelStep): void {
  if (!ready) initInsights();
  state.funnel[step]++;
  schedule();
}

// ---------- persistence ----------

function write(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    state.updatedAt = Date.now();
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn('[insights] could not save:', (err as Error).message);
  }
}

/**
 * Writes are debounced: a game ending bumps a few hundred counters and then nothing
 * happens for minutes, and the aggregate is a cache -- losing the last few seconds of it
 * to a hard kill costs one rebuild, not one game.
 */
function schedule(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; write(); }, 2000);
  writeTimer.unref?.();
}

/** Flush now, for a caller about to exit or a test about to read the file. */
export function flushInsights(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  write();
}

/**
 * Rebuild from the archive.
 *
 * The funnel is carried across rather than recomputed: those counters are about rooms,
 * and a room that never started a game left no file to count.
 */
export function rebuildInsights(): number {
  const funnel = state.funnel;
  const startedAt = Date.now();
  state = emptyState();
  state.funnel = funnel;
  ready = true;

  const seen = eachArchivedGame(game => { foldGame(game); });
  flushInsights();
  console.log(`[insights] rebuilt from ${seen} game(s) in ${Date.now() - startedAt}ms`);
  return seen;
}

/**
 * Load the aggregate, or rebuild it when there is nothing usable to load.
 *
 * Anything archived after the last fold is picked up here: a crash between a game being
 * written and the aggregate being flushed would otherwise lose that game from every
 * number on the panel while leaving it in the archive, and that sort of drift is how
 * people stop trusting a dashboard.
 */
export function initInsights(): void {
  if (ready) return;
  ready = true;

  let loaded: State | null = null;
  try {
    loaded = JSON.parse(fs.readFileSync(FILE, 'utf8')) as State;
  } catch { loaded = null; }

  if (!loaded || loaded.schema !== INSIGHTS_SCHEMA) {
    if (loaded) console.log('[insights] schema changed; rebuilding');
    rebuildInsights();
    return;
  }

  state = { ...emptyState(), ...loaded, funnel: { ...emptyFunnel(), ...loaded.funnel } };

  // A day of overlap rather than an exact cut: `finishedAt` is a wall clock, and the
  // `recent` list is what actually decides, so the window only has to be wide enough to
  // contain anything the last flush might have missed.
  const window = state.lastFinishedAt - 24 * 60 * 60 * 1000;
  let caught = 0;
  eachArchivedGame(game => {
    if (game.finishedAt < window) return;
    if (foldGame(game)) caught++;
  });
  if (caught > 0) console.log(`[insights] caught up on ${caught} game(s)`);
  console.log(`[insights] ${state.covered} measured game(s), `
    + `${state.unmeasured} without metrics`);
}

// ---------- the view ----------

/**
 * A percentile read off a histogram, interpolated inside the bucket it lands in.
 *
 * Exact to the bucket width and no further, which is why the buckets are narrow where the
 * answers matter. The open-ended top bucket is bounded by the largest sample seen.
 */
function quantile(h: Hist, bounds: number[], p: number): number {
  if (h.n === 0) return 0;
  const target = h.n * (p / 100);
  let cum = 0;
  for (let i = 0; i < h.counts.length; i++) {
    const c = h.counts[i];
    if (c > 0 && cum + c >= target) {
      const lo = i === 0 ? 0 : bounds[i - 1];
      const hi = i < bounds.length ? bounds[i] : Math.max(h.max, lo);
      return Math.round(lo + (hi - lo) * ((target - cum) / c));
    }
    cum += c;
  }
  return Math.round(h.max);
}

function distribution(h: Hist, bounds: number[], unit: Distribution['unit']): Distribution {
  return {
    bounds,
    counts: h.counts,
    n: h.n,
    mean: h.n > 0 ? h.sum / h.n : 0,
    p50: quantile(h, bounds, 50),
    p90: quantile(h, bounds, 90),
    max: Math.round(h.max),
    unit,
  };
}

function phaseView(phase: Phase, a: PhaseAcc): PhaseInsights {
  const per = (n: number): number => (a.plies > 0 ? n / a.plies : 0);
  return {
    phase,
    plies: a.plies,
    openTurnRate: per(a.open),
    affordableRatio: per(a.ratio),
    emergencyRate: per(a.emergency),
    hangRate: per(a.hangs),
    autoRate: per(a.auto),
  };
}

function modeView(mode: GameMode, a: ModeAcc): ModeInsights {
  const per = (n: number): number => (a.plies > 0 ? n / a.plies : 0);
  const perGame = (n: number): number => (a.games > 0 ? n / a.games : 0);
  // Card counters are only meaningful over plies that had a hand behind them, which in
  // team mode is none of them.
  const perCard = (n: number): number => (a.cardPlies > 0 ? n / a.cardPlies : 0);
  return {
    mode,
    games: a.games,
    plies: a.plies,
    openTurnRate: per(a.open),
    affordableRatio: a.ratioN > 0 ? a.ratio / a.ratioN : 1,
    onlyKingRate: per(a.onlyKing),
    forcedRate: per(a.forced),
    checkRate: per(a.checks),
    captureRate: per(a.captures),
    hangRate: per(a.hangs),
    missedMean: per(a.missed),
    autoRate: per(a.auto),
    botRate: per(a.bot),
    emergencyRate: perCard(a.emergency),
    sacrificesPerGame: perGame(a.sacrifice),
    deadHeldMean: perCard(a.deadHeld),
    atCapRate: perCard(a.atCap),
    cyclesPerGame: perGame(a.cycles),
    replacementsPerGame: perGame(a.replacements),
    drawnKinds: { ...a.drawnKinds },
    spentKinds: { ...a.spentKinds },
    results: { ...a.results },
    reasons: { ...a.reasons },
    abandonRate: perGame(a.results.unfinished ?? 0),
    comebackRate: perGame(a.comebacks),
    leadChangesMean: perGame(a.leadChanges),
    clientPlies: a.clientPlies,
    pickupsPerPly: a.clientPlies > 0 ? a.pickups / a.clientPlies : 0,
    cardSelectionsPerPly: a.clientPlies > 0 ? a.cardSelections / a.clientPlies : 0,
    premovesPlayed: a.premovesPlayed,
    premovesRejected: a.premovesRejected,
    reviewOpens: a.reviewOpens,
    drawerOpens: a.drawerOpens,
    devices: { ...a.devices },
    pointers: { ...a.pointers },
    fx: { ...a.fx },
    firstTouch: distribution(a.touch, TOUCH_BOUNDS, 'ms'),
    phases: (['early', 'middle', 'late'] as Phase[]).map(p => phaseView(p, a.phases[p])),
    think: distribution(a.think, THINK_BOUNDS, 'ms'),
    wait: distribution(a.wait, WAIT_BOUNDS, 'ms'),
    length: distribution(a.length, LENGTH_BOUNDS, 'plies'),
    duration: distribution(a.duration, DURATION_BOUNDS, 'ms'),
  };
}

// ---------- guardrails ----------

interface Target {
  key: string;
  label: string;
  scope: GameMode | 'all';
  unit: GuardrailRow['unit'];
  min: number | null;
  max: number | null;
  target: string;
  why: string;
  /**
   * How many samples before this is graded rather than reported as unknown, in whatever
   * `read` counts -- plies for a per-ply rate, games for a per-game one. Getting this from
   * the unit instead was wrong in the one case it mattered: an abandonment rate is a share
   * of games, and holding it to two hundred of them would leave it blank for months.
   */
  floor: number;
  /** Null when the play it needs has not happened yet. */
  read: (modes: Record<string, ModeInsights>, funnel: FunnelInsights)
    => { value: number | null; samples: number };
}

/**
 * The declared targets, in one place, so the panel and the balance harness are held to
 * the same numbers. Section 8 of `docs/METRICS.md` is the argument for each of them; this
 * is only where they are written down.
 */
export const TARGETS: Target[] = [
  {
    key: 'openTurnRate', label: 'Open turns', scope: 'cards', unit: 'pct',
    min: 0.10, max: 0.20, target: '10-20%', floor: MIN_PLIES,
    why: 'Turns where every legal move was affordable anyway. Above this the cards are '
      + 'decorative; below it the hand is a cage.',
    read: m => ({ value: m.cards?.openTurnRate ?? null, samples: m.cards?.plies ?? 0 }),
  },
  {
    key: 'emergencyRate', label: 'Emergency turns', scope: 'cards', unit: 'pct',
    min: null, max: 0.03, target: 'under 3%', floor: MIN_PLIES,
    why: 'The safety net opening. The design calls it insurance, not a normal turn.',
    read: m => ({ value: m.cards?.emergencyRate ?? null, samples: m.cards?.plies ?? 0 }),
  },
  {
    key: 'sacrificesPerGame', label: 'Sacrifices per game', scope: 'cards', unit: 'ratio',
    min: 0.33, max: 0.5, target: '1 per 2-3 games', floor: MIN_GAMES,
    why: 'A rescue, not a tax.',
    read: m => ({ value: m.cards?.sacrificesPerGame ?? null, samples: m.cards?.games ?? 0 }),
  },
  {
    key: 'autoRate', label: 'Moves the clock played', scope: 'all', unit: 'pct',
    min: null, max: 0.05, target: 'under 5%', floor: MIN_PLIES,
    why: 'Past this the clock is playing the game rather than pacing it.',
    read: m => {
      const all = Object.values(m);
      const plies = all.reduce((a, x) => a + x.plies, 0);
      if (plies === 0) return { value: null, samples: 0 };
      return {
        value: all.reduce((a, x) => a + x.autoRate * x.plies, 0) / plies,
        samples: plies,
      };
    },
  },
  {
    key: 'waitP90', label: 'p90 wait between turns', scope: 'team', unit: 'ms',
    min: null, max: 90e3, target: 'under 90s', floor: MIN_PLIES,
    why: 'What the rotation actually costs: in a 5v5 you wait four turns to move once.',
    read: m => ({
      value: m.team?.wait.n ? m.team.wait.p90 : null, samples: m.team?.wait.n ?? 0,
    }),
  },
  {
    key: 'abandonRate', label: 'Abandoned games', scope: 'all', unit: 'pct',
    min: null, max: 0.15, target: 'under 15%', floor: MIN_GAMES,
    why: 'Everyone left mid-play. The strongest "this is not fun" signal we can measure.',
    read: m => {
      const all = Object.values(m);
      const games = all.reduce((a, x) => a + x.games, 0);
      if (games === 0) return { value: null, samples: 0 };
      return {
        value: all.reduce((a, x) => a + (x.results.unfinished ?? 0), 0) / games,
        samples: games,
      };
    },
  },
  {
    key: 'rematchRate', label: 'Rooms that played again', scope: 'all', unit: 'pct',
    min: null, max: null, target: 'as high as it will go', floor: MIN_GAMES,
    why: 'The strongest "this is fun" signal. No ceiling, so it is read rather than judged.',
    read: (_m, f) => ({
      value: f.started > 0 ? f.rematch / f.started : null, samples: f.started,
    }),
  },
];

/**
 * A value against its target.
 *
 * `watch` is the band just outside the target -- a quarter of the way out -- because a
 * metric that has just crossed the line and one that has left the county both being red
 * says nothing about which to look at first.
 */
function grade(t: Target, value: number, samples: number): GuardrailRow['status'] {
  if (t.min == null && t.max == null) return 'info';
  if (samples < t.floor) return 'unknown';
  const span = t.min != null && t.max != null ? t.max - t.min : null;
  const slack = (bound: number): number =>
    (span != null ? span * 0.25 : Math.abs(bound) * 0.25);
  if (t.max != null && value > t.max) return value > t.max + slack(t.max) ? 'off' : 'watch';
  if (t.min != null && value < t.min) return value < t.min - slack(t.min) ? 'off' : 'watch';
  return 'good';
}

export function guardrails(modes: ModeInsights[], funnel: FunnelInsights): GuardrailRow[] {
  const byMode: Record<string, ModeInsights> = {};
  for (const m of modes) byMode[m.mode] = m;

  return TARGETS.map(t => {
    const { value, samples } = t.read(byMode, funnel);
    return {
      key: t.key,
      label: t.label,
      scope: t.scope,
      value,
      unit: t.unit,
      min: t.min,
      max: t.max,
      target: t.target,
      status: value == null ? 'unknown' : grade(t, value, samples),
      samples,
      why: t.why,
    };
  });
}

/** Everything the panel draws, derived from the counters on the way out. */
export function insightsView(): Insights {
  if (!ready) initInsights();

  const modes = Object.entries(state.modes)
    .map(([mode, acc]) => modeView(mode as GameMode, acc))
    .sort((a, b) => b.games - a.games);

  const daily = Object.entries(state.daily)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, d]) => ({ day, games: d.games, plies: d.plies }));

  return {
    schema: INSIGHTS_SCHEMA,
    updatedAt: state.updatedAt,
    gamesCovered: state.covered,
    gamesUnmeasured: state.unmeasured,
    modes,
    daily,
    funnel: { ...state.funnel },
    guardrails: guardrails(modes, state.funnel),
  };
}

/** Where the aggregate lives, for the tests and for anyone wondering. */
export function insightsFile(): string {
  return FILE;
}
