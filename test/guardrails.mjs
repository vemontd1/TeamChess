/**
 * The balance targets, checked rather than remembered.
 *
 * `docs/METRICS.md` section 8 declares a range for each number the mode is tuned against.
 * A range in a document is a thing somebody has to think to check; a range in a test is a
 * thing that says so on its own the next time the deck, the draw or the hand cap moves.
 *
 * The targets come from `server/src/insights.ts` -- the same list the admin panel grades
 * real play against -- so the simulation and production are never held to two different
 * numbers.
 *
 * This measures the *simulation*: random affordable moves, no sacrifices, no clock. It
 * therefore checks only the targets a random-mover can be held to. The rest of section 8
 * is answered by real play, on the panel.
 */
import { TARGETS } from '../server/src/insights.ts';

/** Enough games that a tuning change moves the number further than the noise does. */
const GAMES = Number(process.env.GAMES ?? 400);
// Set before the harness is loaded: it reads the count once, at import.
process.env.GAMES = String(GAMES);
const { simulate } = await import('./balance.mjs');

const pct = x => `${(x * 100).toFixed(1)}%`;

let failures = 0;
function within(key, value) {
  const t = TARGETS.find(x => x.key === key);
  if (!t) { failures++; console.log(`  FAIL  no target called ${key}`); return; }
  const low = t.min != null && value < t.min;
  const high = t.max != null && value > t.max;
  if (low || high) {
    failures++;
    console.log(`  FAIL  ${t.label}: ${pct(value)}, target ${t.target}`);
    console.log(`        ${t.why}`);
  } else {
    console.log(`  PASS  ${t.label}: ${pct(value)}, target ${t.target}`);
  }
}

console.log(`\nBalance guardrails - ${GAMES} simulated games`);
console.log('  The harness plays random affordable moves, so these are the mode\'s own');
console.log('  numbers with no player steering them.\n');

const r = simulate();
within('openTurnRate', r.open);
within('emergencyRate', r.emergency);

console.log(`\n  (for reference: ${pct(r.moveCov)} of legal moves affordable, `
  + `${pct(r.typeCov)} of movable types, ${pct(r.stuckToKing)} king-only turns)`);

if (r.late) {
  // The endgame is where the hand cap shrinks with the army, and where a tuning that
  // looks fine on average can still be a cage. Reported, not gated: the targets are
  // declared for the game as a whole.
  console.log(`  (from ply 50: open ${pct(r.late.open)}, `
    + `emergency ${pct(r.late.emergency)})`);
}

console.log(`\n${failures === 0 ? 'ALL GUARDRAILS HELD' : `${failures} GUARDRAIL(S) BREACHED`}`);
process.exit(failures === 0 ? 0 : 1);
