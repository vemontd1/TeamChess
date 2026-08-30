/**
 * Balance harness for Chess Cards.
 *
 * The mode's whole premise is "I can see the move — can I play it?", which only works if
 * the answer is often no. That is not something you can reason out from the deck list: it
 * depends on how many *distinct* kinds a hand tends to hold, on how many piece types have
 * legal moves in a real position, and on how often a single Wild quietly unlocks all of
 * them at once.
 *
 * So this plays games. Both sides pick uniformly at random from the moves their hand can
 * actually pay for, running the real engine from `server/src/cards.ts` -- the same draw,
 * spend, reshuffle and emergency code the server runs -- and records, at every turn, how
 * much of the board the hand was actually holding shut.
 *
 *   npm run balance            the shipped tuning
 *   npm run balance -- --all   every candidate, side by side
 *
 * The number that matters most is `open`: the share of turns where every legal move was
 * affordable anyway, i.e. where the cards were not a constraint at all.
 */
import { pathToFileURL } from 'node:url';
import { Chess } from 'chess.js';
import {
  TUNING, createCards, drawCards, drawBonus, drawPerTurnFor, extinctTypes, replaceExtinct,
  cycleForPlayable, resolveSpend, commitSpend, cardPlayable, deadHeldCount,
  extinctHeldCount,
} from '../server/src/cards.ts';
import { computeChoiceSet } from '../server/src/metrics.ts';

/**
 * The choice set comes from `server/src/metrics.ts`, the same function the live server
 * records with. That is the whole point of the module: a simulated `open` and a real-play
 * `open` computed by different code are two numbers that cannot be compared, and comparing
 * them is the only reason to have either. This harness is a *predictor* of production, or
 * it is nothing.
 */

/** Set BALANCE_NO_SWAP=1 to measure without the extinct-card replacement, for comparison. */
const SWAP = process.env.BALANCE_NO_SWAP !== '1';

const GAMES = Number(process.env.GAMES ?? 120);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 60);

/**
 * Play the games and return the rates. Exported so `test/guardrails.mjs` can hold the
 * simulation to the targets in `docs/METRICS.md` without a second copy of this loop.
 */
export function simulate() {
  const s = {
    turns: 0, open: 0, moveCov: 0, typeCov: 0, emergency: 0, wild: 0,
    distinct: 0, handSize: 0, stuckToKing: 0, plies: 0, games: 0,
    swapped: 0, swapTurns: 0, deadHeld: 0, cycled: 0, atCap: 0, dead: 0, forced: 0,
    lateTurns: 0, lateOpen: 0, lateMoveCov: 0, lateTypeCov: 0,
    lateEmergency: 0, lateDead: 0, lateSwap: 0,
  };

  for (let g = 0; g < GAMES; g++) {
    const chess = new Chess();
    const cards = createCards();
    s.games++;

    for (let ply = 0; ply < MAX_PLIES && !chess.isGameOver(); ply++) {
      const color = chess.turn() === 'w' ? 'white' : 'black';
      const side = cards[color];

      // exactly what the server does at the start of a turn. `moves()` dominates the
      // runtime, so it is generated once here and the movable-type set derived from it,
      // rather than letting movableTypes/refreshEmergency each regenerate it.
      // The opening hand is the deal for each side's first turn, exactly as the server
      // has it -- dealing on plies 0 and 1 as well would measure a hand nobody is dealt.
      if (ply > 1) drawCards(side, drawPerTurnFor(ply));
      if (SWAP) {
        const swapped = replaceExtinct(side, extinctTypes(chess, color));
        s.swapped += swapped.length;
        if (swapped.length > 0) { s.swapTurns++; if (ply >= 50) s.lateSwap++; }
      }

      const legal = chess.moves({ verbose: true });
      if (legal.length === 0) break;
      // cycling is part of the live engine, so the harness runs it too -- otherwise this
      // measures a hand the server would never have left the player holding
      if (!chess.inCheck()) s.cycled += cycleForPlayable(side, chess).length;
      const movable = new Set(legal.map(m => m.piece));
      side.emergency = side.hand.length === 0
        || !side.hand.some(c => cardPlayable(c, movable));

      // the server's own definition, not a second one that looks like it
      const cs = computeChoiceSet(chess, side);
      const affordable = legal.filter(m => cs.reach.has(m.piece));
      if (affordable.length === 0) break;

      s.turns++;
      s.plies++;
      // "late" is from ply 50: pieces have started coming off, which is when a card for a
      // piece you no longer own stops being a rarity and starts being most of your hand
      const late = ply >= 50;
      if (late) s.lateTurns++;
      if (cs.openTurn) { s.open++; if (late) s.lateOpen++; }
      const moveCov = cs.affordableMoves / cs.legalMoves;
      const typeCov = cs.affordableTypes / cs.legalTypes;
      s.moveCov += moveCov;
      s.typeCov += typeCov;
      if (late) {
        s.lateMoveCov += moveCov;
        s.lateTypeCov += typeCov;
        if (side.emergency) s.lateEmergency++;
      }
      if (side.emergency) s.emergency++;
      if (side.hand.some(c => c.kind === 'wild')) s.wild++;
      // cards held for a piece that no longer exists: dead weight, not a constraint
      const deadNow = extinctHeldCount(side, extinctTypes(chess, color));
      s.deadHeld += deadNow;
      s.dead += deadHeldCount(side, movable);
      if (late) s.lateDead += deadNow;
      s.distinct += new Set(side.hand.map(c => c.kind)).size;
      s.handSize += side.hand.length;
      if (side.hand.length >= TUNING.handMax) s.atCap++;
      // the pinch that actually hurts: the only thing you may move is the king
      if (cs.onlyKing) s.stuckToKing++;
      if (cs.forced) s.forced++;

      const pick = affordable[Math.floor(Math.random() * affordable.length)];
      const spend = resolveSpend(side, pick.piece);
      chess.move({ from: pick.from, to: pick.to, promotion: pick.promotion ?? 'q' });
      if (spend) commitSpend(side, spend);
      if (pick.captured) drawBonus(side);
    }
  }

  const per = n => n / s.turns;
  return {
    open: per(s.open),
    moveCov: per(s.moveCov),
    typeCov: per(s.typeCov),
    emergency: per(s.emergency),
    wild: per(s.wild),
    stuckToKing: per(s.stuckToKing),
    distinct: per(s.distinct),
    handSize: per(s.handSize),
    swapTurns: per(s.swapTurns),
    deadHeld: per(s.deadHeld),
    cycled: per(s.cycled),
    atCap: per(s.atCap),
    dead: per(s.dead),
    forced: per(s.forced),
    late: s.lateTurns === 0 ? null : {
      open: s.lateOpen / s.lateTurns,
      moveCov: s.lateMoveCov / s.lateTurns,
      typeCov: s.lateTypeCov / s.lateTurns,
      emergency: s.lateEmergency / s.lateTurns,
      deadHeld: s.lateDead / s.lateTurns,
      swapTurns: s.lateSwap / s.lateTurns,
      turns: s.lateTurns,
    },
  };
}

function withTuning(patch, fn) {
  const before = { ...TUNING, deck: TUNING.deck };
  Object.assign(TUNING, patch);
  try { return fn(); } finally { Object.assign(TUNING, before); }
}

const pct = x => `${(x * 100).toFixed(1)}%`.padStart(6);
const num = x => x.toFixed(2).padStart(5);

function row(name, r) {
  console.log(
    `  ${name.padEnd(30)} ${pct(r.open)} ${pct(r.moveCov)} ${pct(r.typeCov)} `
    + `${pct(r.emergency)} ${pct(r.wild)} ${pct(r.stuckToKing)} ${num(r.distinct)} `
    + `${num(r.handSize)} ${pct(r.atCap)} ${num(r.cycled)} ${num(r.deadHeld)}`);
}

function header() {
  console.log(
    `  ${'tuning'.padEnd(30)} ${'open'.padStart(6)} ${'moves'.padStart(6)} `
    + `${'types'.padStart(6)} ${'emerg'.padStart(6)} ${'wild'.padStart(6)} `
    + `${'king'.padStart(6)} ${'kinds'.padStart(5)} ${'hand'.padStart(5)} `
    + `${'cap'.padStart(6)} ${'cyc'.padStart(5)} ${'dead'.padStart(5)}`);
  console.log(`  ${'-'.repeat(30)} ------ ------ ------ ------ ------ ------ ----- ----- ------ ----- -----`);
}

const D = {
  /** The design doc's own list, for reference: this is what measured too loose. */
  doc:     [['pawn', 10], ['knight', 7], ['bishop', 7], ['rook', 5], ['queen', 3], ['wild', 4]],
  /** The doc's shape with Wild cut to one, padded back to 36. */
  tight:   [['pawn', 11], ['knight', 8], ['bishop', 8], ['rook', 5], ['queen', 3], ['wild', 1]],
  /** More duplicates still -- fewer distinct kinds per hand, but pawns cover more moves. */
  heavy:   [['pawn', 14], ['knight', 8], ['bishop', 7], ['rook', 4], ['queen', 2], ['wild', 1]],
  /** Heavier again: the cheapest way to keep a seven-card hand down to a few kinds. */
  heavier: [['pawn', 17], ['knight', 8], ['bishop', 6], ['rook', 3], ['queen', 1], ['wild', 1]],
  /** Fewer pawns: lowest move coverage of all, at the cost of a much busier safety net. */
  light:   [['pawn', 6], ['knight', 8], ['bishop', 8], ['rook', 8], ['queen', 5], ['wild', 1]],
};

/**
 * The retune, measured against what shipped before it.
 *
 * The economy changed shape as well as size: an opening hand of one card per kind, a
 * fixed deal of two a turn against a one-card move cost, and section 10's cap of seven.
 * The old refill-to-a-target rows are kept for comparison -- they are what the numbers in
 * `docs/BALANCE.md` were taken against. A refill is a deal of "as many as will fit" into
 * a cap that is itself the target, which is exactly what the old code did.
 */
const REFILL = target => ({ openingKinds: new Array(target).fill('pawn'),
                            drawPerTurn: 99, enrageDrawPerTurn: 99, handMax: target });

const CANDIDATES = [
  ['old: refill to 3, tight', { deck: D.tight, ...REFILL(3) }],
  ['old: refill to 5, tight', { deck: D.tight, ...REFILL(5) }],
  ['deal 2 cap 7, tight', { deck: D.tight }],
  ['deal 2 cap 7, heavy', { deck: D.heavy }],
  ['deal 2 cap 7, heavier', { deck: D.heavier }],
  ['deal 2 cap 6, heavy', { deck: D.heavy, handMax: 6 }],
  ['deal 2 cap 5, heavy', { deck: D.heavy, handMax: 5 }],
  ['deal 1 cap 7, heavy', { deck: D.heavy, drawPerTurn: 1, enrageDrawPerTurn: 2 }],
];

/**
 * Only when run directly. Importing this file is how the guardrail check reaches
 * `simulate`, and an import that prints a table is an import nobody wants.
 */
const RUN_CLI = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (RUN_CLI) {
console.log(`\nChess Cards balance — ${GAMES} games, up to ${MAX_PLIES} plies each`);
console.log('\n  open  = turns where every legal move was affordable (the cards did nothing)');
console.log('  moves = share of legal moves the hand could pay for');
console.log('  types = share of movable piece types the hand could reach');
console.log('  emerg = turns the safety net had to open');
console.log('  wild  = turns holding at least one Wild');
console.log('  king  = turns where the only affordable move was a king move\n');

header();
if (process.argv.includes('--all')) {
  for (const [name, patch] of CANDIDATES) row(name, withTuning(patch, simulate));
  console.log();
}
const shipped = simulate();
row('SHIPPED', shipped);
if (shipped.late) {
  const L = shipped.late;
  console.log(`
  From ply 50 on (${L.turns} turns) — where pieces have come off the board:`);
  console.log(`    open ${pct(L.open)}   moves ${pct(L.moveCov)}   types ${pct(L.typeCov)}`
    + `   emerg ${pct(L.emergency)}   swap ${pct(L.swapTurns)}   dead ${num(L.deadHeld)}`);
}
console.log();
}
