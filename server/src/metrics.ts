import type { Chess } from 'chess.js';
import { pieceValue } from './bots.js';
import {
  handReach, movableTypes, canCastle, handComposition, deadHeldCount, extinctHeldCount,
  extinctTypes, handCapFor, aliveTypeCount, sacrificeReadyIn, type CardSide,
} from './cards.js';
import type {
  ClientSideMetrics, Color, PlyMetric, PlyCards, SideMetrics, GameMetrics,
} from './types.js';

/**
 * How a game is measured.
 *
 * This module exists so that the live server and `test/balance.mjs` compute the same
 * numbers from the same code. They did not before: each had its own idea of what a hand
 * could reach, and the two disagreed about the case that matters most -- an open safety
 * net. Two numbers that are meant to be the same number, computed differently, make the
 * comparison between simulation and real play worthless, and that comparison is the whole
 * reason for collecting either.
 *
 * Everything here is cheap by construction. The choice set falls out of a move list the
 * caller already has, and the one extra move generation is the check for a hanging piece.
 * Nothing in here runs a search.
 */

/**
 * 1: per-ply rows and the side roll-ups.
 * 2: the client block -- what the browser saw, where a browser reported it.
 *
 * Old games carry the older number and none of the newer fields. Readers treat every
 * one of them as optional forever rather than backfilling fiction.
 */
export const METRICS_SCHEMA = 2;

interface VerboseMove {
  from: string; to: string; piece: string; flags: string;
  captured?: string; promotion?: string; san: string;
}

function castles(m: { flags: string }): boolean {
  return m.flags.includes('k') || m.flags.includes('q');
}

/** Material from White's point of view, in pawns. */
export function materialBalance(chess: Chess): number {
  let total = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.type === 'k') continue;
      total += cell.color === 'w' ? pieceValue(cell.type) : -pieceValue(cell.type);
    }
  }
  return total;
}

export interface ChoiceSet {
  legalMoves: number;
  legalTypes: number;
  affordableMoves: number;
  affordableTypes: number;
  openTurn: boolean;
  onlyKing: boolean;
  forced: boolean;
  /** Best capture among the affordable moves, in pawns. */
  bestCapture: number;
  /** The reach itself, for callers that go on to pick a move from it. */
  reach: Set<string>;
}

/**
 * What this side could have played, and how much of it the cards allowed.
 *
 * `side` is null in team mode, where everything legal is affordable and the ratio is 1 by
 * definition -- worth recording anyway, so the two modes can be read off the same table.
 *
 * A castle is only affordable when the hand can pay the Rook card it costs, which is why
 * this cannot be a plain filter on piece type.
 */
export function computeChoiceSet(chess: Chess, side: CardSide | null): ChoiceSet {
  const legal = chess.moves({ verbose: true }) as unknown as VerboseMove[];
  const movable = new Set(legal.map(m => m.piece));

  const reach = side ? handReach(side, movable) : movable;
  const castleOk = side ? canCastle(side) : true;

  const affordable = legal.filter(
    m => reach.has(m.piece) && (castleOk || !castles(m)));

  let bestCapture = 0;
  for (const m of affordable) {
    if (m.captured) bestCapture = Math.max(bestCapture, pieceValue(m.captured));
  }

  return {
    legalMoves: legal.length,
    legalTypes: movable.size,
    affordableMoves: affordable.length,
    affordableTypes: [...movable].filter(t => reach.has(t)).length,
    openTurn: legal.length > 0 && affordable.length === legal.length,
    onlyKing: affordable.length > 0 && affordable.every(m => m.piece === 'k'),
    forced: affordable.length === 1,
    bestCapture,
    reach,
  };
}

/**
 * Can the piece that just moved simply be taken?
 *
 * Called with the move already applied, so this is one move generation. Recaptures are not
 * searched -- this is one ply, not two -- so a defended piece reads as hanging when it is
 * merely traded. The value is the rate across thousands of plies, never the verdict on any
 * single move, and the copy shown to players says so.
 */
export function hangingAfter(chess: Chess, to: string, movedType: string,
                             gained: number): { hung: boolean; hungValue: number } {
  const replies = chess.moves({ verbose: true }) as unknown as VerboseMove[];
  const taken = replies.some(r => r.to === to && r.captured);
  if (!taken) return { hung: false, hungValue: 0 };
  const loss = pieceValue(movedType) - gained;
  return loss > 0 ? { hung: true, hungValue: loss } : { hung: false, hungValue: 0 };
}

/** The card half of a ply, read off the hand as it stood before the move. */
export function cardsSnapshot(chess: Chess, side: CardSide, color: Color,
                              plies: number, payment: PlyCards['payment'],
                              spentKind: string | null): PlyCards {
  const movable = movableTypes(chess);
  return {
    handSize: side.hand.length,
    handCap: handCapFor(aliveTypeCount(chess, color)),
    handKinds: handComposition(side),
    drawn: side.lastDrawn,
    deadHeld: deadHeldCount(side, movable),
    extinctHeld: extinctHeldCount(side, extinctTypes(chess, color)),
    replaced: side.lastReplaced.length,
    cycled: side.lastCycled.length,
    payment,
    spentKind,
    canCastle: canCastle(side),
    deckLeft: side.deck.length,
    discardLeft: side.discard.length,
    sacrificeReadyIn: sacrificeReadyIn(side, plies),
  };
}

// ---------- rolling a game up ----------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[at]);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function tally(into: Record<string, number>, key: string | null | undefined): void {
  if (!key) return;
  into[key] = (into[key] ?? 0) + 1;
}

function sideMetrics(plies: PlyMetric[], color: Color): SideMetrics {
  const mine = plies.filter(p => p.color === color);
  const think = mine.map(p => p.thinkMs).filter(n => n > 0);
  const waits = mine.map(p => p.waitMs).filter((n): n is number => n != null);

  const drawnKinds: Record<string, number> = {};
  const spentKinds: Record<string, number> = {};
  let cardsDrawn = 0;
  let cardsSpent = 0;
  let atCapTurns = 0;
  let emergencies = 0;
  let sacrifices = 0;
  let cycles = 0;
  let replacements = 0;
  const deadHeld: number[] = [];

  for (const p of mine) {
    const c = p.cards;
    if (!c) continue;
    cardsDrawn += c.drawn;
    cycles += c.cycled;
    replacements += c.replaced;
    deadHeld.push(c.deadHeld);
    if (c.handSize >= c.handCap) atCapTurns++;
    if (c.payment === 'emergency') emergencies++;
    if (c.payment === 'sacrifice') sacrifices++;
    if (c.payment === 'card' || c.payment === 'emergency') cardsSpent += 1;
    if (c.payment === 'sacrifice') cardsSpent += 3;
    tally(spentKinds, c.spentKind);
    // What was dealt is only known as a count, so the kinds seen are read off the hand:
    // it is the composition that answers "how many of each did I actually get".
    for (const [kind, n] of Object.entries(c.handKinds)) {
      drawnKinds[kind] = (drawnKinds[kind] ?? 0) + n;
    }
  }

  return {
    moves: mine.length,
    autoMoves: mine.filter(p => p.auto).length,
    botMoves: mine.filter(p => p.bot).length,
    thinkMsMean: Math.round(mean(think)),
    thinkMsP90: percentile(think, 90),
    waitMsMean: Math.round(mean(waits)),
    waitMsMax: waits.length > 0 ? Math.max(...waits) : 0,
    affordableRatioMean: mine.length === 0 ? 1
      : mean(mine.map(p => (p.legalMoves > 0 ? p.affordableMoves / p.legalMoves : 1))),
    openTurns: mine.filter(p => p.openTurn).length,
    onlyKingTurns: mine.filter(p => p.onlyKing).length,
    forcedTurns: mine.filter(p => p.forced).length,
    hangs: mine.filter(p => p.hung).length,
    missedTotal: mine.reduce((a, p) => a + p.missed, 0),
    captures: mine.filter(p => p.captured != null).length,
    checksGiven: 0,      // filled by the caller, which has the SAN
    cardsDrawn,
    cardsSpent,
    drawnKinds,
    spentKinds,
    deadHeldMean: mean(deadHeld),
    atCapTurns,
    emergencies,
    sacrifices,
    cycles,
    replacements,
  };
}

/**
 * Counters a side accumulates outside any one ply: opening the review, opening the phone
 * drawer, and which browsers played the turns.
 */
export interface ClientSession {
  reviewOpened: number;
  drawerOpened: number;
  devices: Record<string, number>;
  pointers: Record<string, number>;
  fx: Record<string, number>;
}

export function emptyClientSession(): ClientSession {
  return { reviewOpened: 0, drawerOpened: 0, devices: {}, pointers: {}, fx: {} };
}

/**
 * The browser half of a side's game.
 *
 * Every field is a count of what was *reported*, never of what happened: a player on a
 * client that never sent anything simply has none of this, which is why `plies` is here
 * to say how much of the game it covers. Reading a rate against `moves` instead would
 * quietly divide by turns nobody measured.
 */
function clientMetrics(plies: PlyMetric[], color: Color,
                       session: ClientSession): ClientSideMetrics {
  const mine = plies.filter(p => p.color === color && p.client);
  const touches = mine
    .map(p => p.client!.timeToFirstTouchMs)
    .filter((n): n is number => n != null && n >= 0);

  return {
    plies: mine.length,
    pickups: mine.reduce((a, p) => a + p.client!.pickups, 0),
    cardSelections: mine.reduce((a, p) => a + p.client!.cardSelections, 0),
    firstTouchMs: percentile(touches, 50),
    premovesPlayed: mine.filter(p => p.client!.premove === 'played').length,
    premovesRejected: mine.filter(p => p.client!.premove === 'rejected').length,
    reviewOpened: session.reviewOpened,
    drawerOpened: session.drawerOpened,
    devices: { ...session.devices },
    pointers: { ...session.pointers },
    fx: { ...session.fx },
  };
}

/**
 * Roll a finished game up.
 *
 * `checks` is passed in rather than derived here because the check flag lives in the SAN,
 * which is on the history entry rather than on the metric -- and duplicating the SAN into
 * the metric to avoid one argument would be the worse trade.
 *
 * `client` is optional for the same reason it is optional on the archive: a game where no
 * browser reported anything should carry no client block at all, rather than a block of
 * zeroes that reads as "nobody hesitated".
 */
export function summariseGame(plies: PlyMetric[], durationMs: number,
                              checks: { white: number; black: number },
                              winner: Color | 'draw' | null,
                              client?: { white: ClientSession; black: ClientSession },
                             ): GameMetrics {
  const white = sideMetrics(plies, 'white');
  const black = sideMetrics(plies, 'black');
  white.checksGiven = checks.white;
  black.checksGiven = checks.black;

  let leadChanges = 0;
  let maxLead = 0;
  let comeback = false;
  let lastSign = 0;

  for (const p of plies) {
    const m = p.materialAfter;
    maxLead = Math.max(maxLead, Math.abs(m));
    const sign = m > 0 ? 1 : m < 0 ? -1 : 0;
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) leadChanges++;
    if (sign !== 0) lastSign = sign;
    // the eventual winner was behind on material at some point
    if (winner === 'white' && m < 0) comeback = true;
    if (winner === 'black' && m > 0) comeback = true;
  }

  const reported = plies.some(p => p.client) || (client != null
    && (client.white.reviewOpened + client.white.drawerOpened
      + client.black.reviewOpened + client.black.drawerOpened) > 0);

  return {
    schema: METRICS_SCHEMA,
    plies,
    white,
    black,
    client: reported && client
      ? {
        white: clientMetrics(plies, 'white', client.white),
        black: clientMetrics(plies, 'black', client.black),
      }
      : undefined,
    durationMs,
    firstCapturePly: plies.find(p => p.captured != null)?.ply ?? null,
    firstCheckPly: plies.find(p => p.inCheck)?.ply ?? null,
    leadChanges,
    maxLead,
    comeback,
  };
}
