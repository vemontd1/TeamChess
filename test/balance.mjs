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
import { Chess } from 'chess.js';
import {
  TUNING, createCards, drawUpTo, drawBonus, drawTargetFor,
  resolveSpend, commitSpend, cardPlayable, cardCovers,
} from '../server/src/cards.ts';

const GAMES = Number(process.env.GAMES ?? 120);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 60);

/** Piece types this hand can pay for, king included -- he is always free. */
function reach(side, movable) {
  const out = new Set(['k']);
  if (side.emergency) { for (const t of 'pnbrq') out.add(t); return out; }
  for (const type of movable) {
    if (side.hand.some(c => cardCovers(c, type))) out.add(type);
  }
  return out;
}

function simulate() {
  const s = {
    turns: 0, open: 0, moveCov: 0, typeCov: 0, emergency: 0, wild: 0,
    distinct: 0, handSize: 0, stuckToKing: 0, plies: 0, games: 0,
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
      drawUpTo(side, drawTargetFor(ply));

      const legal = chess.moves({ verbose: true });
      if (legal.length === 0) break;
      const movable = new Set(legal.map(m => m.piece));
      side.emergency = side.hand.length === 0
        || !side.hand.some(c => cardPlayable(c, movable));
      const r = reach(side, movable);
      const affordable = legal.filter(m => r.has(m.piece));

      s.turns++;
      s.plies++;
      if (affordable.length === legal.length) s.open++;
      s.moveCov += affordable.length / legal.length;
      s.typeCov += [...movable].filter(t => r.has(t)).length / movable.size;
      if (side.emergency) s.emergency++;
      if (side.hand.some(c => c.kind === 'wild')) s.wild++;
      s.distinct += new Set(side.hand.map(c => c.kind)).size;
      s.handSize += side.hand.length;
      // the pinch that actually hurts: the only thing you may move is the king
      if (affordable.every(m => m.piece === 'k')) s.stuckToKing++;

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
    + `${pct(r.emergency)} ${pct(r.wild)} ${pct(r.stuckToKing)} ${num(r.distinct)} ${num(r.handSize)}`);
}

function header() {
  console.log(
    `  ${'tuning'.padEnd(30)} ${'open'.padStart(6)} ${'moves'.padStart(6)} `
    + `${'types'.padStart(6)} ${'emerg'.padStart(6)} ${'wild'.padStart(6)} `
    + `${'king'.padStart(6)} ${'kinds'.padStart(5)} ${'hand'.padStart(5)}`);
  console.log(`  ${'-'.repeat(30)} ------ ------ ------ ------ ------ ------ ----- -----`);
}

const D = {
  /** The design doc's own list, for reference: this is what measured too loose. */
  doc:   [['pawn', 10], ['knight', 7], ['bishop', 7], ['rook', 5], ['queen', 3], ['wild', 4]],
  /** The doc's shape with Wild cut to one, padded back to 36. */
  tight: [['pawn', 11], ['knight', 8], ['bishop', 8], ['rook', 5], ['queen', 3], ['wild', 1]],
  /** More duplicates still -- fewer distinct kinds per hand, but pawns cover more moves. */
  heavy: [['pawn', 14], ['knight', 8], ['bishop', 7], ['rook', 4], ['queen', 2], ['wild', 1]],
  /** Fewer pawns: lowest move coverage of all, at the cost of a much busier safety net. */
  light: [['pawn', 6], ['knight', 8], ['bishop', 8], ['rook', 8], ['queen', 5], ['wild', 1]],
};

const CANDIDATES = [
  ['doc: hand 5, 4 wild', { deck: D.doc, drawTarget: 5, enrageDrawTarget: 6 }],
  ['tight deck, hand 5', { deck: D.tight, drawTarget: 5, enrageDrawTarget: 6 }],
  ['tight deck, hand 4', { deck: D.tight, drawTarget: 4, enrageDrawTarget: 5 }],
  ['tight deck, hand 3', { deck: D.tight, drawTarget: 3, enrageDrawTarget: 4 }],
  ['heavy deck, hand 3', { deck: D.heavy, drawTarget: 3, enrageDrawTarget: 4 }],
  ['light deck, hand 3', { deck: D.light, drawTarget: 3, enrageDrawTarget: 4 }],
  ['tight deck, hand 2', { deck: D.tight, drawTarget: 2, enrageDrawTarget: 3 }],
];

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
row('SHIPPED', simulate());
console.log();
