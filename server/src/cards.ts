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
 * What they have to buy is a hand that actually constrains. The first pass took the design
 * doc's figures literally -- five cards, four Wilds in thirty-six -- and measured far too
 * loose: on 33% of turns every legal move was affordable anyway, and 73% of all legal
 * moves were. Playtesting put it plainly: "feels like I can always move almost any piece."
 *
 * Two causes, and the harness separates them. A hand of five out of only six kinds holds
 * 3.4 distinct kinds, which covers most of what a position offers; and a Wild unlocks
 * everything at once, which 26% of turns had one of. Cutting Wild to a single copy and the
 * hand to three takes the unconstrained share to 9% and move coverage to 56%.
 *
 * Going thinner still works on paper and not in play: hand-of-two, or a pawn-light deck,
 * pushes the emergency move from 3% of turns to 4-5%, and the doc is explicit that it is
 * "a safety net, not a normal way to play". `docs/BALANCE.md` has the full table.
 */
export const TUNING = {
  handMax: 7,
  drawTarget: 3,
  enrageDrawTarget: 4,
  /**
   * Soft enrage after twenty plies. The design doc says "20 полного ходов (10 ходов White
   * + 10 ходов Black)" -- the parenthetical is the binding one, so it is twenty
   * half-moves, counted off the same history the move list is drawn from.
   */
  enrageAfterPlies: 20,
  /**
   * One fixed symmetrical deck for both players; no deckbuilding in the MVP.
   *
   * The doc's shape, still thirty-six, with Wild cut from four copies to one. Duplicates
   * are what make a hand bite -- three cards spread over three kinds is a real position to
   * solve, where five over five is none -- so the copies freed by Wild went to the pieces
   * that already had the most.
   */
  deck: [
    ['pawn', 11], ['knight', 8], ['bishop', 8], ['rook', 5], ['queen', 3], ['wild', 1],
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
}

export interface CardsState {
  white: CardSide;
  black: CardSide;
  seq: number;
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
    played: [], emergenciesUsed: 0, emergency: false,
  };
  drawUpTo(side, TUNING.drawTarget);
  return { side, seq };
}

export function createCards(): CardsState {
  const w = makeSide(0);
  const b = makeSide(w.seq);
  return { white: w.side, black: b.side, seq: b.seq };
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

export function drawUpTo(side: CardSide, target: number): number {
  let drawn = 0;
  while (side.hand.length < target && side.hand.length < TUNING.handMax) {
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

export function drawTargetFor(plies: number): number {
  return isEnraged(plies) ? TUNING.enrageDrawTarget : TUNING.drawTarget;
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

export type Spend =
  | { kind: 'none' }                  // a king move costs nothing
  | { kind: 'card'; card: Card }
  | { kind: 'emergency' };

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

  side.emergenciesUsed++;
  if (side.hand.length > 0) {
    const victim = side.hand[Math.floor(Math.random() * side.hand.length)];
    discardCard(side, victim);
    return victim.kind;
  }
  return null;
}

/** Once per game: throw the hand away and take a fresh one of the current size. */
export function mulligan(side: CardSide, target: number): boolean {
  if (side.mulliganUsed) return false;
  side.mulliganUsed = true;
  while (side.hand.length > 0) side.discard.push(side.hand.pop()!);
  drawUpTo(side, target);
  return true;
}

// ---------- serialisation ----------

function sidePublic(side: CardSide): CardSidePublic {
  return {
    handCount: side.hand.length,
    deckCount: side.deck.length,
    discardCount: side.discard.length,
    mulliganUsed: side.mulliganUsed,
    emergenciesUsed: side.emergenciesUsed,
    played: side.played,
  };
}

/** What both players may see: counts and a face-up discard, never a hand. */
export function cardsPublic(cards: CardsState, plies: number): CardsPublic {
  return {
    white: sidePublic(cards.white),
    black: sidePublic(cards.black),
    drawTarget: drawTargetFor(plies),
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
  });
  return { white: clone(cards.white), black: clone(cards.black), seq: cards.seq };
}
