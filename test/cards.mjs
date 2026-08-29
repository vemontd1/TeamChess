/**
 * Unit tests for the Chess Cards engine.
 *
 * The integration suite plays real games over real sockets, which is the right way to
 * check the mode end to end -- but the deck is shuffled, so the paths that only open on
 * an unlucky hand (the emergency move, a deck running dry) may not come up in a hundred
 * runs. Those are reached here by building the hand deliberately.
 *
 * Run through tsx, since it imports the server's TypeScript directly.
 */
import { Chess } from 'chess.js';
import {
  TUNING, deckSize, createCards, drawUpTo, drawBonus, drawTargetFor, isEnraged,
  movableTypes, cardPlayable, cardCovers, refreshEmergency, resolveSpend, commitSpend,
  mulligan, cardsPublic, handView, snapshotCards, EMERGENCY_CARD_ID,
} from '../server/src/cards.ts';

/* Assertions read the tuning rather than restating it, so retuning the mode does not
   mean rewriting the tests -- only the composition block below, which is the one place
   the shipped numbers are deliberately pinned. */
const HAND = TUNING.drawTarget;
const DECK = deckSize();

let failures = 0;
const log = (...a) => console.log(...a);
function check(name, cond, extra = '') {
  if (cond) log(`  PASS  ${name}`);
  else { failures++; log(`  FAIL  ${name} ${extra}`); }
}

/** A hand built to order, so a test can put a player in an exact spot. */
function handOf(...kinds) {
  return kinds.map((kind, i) => ({ id: 1000 + i, kind }));
}

function bareSide(...kinds) {
  return {
    hand: handOf(...kinds), deck: [], discard: [], mulliganUsed: false,
    played: [], emergenciesUsed: 0, emergency: false,
  };
}

log('\n=== 1. The shipped deck ===');
// The doc's shape at thirty-six, with Wild cut from four copies to one. See
// docs/BALANCE.md: four Wilds put one in 26% of turns, and a Wild unlocks everything.
const cards = createCards();
const all = [...cards.white.hand, ...cards.white.deck];
const tally = {};
for (const c of all) tally[c.kind] = (tally[c.kind] ?? 0) + 1;
check('thirty-six cards per side', all.length === 36, String(all.length));
check('eleven pawns', tally.pawn === 11, String(tally.pawn));
check('eight knights', tally.knight === 8, String(tally.knight));
check('eight bishops', tally.bishop === 8, String(tally.bishop));
check('five rooks', tally.rook === 5, String(tally.rook));
check('three queens', tally.queen === 3, String(tally.queen));
check('a single wild', tally.wild === 1, String(tally.wild));
check('the opening hand is three', HAND === 3, String(HAND));
check('both sides open on a full hand',
  cards.white.hand.length === HAND && cards.black.hand.length === HAND);
check('the two decks are separate objects', cards.white.deck !== cards.black.deck);
check('no card id is shared across the two decks', (() => {
  const w = new Set([...cards.white.hand, ...cards.white.deck].map(c => c.id));
  return [...cards.black.hand, ...cards.black.deck].every(c => !w.has(c.id));
})());

log('\n=== 2. A card covers exactly its own piece; Wild covers all but the king ===');
const [pawnCard] = handOf('pawn');
const [wildCard] = handOf('wild');
check('a pawn card covers a pawn', cardCovers(pawnCard, 'p'));
check('a pawn card does not cover a knight', !cardCovers(pawnCard, 'n'));
check('a wild covers a queen', cardCovers(wildCard, 'q'));
check('no card is ever needed for the king', !cardCovers(wildCard, 'k')
  && !cardCovers(pawnCard, 'k'));

const opening = new Chess();
const openMovable = movableTypes(opening);
check('only pawns and knights can move from the start',
  openMovable.has('p') && openMovable.has('n') && openMovable.size === 2,
  [...openMovable].join(''));
check('a rook card is dead in the opening position',
  !cardPlayable(handOf('rook')[0], openMovable));
check('a wild is live whenever anything can move',
  cardPlayable(wildCard, openMovable));

log('\n=== 3. The emergency move opens only when the hand is truly dead ===');
const dead = bareSide('rook', 'rook', 'queen', 'bishop', 'bishop');
refreshEmergency(dead, opening);
check('a hand of rooks, bishops and a queen is dead in the opening', dead.emergency === true);

const live = bareSide('rook', 'knight');
refreshEmergency(live, opening);
check('one playable card keeps the safety net shut', live.emergency === false);

check('a dead hand cannot pay for a knight the ordinary way',
  resolveSpend(dead, 'n') !== null && resolveSpend(dead, 'n').kind === 'emergency');
check('a dead hand still moves the king for free',
  resolveSpend(dead, 'k').kind === 'none');
check('a live hand pays for the knight with the knight card', (() => {
  const s = resolveSpend(live, 'n');
  return s.kind === 'card' && s.card.kind === 'knight';
})());
check('a live hand cannot claim the emergency move',
  resolveSpend(live, 'r', EMERGENCY_CARD_ID) === null);
check('a dead hand may claim it explicitly',
  resolveSpend(dead, 'r', EMERGENCY_CARD_ID).kind === 'emergency');

log('\n=== 4. The emergency move costs one card off the top of a dead hand ===');
const spentEmergency = commitSpend(dead, { kind: 'emergency' });
check('a card left the hand', dead.hand.length === 4, String(dead.hand.length));
check('it went to the discard pile', dead.discard.length === 1);
check('it is recorded publicly', dead.played.length === 1 && dead.played[0] === spentEmergency);
check('the emergency is counted', dead.emergenciesUsed === 1);

const empty = bareSide();
refreshEmergency(empty, opening);
check('an empty hand also opens the safety net', empty.emergency === true);
commitSpend(empty, { kind: 'emergency' });
check('and taking it with nothing to discard is harmless',
  empty.hand.length === 0 && empty.discard.length === 0 && empty.emergenciesUsed === 1);

log('\n=== 5. Spending prefers the exact card, then a Wild ===');
const mixed = bareSide('pawn', 'wild', 'knight');
const forKnight = resolveSpend(mixed, 'n');
check('a knight move takes the knight card, not the wild',
  forKnight.kind === 'card' && forKnight.card.kind === 'knight');
const forBishop = resolveSpend(mixed, 'b');
check('a bishop move with no bishop card falls back to the wild',
  forBishop.kind === 'card' && forBishop.card.kind === 'wild');
check('a move nothing covers and no safety net is refused',
  (() => { const s = bareSide('pawn'); s.emergency = false; return resolveSpend(s, 'q'); })()
    === null);

commitSpend(mixed, forKnight);
check('the spent card leaves the hand', mixed.hand.length === 2);
check('and lands face up on the discard', mixed.discard[0].kind === 'knight');
check('a named card that is not in your hand is refused',
  resolveSpend(mixed, 'p', 999_999) === null);
check('a named card that does not cover the piece is refused', (() => {
  const s = bareSide('pawn', 'rook');
  return resolveSpend(s, 'r', s.hand[0].id) === null;   // the pawn card, for a rook
})());

log('\n=== 6. Drawing, the cap, and the tempo bonus ===');
const drawer = createCards().white;
drawer.hand = [];
check('drawing to the target fills the hand',
  drawUpTo(drawer, HAND) === HAND && drawer.hand.length === HAND);
check('drawing again when already at target takes none', drawUpTo(drawer, HAND) === 0);
check('a capture draws one more',
  drawBonus(drawer) === 1 && drawer.hand.length === HAND + 1);
drawUpTo(drawer, TUNING.handMax);
check('the cap is seven', drawer.hand.length === 7, String(drawer.hand.length));
check('the bonus refuses to pass the cap',
  drawBonus(drawer) === 0 && drawer.hand.length === 7);
check('and drawing to a target above the cap stops at it',
  drawUpTo(drawer, 9) === 0 && drawer.hand.length === 7);

log('\n=== 7. An exhausted deck reshuffles the discard ===');
const cycler = createCards().white;
cycler.discard = cycler.deck.splice(0);   // the whole deck face up, nothing to draw
cycler.hand = [];
check('the deck really is empty',
  cycler.deck.length === 0 && cycler.discard.length === DECK - HAND);
const redrawn = drawUpTo(cycler, HAND);
check('the discard becomes the new deck', redrawn === HAND && cycler.hand.length === HAND);
check('and the discard pile is now empty', cycler.discard.length === 0);
check('no card was lost in the shuffle',
  cycler.deck.length + cycler.hand.length === DECK - HAND,
  String(cycler.deck.length + cycler.hand.length));

log('\n=== 8. Soft enrage, at twenty plies ===');
check('the base target before twenty plies',
  drawTargetFor(19) === TUNING.drawTarget && !isEnraged(19));
check('one more from the twentieth',
  drawTargetFor(20) === TUNING.enrageDrawTarget && isEnraged(20)
  && TUNING.enrageDrawTarget === TUNING.drawTarget + 1);
check('and it stays there', drawTargetFor(64) === TUNING.enrageDrawTarget);

log('\n=== 9. Mulligan, once a game ===');
const mull = createCards().black;
const before = mull.hand.map(c => c.id).join(',');
check('the first mulligan is granted', mulligan(mull, HAND) === true);
check('it deals a fresh hand', mull.hand.length === HAND);
check('the old hand went to the discard', mull.discard.length === HAND);
check('the hand actually changed', mull.hand.map(c => c.id).join(',') !== before);
check('the second is refused', mulligan(mull, HAND) === false);
check('and the refusal changes nothing',
  mull.hand.length === HAND && mull.discard.length === HAND);

log('\n=== 10. Nothing private leaks into the public view ===');
const pub = cardsPublic(cards, 0);
const blob = JSON.stringify(pub);
check('the public view names no card', !blob.includes('"id"') && !blob.includes('"kind"'), blob);
check('it does carry the counts',
  pub.white.handCount === HAND && pub.white.deckCount === DECK - HAND
  && pub.white.discardCount === 0);
check('and the current draw target',
  pub.drawTarget === TUNING.drawTarget && pub.enraged === false);
check('the enraged view reports one more',
  cardsPublic(cards, 22).drawTarget === TUNING.enrageDrawTarget);

const view = handView(bareSide('pawn', 'rook'), opening, true);
check('your own hand marks the live card and the dead one',
  view.length === 2 && view[0].playable === true && view[1].playable === false,
  JSON.stringify(view));
check('off turn, nothing is marked live',
  handView(bareSide('pawn'), opening, false)[0].playable === false);

log('\n=== 11. A snapshot is a deep copy, so a takeback cannot launder a card ===');
const original = createCards();
const snap = snapshotCards(original);
original.white.hand.pop();
original.white.played.push('queen');
check('the snapshot kept the original hand size',
  snap.white.hand.length === HAND && original.white.hand.length === HAND - 1);
check('and its own played record',
  snap.white.played.length === 0 && original.white.played.length === 1);
check('the card objects are copies, not shared references',
  snap.white.deck[0] !== original.white.deck[0]
  && snap.white.deck[0].id === original.white.deck[0].id);

log(`\n${failures === 0 ? 'ALL CARD CHECKS PASSED' : `${failures} CARD CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
