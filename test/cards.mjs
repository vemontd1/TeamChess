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
  TUNING, deckSize, createCards, dealOpening, drawCards, drawBonus, drawPerTurnFor,
  isEnraged, movableTypes, cardPlayable, cardCovers, refreshEmergency, resolveSpend,
  commitSpend, mulligan, cardsPublic, handView, snapshotCards, extinctTypes,
  replaceExtinct, cycleForPlayable, canSacrifice, sacrificeReadyIn, resolveSacrifice,
  aliveTypeCount, handCapFor, canCastle,
  EMERGENCY_CARD_ID,
} from '../server/src/cards.ts';

/** Both sides at the full cap, for the public-view tests that do not vary it. */
const FULL_CAPS = { white: TUNING.handMax, black: TUNING.handMax };

/* Assertions read the tuning rather than restating it, so retuning the mode does not
   mean rewriting the tests -- only the composition block below, which is the one place
   the shipped numbers are deliberately pinned. */
const HAND = TUNING.openingKinds.length;
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
    played: [], emergenciesUsed: 0, emergency: false, lastReplaced: [], lastCycled: [],
    sacrificesUsed: 0, lastSacrificePly: null, openedTurns: 0,
  };
}

/** A side with a hand and a stocked deck, for the replacement tests. */
function stockedSide(hand, deck) {
  return {
    hand: handOf(...hand),
    deck: deck.map((kind, i) => ({ id: 2000 + i, kind })),
    discard: [], mulliganUsed: false,
    played: [], emergenciesUsed: 0, emergency: false, lastReplaced: [], lastCycled: [],
    sacrificesUsed: 0, lastSacrificePly: null, openedTurns: 0,
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
const composed = Object.fromEntries(TUNING.deck);
check('the tally matches the tuning',
  Object.entries(composed).every(([kind, n]) => tally[kind] === n), JSON.stringify(tally));
check('a single wild', tally.wild === 1, String(tally.wild));
check('the opening hand is one card per piece kind', HAND === 5, String(HAND));
check('both sides open on a full hand',
  cards.white.hand.length === HAND && cards.black.hand.length === HAND);
check('and it holds exactly one of each kind, so no game starts stuck', (() => {
  const kinds = cards.white.hand.map(c => c.kind).sort();
  return JSON.stringify(kinds) === JSON.stringify([...TUNING.openingKinds].sort());
})(), cards.white.hand.map(c => c.kind).join(','));
check('the opening hand came out of the deck rather than being conjured',
  cards.white.deck.length === DECK - HAND, String(cards.white.deck.length));
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
check('a turn deals a fixed number, not a refill',
  drawCards(drawer, TUNING.drawPerTurn) === TUNING.drawPerTurn
  && drawer.hand.length === TUNING.drawPerTurn);
check('dealing again deals again -- the hand grows',
  drawCards(drawer, TUNING.drawPerTurn) === TUNING.drawPerTurn
  && drawer.hand.length === TUNING.drawPerTurn * 2);
check('a capture draws one more', (() => {
  const before = drawer.hand.length;
  return drawBonus(drawer) === 1 && drawer.hand.length === before + 1;
})());
drawCards(drawer, TUNING.handMax);
check('the cap is seven', drawer.hand.length === 7, String(drawer.hand.length));
check('the bonus refuses to pass the cap',
  drawBonus(drawer) === 0 && drawer.hand.length === 7);
check('and a full hand simply refuses the deal -- section 10\'s card lock',
  drawCards(drawer, 4) === 0 && drawer.hand.length === 7);

log('\n=== 7. An exhausted deck reshuffles the discard ===');
const cycler = createCards().white;
cycler.discard = cycler.deck.splice(0);   // the whole deck face up, nothing to draw
cycler.hand = [];
check('the deck really is empty',
  cycler.deck.length === 0 && cycler.discard.length === DECK - HAND);
const redrawn = drawCards(cycler, HAND);
check('the discard becomes the new deck', redrawn === HAND && cycler.hand.length === HAND);
check('and the discard pile is now empty', cycler.discard.length === 0);
check('no card was lost in the shuffle',
  cycler.deck.length + cycler.hand.length === DECK - HAND,
  String(cycler.deck.length + cycler.hand.length));

log('\n=== 8. Soft enrage, at twenty plies ===');
check('the base deal before twenty plies',
  drawPerTurnFor(19) === TUNING.drawPerTurn && !isEnraged(19));
check('one more from the twentieth',
  drawPerTurnFor(20) === TUNING.enrageDrawPerTurn && isEnraged(20)
  && TUNING.enrageDrawPerTurn === TUNING.drawPerTurn + 1);
check('and it stays there', drawPerTurnFor(64) === TUNING.enrageDrawPerTurn);

log('\n=== 9. Mulligan, once a game ===');
const mull = createCards().black;
const before = mull.hand.map(c => c.id).join(',');
check('the first mulligan is granted', mulligan(mull) === true);
check('it deals a fresh opening hand', mull.hand.length === HAND);
check('one card per kind again, not another random draw', (() => {
  const kinds = mull.hand.map(c => c.kind).sort();
  return JSON.stringify(kinds) === JSON.stringify([...TUNING.openingKinds].sort());
})(), mull.hand.map(c => c.kind).join(','));
check('the old hand went to the discard', mull.discard.length === HAND);
check('the hand actually changed', mull.hand.map(c => c.id).join(',') !== before);
check('the second is refused', mulligan(mull) === false);
check('and the refusal changes nothing',
  mull.hand.length === HAND && mull.discard.length === HAND);
check('a mulligan on a hand grown past the opening gives back the opening size', (() => {
  const grown = createCards().white;
  drawCards(grown, TUNING.handMax);
  const was = grown.hand.length;
  mulligan(grown);
  return was === TUNING.handMax && grown.hand.length === HAND;
})());

log('\n=== 10. Nothing private leaks into the public view ===');
const pub = cardsPublic(cards, 0, FULL_CAPS);
const blob = JSON.stringify(pub);
check('the public view names no card', !blob.includes('"id"') && !blob.includes('"kind"'), blob);
check('it does carry the counts',
  pub.white.handCount === HAND && pub.white.deckCount === DECK - HAND
  && pub.white.discardCount === 0);
check('the cap it was given is reported per side',
  pub.white.handCap === TUNING.handMax && pub.black.handCap === TUNING.handMax);
check('and the current deal, the cap and the sacrifice price',
  pub.drawPerTurn === TUNING.drawPerTurn && pub.handMax === TUNING.handMax
  && pub.sacrificeCost === TUNING.sacrificeCost && pub.enraged === false);
check('the enraged view reports one more',
  cardsPublic(cards, 22, FULL_CAPS).drawPerTurn === TUNING.enrageDrawPerTurn);

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

log('=== 12. Cards for pieces you no longer have are replaced ===');
// A blocked bishop is a position to solve; a card for a bishop that no longer exists is
// just a smaller hand. Only the second is swapped out.
const KINGS_ONLY = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
const NO_KNIGHTS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/R1BQKB1R w KQkq - 0 1';

const openBoard = new Chess();
check('nothing is extinct in the opening position',
  extinctTypes(openBoard, 'white').size === 0,
  [...extinctTypes(openBoard, 'white')].join(''));

const knightless = new Chess(NO_KNIGHTS);
const gone = extinctTypes(knightless, 'white');
check('a side with both knights traded has knights extinct',
  gone.size === 1 && gone.has('n'), [...gone].join(''));
check("and the opponent's knights are not this side's business",
  extinctTypes(knightless, 'black').size === 0);

const bare = new Chess(KINGS_ONLY);
check('a bare king has every piece type extinct',
  extinctTypes(bare, 'white').size === 5, [...extinctTypes(bare, 'white')].join(''));

const swap = stockedSide(['knight', 'pawn', 'knight'], ['rook', 'pawn', 'bishop']);
const out = replaceExtinct(swap, gone);
check('both knight cards were swapped out', out.length === 2 && out.every(k => k === 'knight'),
  out.join(','));
check('the hand is still the same size', swap.hand.length === 3, String(swap.hand.length));
check('and holds no knights any more',
  !swap.hand.some(c => c.kind === 'knight'), swap.hand.map(c => c.kind).join(','));
check('the pawn card that was already there was left alone',
  swap.hand.some(c => c.id === 1001));
check('the retired cards went to the discard',
  swap.discard.length === 2 && swap.discard.every(c => c.kind === 'knight'));
check('a swap is not recorded as a card played on a move',
  swap.played.length === 0, JSON.stringify(swap.played));
check('no card was created or lost',
  swap.hand.length + swap.deck.length + swap.discard.length === 6,
  String(swap.hand.length + swap.deck.length + swap.discard.length));

const untouched = stockedSide(['bishop', 'rook'], ['pawn', 'pawn']);
check('nothing is swapped when nothing is extinct',
  replaceExtinct(untouched, new Set()).length === 0 && untouched.deck.length === 2);

// A card that is merely blocked stays: that is the game, not a dead card.
const blocked = stockedSide(['rook', 'rook'], ['pawn']);
check('a card for a piece that exists but cannot move is kept',
  replaceExtinct(blocked, extinctTypes(openBoard, 'white')).length === 0
  && blocked.hand.every(c => c.kind === 'rook'));

// The deck can be as dead as the hand; churning it would achieve nothing.
const allDead = stockedSide(['knight', 'knight'], ['knight', 'knight']);
check('no swap happens when the deck holds nothing better',
  replaceExtinct(allDead, gone).length === 0 && allDead.hand.length === 2);

const bareKing = stockedSide(['wild', 'queen'], ['wild', 'rook']);
check('a bare king churns nothing, wild included',
  replaceExtinct(bareKing, extinctTypes(bare, 'white')).length === 0);

const wildKept = stockedSide(['wild', 'knight'], ['pawn']);
const wildOut = replaceExtinct(wildKept, gone);
check('a wild survives while any piece remains',
  wildOut.length === 1 && wildOut[0] === 'knight'
  && wildKept.hand.some(c => c.kind === 'wild'), wildOut.join(','));

const snapped = createCards();
snapped.white.lastReplaced = ['knight'];
check('the snapshot carries the replacement record',
  snapshotCards(snapped).white.lastReplaced[0] === 'knight');

log('\n=== 13. Cycling past a hand that cannot move anything ===');
// The draw protection of section 7: a hand of dead cards is dealt past, one at a time,
// until something can move. Free, but it costs the deck -- the cards come back around.
{
  const stuck = stockedSide(['rook', 'rook', 'rook'], ['queen', 'pawn', 'knight']);
  const cycled = cycleForPlayable(stuck, opening);
  check('a dead hand is cycled', cycled.length > 0, JSON.stringify(cycled));
  check('only as far as it has to be', cycled.length === 1, String(cycled.length));
  check('and the hand can now move something',
    stuck.hand.some(c => cardPlayable(c, movableTypes(opening))));
  check('the cycled cards went to the discard',
    stuck.discard.length === cycled.length && stuck.hand.length === 3);

  const fine = stockedSide(['pawn', 'rook'], ['queen']);
  check('a hand that can already move is left alone',
    cycleForPlayable(fine, opening).length === 0 && fine.deck.length === 1);

  // A player down to a bare king has no live card anywhere, and must not churn the deck
  // looking for one that does not exist.
  const bare = new Chess('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  const noRook = stockedSide(['knight', 'knight'], ['bishop', 'queen']);
  check('with nothing live anywhere, nothing is cycled',
    cycleForPlayable(noRook, bare).length === 0 && noRook.discard.length === 0);
}

log('\n=== 14. The sacrifice: three cards for any move, on a cooldown ===');
{
  const rich = bareSide('pawn', 'knight', 'bishop', 'rook');
  check('a full hand off cooldown can sacrifice', canSacrifice(rich, 0) === true);
  check('and reports no wait', sacrificeReadyIn(rich, 0) === 0);

  const thin = bareSide('pawn', 'knight');
  check('a hand short of the cost cannot',
    canSacrifice(thin, 0) === false && TUNING.sacrificeCost === 3);

  const ids = rich.hand.slice(0, 3).map(c => c.id);
  check('naming exactly the cost is accepted',
    resolveSacrifice(rich, ids, 4)?.kind === 'sacrifice');
  check('naming too few is refused', resolveSacrifice(rich, ids.slice(0, 2), 4) === null);
  check('naming the same card twice is refused',
    resolveSacrifice(rich, [ids[0], ids[0], ids[1]], 4) === null);
  check('naming a card that is not in hand is refused',
    resolveSacrifice(rich, [ids[0], ids[1], 999999], 4) === null);
  check('a non-array is refused', resolveSacrifice(rich, 'three', 4) === null);

  const spend = resolveSacrifice(rich, ids, 4);
  commitSpend(rich, spend);
  check('paying takes all three out of the hand',
    rich.hand.length === 1 && rich.discard.length === 3);
  check('and they are on the public record',
    rich.played.length === 3 && rich.sacrificesUsed === 1);
  check('the cooldown starts at the ply it was paid',
    sacrificeReadyIn(rich, 4) === TUNING.sacrificeCooldownPlies);
  check('and counts down with the game',
    sacrificeReadyIn(rich, 4 + TUNING.sacrificeCooldownPlies - 1) === 1
    && sacrificeReadyIn(rich, 4 + TUNING.sacrificeCooldownPlies) === 0);
  check('a second sacrifice inside the cooldown is refused', (() => {
    const again = bareSide('pawn', 'knight', 'bishop');
    again.lastSacrificePly = 4;
    return resolveSacrifice(again, again.hand.map(c => c.id), 5) === null;
  })());
  check('and granted once it has passed', (() => {
    const again = bareSide('pawn', 'knight', 'bishop');
    again.lastSacrificePly = 4;
    return resolveSacrifice(again, again.hand.map(c => c.id),
      4 + TUNING.sacrificeCooldownPlies) !== null;
  })());
  check('a snapshot carries the cooldown, so a takeback cannot refresh it', (() => {
    const st = createCards();
    st.white.lastSacrificePly = 7;
    st.white.sacrificesUsed = 1;
    const snap = snapshotCards(st);
    st.white.lastSacrificePly = null;
    return snap.white.lastSacrificePly === 7 && snap.white.sacrificesUsed === 1;
  })());
}


log('\n=== 15. The hand cap follows the army down ===');
{
  check('a full army gets the full cap',
    handCapFor(5) === TUNING.handMax, String(handCapFor(5)));
  check('each piece kind lost costs a card',
    handCapFor(4) === 6 && handCapFor(3) === 5 && handCapFor(2) === 4);
  check('and it floors rather than reaching zero',
    handCapFor(1) === TUNING.handMin && handCapFor(0) === TUNING.handMin);

  check('the opening position has every kind alive',
    aliveTypeCount(opening, 'white') === 5 && aliveTypeCount(opening, 'black') === 5);
  const thin = new Chess('4k3/8/8/8/8/8/4P3/R3K3 w Q - 0 1');
  check('a rook and a pawn is two kinds', aliveTypeCount(thin, 'white') === 2);
  check('a bare king is none', aliveTypeCount(thin, 'black') === 0);

  // Nothing is confiscated when the cap falls: the deal simply stops until the hand has
  // been spent back under it. A player who loses a piece must not lose cards for it.
  const shrunk = createCards().white;
  drawCards(shrunk, 4, TUNING.handMax);
  const held = shrunk.hand.length;
  check('the hand is over a cap that has just fallen', held > handCapFor(2));
  check('dealing into an overfull hand takes nothing',
    drawCards(shrunk, 2, handCapFor(2)) === 0 && shrunk.hand.length === held);
  check('and the capture bonus respects the same cap',
    drawBonus(shrunk, handCapFor(2)) === 0 && shrunk.hand.length === held);
  check('once back under it, the deal resumes', (() => {
    shrunk.hand.length = handCapFor(2) - 1;
    return drawCards(shrunk, 2, handCapFor(2)) === 1;
  })());
}

log('\n=== 16. Castling is the one king move that is paid for ===');
{
  // The rook travels too, so a castle costs a Rook card. Without it the king's freedom --
  // which exists so no hand can lock you out -- doubled as a free rook development.
  const withRook = bareSide('pawn', 'rook');
  const noRook = bareSide('pawn', 'knight');
  const wildOnly = bareSide('pawn', 'wild');

  check('an ordinary king move is still free',
    resolveSpend(withRook, 'k')?.kind === 'none'
    && resolveSpend(noRook, 'k')?.kind === 'none');

  const paid = resolveSpend(withRook, 'k', undefined, true);
  check('a castle is paid for with the Rook card',
    paid?.kind === 'card' && paid.card.kind === 'rook', JSON.stringify(paid));
  check('a Wild pays for one too', (() => {
    const w = resolveSpend(wildOnly, 'k', undefined, true);
    return w?.kind === 'card' && w.card.kind === 'wild';
  })());
  check('a hand with neither cannot castle',
    resolveSpend(noRook, 'k', undefined, true) === null);
  check('and naming a card that is not a rook is refused',
    resolveSpend(withRook, 'k', withRook.hand[0].id, true) === null);

  check('canCastle agrees with what resolveSpend will do',
    canCastle(withRook) === true && canCastle(wildOnly) === true
    && canCastle(noRook) === false);
  check('the safety net can pay for a castle too', (() => {
    const dead = bareSide('knight');
    dead.emergency = true;
    return canCastle(dead) === true
      && resolveSpend(dead, 'k', undefined, true)?.kind === 'emergency';
  })());

  const spent = resolveSpend(withRook, 'k', undefined, true);
  commitSpend(withRook, spent);
  check('paying for a castle really spends the card',
    withRook.hand.length === 1 && withRook.played[0] === 'rook',
    JSON.stringify(withRook.played));
}
log(`\n${failures === 0 ? 'ALL CARD CHECKS PASSED' : `${failures} CARD CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
