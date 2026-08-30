import type { Chess } from 'chess.js';
import type { Color, CardKind, CardSidePublic, CardsPublic, HandCard } from './types.js';

/**
 * The card layer for Chess Cards: a 1v1 mode where a player may only move a piece type
 * they hold a card for.
 *
 * Everything here is deliberately mechanical -- draw, spend, discard, reshuffle -- and
 * knows nothing about rooms or sockets. The one piece of chess knowledge it needs is
 * which piece types have a legal move right now, which is what decides whether a card is
 * playable and whether the safety net has to open.
 */

/** Card ids the client sends back. Real cards are positive; the safety net is not a card. */
export const EMERGENCY_CARD_ID = -1;

/** A move by the king never costs a card, so no hand can ever lock a player out. */
export const FREE_PIECE = 'k';

/**
 * Every number the mode's feel depends on, in one place.
 *
 * These are balance, not rules, and they are exported mutable so `test/balance.mjs` can
 * sweep them against simulated games. Nothing at runtime writes to this.
 *
 * What they have to buy is a hand that actually constrains -- "I can see the move, can I
 * play it?" only works while the answer is often no -- without the hand feeling like a
 * cage. The first pass took the design doc's figures literally (five cards, four Wilds in
 * thirty-six) and measured far too loose: 33% of turns had every legal move affordable
 * anyway. Cutting Wild to a single copy and the hand to three fixed the measurement and
 * broke the feel: three cards is a hand you read in a second and then wait out.
 *
 * The shape now is the doc's own economy rather than a refill target. You open with one
 * card per piece kind, so no game starts stuck; you draw two a turn and spend one, so a
 * quiet turn banks a card; and the hand caps at seven, which is the doc's cap and the
 * thing that makes hoarding a real decision rather than a free one. The pressure that
 * used to come from a small hand now comes from the deck: it is heavily duplicated, so
 * seven cards is still only about three distinct kinds. `docs/BALANCE.md` has the table.
 */
export const TUNING = {
  /** Section 10's card lock: at seven, the draw simply does not happen. */
  handMax: 7,
  /**
   * The opening hand: one card for each piece kind.
   *
   * Dealt rather than drawn, so the first turn of every game offers the whole board and
   * the mode introduces itself by what it takes away over the next few turns rather than
   * by a first hand of three pawns.
   */
  openingKinds: ['pawn', 'knight', 'bishop', 'rook', 'queen'] as CardKind[],
  /** Cards dealt at the start of each turn -- two, against the one card a move costs. */
  drawPerTurn: 2,
  enrageDrawPerTurn: 3,
  /**
   * Soft enrage after twenty plies. The design doc says "20 полного ходов (10 ходов White
   * + 10 ходов Black)" -- the parenthetical is the binding one, so it is twenty
   * half-moves, counted off the same history the move list is drawn from.
   */
  enrageAfterPlies: 20,
  /** Cards a sacrifice costs, and how many plies must pass before another is allowed. */
  sacrificeCost: 3,
  sacrificeCooldownPlies: 10,
  /**
   * One fixed symmetrical deck for both players; no deckbuilding in the MVP.
   *
   * The doc's shape, still thirty-six, with Wild cut from four copies to one and the
   * copies it freed given to the pieces that already had the most. Duplicates are the
   * whole source of constraint: seven cards spread over six kinds would be no constraint
   * at all, and seven cards that keep turning out to be four pawns is a position to solve.
   */
  deck: [
    ['pawn', 14], ['knight', 8], ['bishop', 7], ['rook', 4], ['queen', 2], ['wild', 1],
  ] as Array<[CardKind, number]>,
};

/** Which chess piece each card unlocks. Wild is handled separately -- it unlocks any. */
const CARD_PIECE: Record<Exclude<CardKind, 'wild'>, string> = {
  pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q',
};

export interface Card { id: number; kind: CardKind; }

export interface CardSide {
  hand: Card[];
  deck: Card[];
  discard: Card[];
  mulliganUsed: boolean;
  /** Every card this side has spent, oldest first -- public, like a face-up discard. */
  played: CardKind[];
  emergenciesUsed: number;
  /** Recomputed at the start of each turn: true when no card in hand can move anything. */
  emergency: boolean;
  /** Kinds swapped out this turn because that piece is gone from the board. */
  lastReplaced: CardKind[];
  /** Kinds cycled away this turn looking for something that could move. */
  lastCycled: CardKind[];
  sacrificesUsed: number;
  /** Ply count when the last sacrifice was paid, or null. Drives the cooldown. */
  lastSacrificePly: number | null;
  /**
   * How many of this side's turns have been opened.
   *
   * The opening hand *is* the deal for the first turn, so the first turn opens without
   * one. Without this the deal lands on top of the opening hand before White has moved at
   * all, which takes a carefully composed five-card hand of one-per-piece and makes it
   * seven random cards before anybody has seen it.
   */
  openedTurns: number;
}

export interface CardsState {
  white: CardSide;
  black: CardSide;
  seq: number;
  /**
   * The ply count the current turn was opened at, or null before the first one.
   *
   * A fixed deal is not idempotent the way a refill-to-target was: every path that re-arms
   * a turn -- a declined takeback, a seat turning into a bot mid-turn -- used to be free to
   * call `beginCardTurn` again, and would now deal two more cards each time. This is the
   * marker that makes reopening the same turn do nothing. It lives on the cards rather
   * than the room so a takeback restores it along with the hands: an undone ply puts the
   * position back to a turn that was already opened, and dealing into it again would hand
   * the player two cards for a move they are about to make over.
   */
  openedPly: number | null;
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeSide(seqStart: number): { side: CardSide; seq: number } {
  const deck: Card[] = [];
  let seq = seqStart;
  for (const [kind, n] of TUNING.deck) {
    for (let i = 0; i < n; i++) deck.push({ id: ++seq, kind });
  }
  shuffle(deck);
  const side: CardSide = {
    hand: [], deck, discard: [], mulliganUsed: false,
    played: [], emergenciesUsed: 0, emergency: false, lastReplaced: [], lastCycled: [],
    sacrificesUsed: 0, lastSacrificePly: null, openedTurns: 0,
  };
  dealOpening(side);
  return { side, seq };
}

/**
 * The opening hand: one card of each piece kind, taken out of the piles that already hold
 * them rather than conjured, so the thirty-six cards a side owns stay thirty-six.
 *
 * At the start of a game the deck holds every kind and this is a straight deal. After a
 * mulligan it may not -- the Queen cards could all be in the discard -- so the discard is
 * searched too, and a kind that exists in neither falls back to an ordinary draw. That
 * last case is what keeps a mulligan from handing back a hand of three because the deck
 * happened to be out of rooks.
 */
export function dealOpening(side: CardSide): Card[] {
  const dealt: Card[] = [];
  for (const kind of TUNING.openingKinds) {
    if (side.hand.length >= TUNING.handMax) break;
    const card = takeKind(side, kind) ?? drawOne(side);
    if (!card) break;                       // both piles empty: nothing left anywhere
    side.hand.push(card);
    dealt.push(card);
  }
  return dealt;
}

/** Lift one card of a named kind out of the deck, or failing that the discard. */
function takeKind(side: CardSide, kind: CardKind): Card | null {
  for (const pile of [side.deck, side.discard]) {
    const at = pile.findIndex(c => c.kind === kind);
    if (at >= 0) return pile.splice(at, 1)[0];
  }
  return null;
}

export function createCards(): CardsState {
  const w = makeSide(0);
  const b = makeSide(w.seq);
  return { white: w.side, black: b.side, seq: b.seq, openedPly: null };
}

/** Exhausting the deck reshuffles the discard into a new one, as at a table. */
function drawOne(side: CardSide): Card | null {
  if (side.deck.length === 0) {
    if (side.discard.length === 0) return null;   // all 36 are in hand: impossible at 7
    side.deck = shuffle(side.discard);
    side.discard = [];
  }
  return side.deck.pop() ?? null;
}

/**
 * The start-of-turn deal: a fixed number of cards, not a refill to a target.
 *
 * The difference is the whole hand economy. Refilling to a target means a quiet turn and
 * a busy turn leave you in exactly the same place, so a card is never really banked; a
 * fixed deal against a one-card move cost means a turn you spend nothing on is a turn you
 * come out of one card richer -- until the cap, where section 10's card lock bites and
 * holding on starts costing draws.
 */
export function drawCards(side: CardSide, n: number): number {
  let drawn = 0;
  for (let i = 0; i < n && side.hand.length < TUNING.handMax; i++) {
    const c = drawOne(side);
    if (!c) break;
    side.hand.push(c);
    drawn++;
  }
  return drawn;
}

/** The capture bonus: one extra card, still bounded by the hand cap. */
export function drawBonus(side: CardSide): number {
  if (side.hand.length >= TUNING.handMax) return 0;
  const c = drawOne(side);
  if (!c) return 0;
  side.hand.push(c);
  return 1;
}

export function drawPerTurnFor(plies: number): number {
  return isEnraged(plies) ? TUNING.enrageDrawPerTurn : TUNING.drawPerTurn;
}

export function isEnraged(plies: number): boolean {
  return plies >= TUNING.enrageAfterPlies;
}

/** The whole deck, for anything that needs to count it. */
export function deckSize(): number {
  return TUNING.deck.reduce((n, [, count]) => n + count, 0);
}

/**
 * The piece types that have at least one legal move in this position.
 *
 * `moves()` is already filtered to legal moves, so a piece that could only move by
 * exposing its own king does not count -- which is what makes "no playable card" mean the
 * same thing under check as it does anywhere else.
 */
export function movableTypes(chess: Chess): Set<string> {
  const out = new Set<string>();
  for (const m of chess.moves({ verbose: true }) as unknown as Array<{ piece: string }>) {
    out.add(m.piece);
  }
  return out;
}

/** True when this card would let its holder actually move something right now. */
export function cardPlayable(card: Card, movable: Set<string>): boolean {
  if (card.kind === 'wild') {
    return ['p', 'n', 'b', 'r', 'q'].some(t => movable.has(t));
  }
  return movable.has(CARD_PIECE[card.kind]);
}

/** True when a card unlocks this particular piece type. */
export function cardCovers(card: Card, piece: string): boolean {
  if (piece === FREE_PIECE) return false;          // the king never needs one
  if (card.kind === 'wild') return true;
  return CARD_PIECE[card.kind] === piece;
}

/**
 * Recompute the safety net. Emergency opens exactly when no card in hand can move
 * anything -- the king may still have moves, and often does, which is why this is a way
 * to reach your other pieces rather than a way to avoid being stuck.
 */
export function refreshEmergency(side: CardSide, chess: Chess): void {
  const movable = movableTypes(chess);
  side.emergency = side.hand.length === 0
    || !side.hand.some(c => cardPlayable(c, movable));
}

/**
 * Piece types this player has none of left on the board.
 *
 * A card for one of these is not merely dead in this position -- it is dead in every
 * position that can follow, because the piece it names does not exist any more. That is a
 * different thing from a bishop that happens to be blocked this turn, and it is why the
 * two are treated differently below.
 */
export function extinctTypes(chess: Chess, color: Color): Set<string> {
  const mine = color === 'white' ? 'w' : 'b';
  const alive = new Set<string>();
  for (const row of chess.board()) {
    for (const cell of row) if (cell && cell.color === mine) alive.add(cell.type);
  }
  const out = new Set<string>();
  for (const type of ['p', 'n', 'b', 'r', 'q']) if (!alive.has(type)) out.add(type);
  return out;
}

/** A Wild only dies with the whole army: while any piece remains, it can move it. */
function isExtinct(card: Card, extinct: Set<string>): boolean {
  if (card.kind === 'wild') return extinct.size === 5;
  return extinct.has(CARD_PIECE[card.kind]);
}

/**
 * Swap out cards for pieces the player no longer has, drawing a replacement for each.
 *
 * Without this a hand quietly shrinks as the game goes on: trade off both knights and the
 * Knight cards you hold become permanent dead weight, so a hand of three plays as a hand
 * of two, and by the endgame -- where most of the army is gone -- as a hand of one. That
 * is not the constraint the mode is built on. Being unable to move the bishop you have is
 * a position to solve; holding a card for a bishop that no longer exists is just a
 * smaller hand.
 *
 * Cards go back to the discard rather than out of the deck, so a pawn promoting to a
 * knight makes Knight cards meaningful again on their own.
 *
 * The replacement is not recorded in `played` -- nothing was spent on a move -- and the
 * loop is bounded twice: it does nothing unless a live card exists outside the hand, and
 * it never looks at more cards than exist. A player down to a bare king has no live card
 * anywhere, and gets no churn.
 */
export function replaceExtinct(side: CardSide, extinct: Set<string>): CardKind[] {
  if (extinct.size === 0) return [];
  const outside = side.deck.length + side.discard.length;
  const anyLive = side.deck.some(c => !isExtinct(c, extinct))
    || side.discard.some(c => !isExtinct(c, extinct));
  if (!anyLive) return [];

  const replaced: CardKind[] = [];
  // held back until the end, so a card just discarded cannot be reshuffled and redrawn
  const retired: Card[] = [];
  let guard = outside + 1;

  while (guard-- > 0) {
    const at = side.hand.findIndex(c => isExtinct(c, extinct));
    if (at < 0) break;
    const [dead] = side.hand.splice(at, 1);
    const fresh = drawOne(side);
    if (!fresh) { side.hand.splice(at, 0, dead); break; }   // nothing left to draw
    side.hand.push(fresh);
    retired.push(dead);
    replaced.push(dead.kind);
  }

  side.discard.push(...retired);
  return replaced;
}

/**
 * Deal past a hand that cannot move anything, one card at a time, until it can.
 *
 * This is the design doc's draw protection (section 7), and it is what a dead hand should
 * meet when the king is not under attack. The emergency move was standing in for it, and
 * standing in badly: it is a far bigger gift -- it opens *every* piece at once, where
 * cycling hands you one card and no more -- and it charges for it, so the common case of
 * "my three cards happen to be useless right now" was being both over-rewarded and fined.
 *
 * Cycling is free. Its cost is the deck: the cards go to the discard and come back around
 * later, so a player who cycles often is thinning their own draws.
 *
 * Bounded the same way the extinction swap is. If no card anywhere can move anything --
 * a player down to a bare king, where only the free king move exists -- there is nothing
 * to find and it does not churn.
 */
export function cycleForPlayable(side: CardSide, chess: Chess): CardKind[] {
  const movable = movableTypes(chess);
  if (side.hand.some(c => cardPlayable(c, movable))) return [];

  const outside = side.deck.length + side.discard.length;
  const anyLive = side.deck.some(c => cardPlayable(c, movable))
    || side.discard.some(c => cardPlayable(c, movable));
  if (!anyLive) return [];

  const cycled: CardKind[] = [];
  // held back so a card just cycled away cannot be reshuffled and dealt straight back
  const retired: Card[] = [];
  let guard = outside + 1;

  while (guard-- > 0 && !side.hand.some(c => cardPlayable(c, movable))) {
    const dead = side.hand.shift();
    if (!dead) break;
    const fresh = drawOne(side);
    if (!fresh) { side.hand.unshift(dead); break; }
    side.hand.push(fresh);
    retired.push(dead);
    cycled.push(dead.kind);
  }

  side.discard.push(...retired);
  return cycled;
}

// ---------- the sacrifice ----------

/**
 * Burn a fistful of cards to move whatever you like, once every so often.
 *
 * The mode's sharpest moment is seeing the winning move and holding the wrong cards for
 * it. Cycling and the emergency net both answer the *dead* hand -- nothing at all to move
 * -- but neither answers the far more common and far more painful case: a hand full of
 * perfectly good cards, none of them the Rook this position is asking for. Until now the
 * only reply to that was to play something else and hope the position survived.
 *
 * So: three cards for one move of any piece, and then not again for ten plies. Every part
 * of that is doing a job. The cost is paid from the hand the player chose to keep, so it
 * is real -- three cards is most of a hand and two turns of drawing. The cooldown is what
 * stops it becoming the way the game is played rather than the way a game is rescued: at
 * a card lock of seven and a deal of two, ten plies is roughly the time it takes to be
 * able to afford one again, so the mode is a card game that occasionally buys its way out
 * rather than a chess game with a card-shaped tax.
 *
 * The player names the cards. Taking them at random, the way the emergency move does,
 * would be tolerable there -- an emergency hand is all dead cards anyway -- but here the
 * whole point is that the hand is worth something, and being charged for it blind is not
 * a decision, it is a dice roll.
 */

/** Plies until this side may sacrifice again; 0 means now. */
export function sacrificeReadyIn(side: CardSide, plies: number): number {
  if (side.lastSacrificePly == null) return 0;
  const since = plies - side.lastSacrificePly;
  return Math.max(0, TUNING.sacrificeCooldownPlies - since);
}

/** True when a sacrifice is both off cooldown and affordable out of this hand. */
export function canSacrifice(side: CardSide, plies: number): boolean {
  return sacrificeReadyIn(side, plies) === 0 && side.hand.length >= TUNING.sacrificeCost;
}

export type Spend =
  | { kind: 'none' }                  // a king move costs nothing
  | { kind: 'card'; card: Card }
  | { kind: 'sacrifice'; cards: Card[]; plies: number }
  | { kind: 'emergency' };

/**
 * Validate a named sacrifice: exactly the cost, all distinct, all actually in hand, and
 * off cooldown. Nothing here looks at the piece -- paying the cost is what buys the right
 * to ignore it, which is the entire mechanic.
 */
export function resolveSacrifice(side: CardSide, ids: unknown, plies: number): Spend | null {
  if (!Array.isArray(ids) || ids.length !== TUNING.sacrificeCost) return null;
  if (sacrificeReadyIn(side, plies) > 0) return null;

  const seen = new Set<number>();
  const cards: Card[] = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isFinite(id) || seen.has(id)) return null;
    const card = side.hand.find(c => c.id === id);
    if (!card) return null;
    seen.add(id);
    cards.push(card);
  }
  return { kind: 'sacrifice', cards, plies };
}

/**
 * Decide which card pays for a move.
 *
 * When the client names one, that choice is honoured if it is legal. When it names none
 * -- dragging a piece without picking a card first, or a move the clock played -- the
 * cheapest sufficient card is taken: the exact type before a Wild, and a Wild before the
 * safety net. That ordering is never the wrong one, so resolving it on the server keeps
 * the two ends from ever disagreeing about what was spent.
 */
export function resolveSpend(side: CardSide, piece: string, explicitId?: number): Spend | null {
  if (piece === FREE_PIECE) return { kind: 'none' };

  if (explicitId != null) {
    if (explicitId === EMERGENCY_CARD_ID) {
      return side.emergency ? { kind: 'emergency' } : null;
    }
    const card = side.hand.find(c => c.id === explicitId);
    if (!card || !cardCovers(card, piece)) return null;
    return { kind: 'card', card };
  }

  const exact = side.hand.find(c => c.kind !== 'wild' && cardCovers(c, piece));
  if (exact) return { kind: 'card', card: exact };
  const wild = side.hand.find(c => c.kind === 'wild');
  if (wild) return { kind: 'card', card: wild };
  return side.emergency ? { kind: 'emergency' } : null;
}

/** Remove a card from hand and lay it face up on the discard pile. */
function discardCard(side: CardSide, card: Card): void {
  const at = side.hand.findIndex(c => c.id === card.id);
  if (at >= 0) side.hand.splice(at, 1);
  side.discard.push(card);
  side.played.push(card.kind);
}

/**
 * Pay for a move that has already been applied to the board.
 *
 * The emergency move costs one card taken at random from the hand. That hand is by
 * definition all dead cards, so the cost is mostly a cycle rather than a punishment --
 * but it is what stops a player sitting on a held Queen and emergency-moving for free
 * every turn.
 */
export function commitSpend(side: CardSide, spend: Spend): CardKind | null {
  if (spend.kind === 'none') return null;
  if (spend.kind === 'card') { discardCard(side, spend.card); return spend.card.kind; }

  if (spend.kind === 'sacrifice') {
    for (const card of spend.cards) discardCard(side, card);
    side.sacrificesUsed++;
    side.lastSacrificePly = spend.plies;
    return spend.cards[0]?.kind ?? null;
  }

  side.emergenciesUsed++;
  if (side.hand.length > 0) {
    const victim = side.hand[Math.floor(Math.random() * side.hand.length)];
    discardCard(side, victim);
    return victim.kind;
  }
  return null;
}

/**
 * Once per game: throw the hand away and take a fresh opening hand.
 *
 * A mulligan deals the opening spread -- one card per piece kind -- rather than the same
 * number of random cards. A hand that has to be mulliganed is one that could not reach
 * the board, and dealing it another random draw is as likely to repeat the problem as fix
 * it. The cost is what it always was: the cards banked up to now are gone, and a hand of
 * seven becomes a hand of five.
 */
export function mulligan(side: CardSide): boolean {
  if (side.mulliganUsed) return false;
  side.mulliganUsed = true;
  while (side.hand.length > 0) side.discard.push(side.hand.pop()!);
  dealOpening(side);
  return true;
}

// ---------- serialisation ----------

function sidePublic(side: CardSide, plies: number): CardSidePublic {
  return {
    handCount: side.hand.length,
    deckCount: side.deck.length,
    discardCount: side.discard.length,
    mulliganUsed: side.mulliganUsed,
    emergenciesUsed: side.emergenciesUsed,
    played: side.played,
    sacrificesUsed: side.sacrificesUsed,
    // Public on purpose. The opponent watched three cards go on the discard, so the fact
    // of the cooldown is already theirs; hiding the count left would only mean both
    // players counting plies on their fingers.
    sacrificeReadyIn: sacrificeReadyIn(side, plies),
  };
}

/** What both players may see: counts and a face-up discard, never a hand. */
export function cardsPublic(cards: CardsState, plies: number): CardsPublic {
  return {
    white: sidePublic(cards.white, plies),
    black: sidePublic(cards.black, plies),
    drawPerTurn: drawPerTurnFor(plies),
    handMax: TUNING.handMax,
    sacrificeCost: TUNING.sacrificeCost,
    enraged: isEnraged(plies),
  };
}

/**
 * One player's own hand, with each card marked playable or dead against the live
 * position. `onTurn` gates the flags: a hand is only meaningfully playable on its owner's
 * turn, and marking cards live during the opponent's turn would read as an invitation.
 */
export function handView(side: CardSide, chess: Chess, onTurn: boolean): HandCard[] {
  const movable = onTurn ? movableTypes(chess) : new Set<string>();
  return side.hand.map(c => ({
    id: c.id,
    kind: c.kind,
    playable: onTurn && cardPlayable(c, movable),
  }));
}

/** A deep copy, so a takeback can put the hands back exactly as they were. */
export function snapshotCards(cards: CardsState): CardsState {
  const clone = (s: CardSide): CardSide => ({
    hand: s.hand.map(c => ({ ...c })),
    deck: s.deck.map(c => ({ ...c })),
    discard: s.discard.map(c => ({ ...c })),
    mulliganUsed: s.mulliganUsed,
    played: [...s.played],
    emergenciesUsed: s.emergenciesUsed,
    emergency: s.emergency,
    lastReplaced: [...s.lastReplaced],
    lastCycled: [...s.lastCycled],
    sacrificesUsed: s.sacrificesUsed,
    lastSacrificePly: s.lastSacrificePly,
    openedTurns: s.openedTurns,
  });
  return {
    white: clone(cards.white), black: clone(cards.black),
    seq: cards.seq, openedPly: cards.openedPly,
  };
}
