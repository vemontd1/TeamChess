import type { Chess } from 'chess.js';

export type MoveStyle = 'random' | 'greedy';

export interface PickedMove { from: string; to: string; promotion?: string; }

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function pieceValue(type: string): number {
  return VALUE[type.toLowerCase()] ?? 0;
}

interface VerboseMove {
  from: string; to: string; promotion?: string;
  captured?: string; san: string; flags: string; piece: string;
}

export interface ScoredMove extends VerboseMove { score: number; }

const CENTRE = new Set(['d4', 'd5', 'e4', 'e5']);
const WIDE_CENTRE = new Set([
  'c3', 'c4', 'c5', 'c6', 'd3', 'd6', 'e3', 'e6', 'f3', 'f4', 'f5', 'f6',
]);

function castles(m: VerboseMove): boolean {
  return m.flags.includes('k') || m.flags.includes('q');
}

/**
 * Score one move, one ply deep, and then check what it walks into.
 *
 * The old score was material only: a capture was worth ten times the piece, a promotion
 * eight, mate a thousand, and everything else zero plus a random tiebreak. Most positions
 * offer no capture at all, so most turns every legal move scored the same and the bot
 * picked among them at random -- which is exactly what it looked like from the other side
 * of the board.
 *
 * Two cheap terms fix most of that. The first is the one a beginner learns first: after
 * making the move, can the piece simply be taken? A bot that hangs its queen every third
 * turn reads as broken rather than as weak. The second is a nudge toward the middle and
 * off the back rank, which is enough to make an opening look like an opening.
 *
 * It is still one ply and still meant to be weak. It is not meant to look aimless.
 */
function scoreMove(chess: Chess, m: VerboseMove): number {
  let score = 0;

  if (m.captured) score += pieceValue(m.captured) * 10;
  if (m.promotion) score += pieceValue(m.promotion) * 8;
  if (m.san.includes('#')) score += 1000;
  else if (m.san.includes('+')) score += 2;

  // Centre and development, small enough that they never outweigh material.
  if (CENTRE.has(m.to)) score += 1.2;
  else if (WIDE_CENTRE.has(m.to)) score += 0.5;
  if ((m.piece === 'n' || m.piece === 'b') && /[18]$/.test(m.from)) score += 0.8;
  if (castles(m)) score += 1.5;
  if (m.piece === 'q' && chess.moveNumber() < 6) score -= 1.5;   // no early queen sorties

  // What does it walk into? Play the move and ask whether the opponent can take on the
  // square it landed on. Recaptures are not searched -- this is one ply, not two -- so a
  // defended piece is treated as merely risky rather than lost.
  try {
    chess.move({ from: m.from, to: m.to, promotion: (m.promotion as 'q') ?? 'q' });
    const replies = chess.moves({ verbose: true }) as unknown as VerboseMove[];
    const taken = replies.some(r => r.to === m.to && r.captured);
    if (taken) {
      const mine = pieceValue(m.promotion ?? m.piece);
      const gained = m.captured ? pieceValue(m.captured) : 0;
      // Losing more than the capture won is what to avoid; an even trade is not a blunder.
      if (mine > gained) score -= (mine - gained) * 9;
    }
    chess.undo();
  } catch {
    // A move the engine will not make cannot be scored on what follows it; the material
    // terms above still stand, and `applyMove` is the thing that decides legality anyway.
  }

  return score + Math.random() * 0.4;   // break ties without drowning the signal
}

/**
 * Every legal move, scored and sorted best first.
 *
 * `allowedTypes` narrows to piece types the mover can actually move -- in cards mode that
 * is the hand's reach. `allowCastle: false` removes castling entirely, since in cards mode
 * it is the one king move that has to be paid for.
 *
 * Unlike `pickMove` this does not fall back to the full pool when the narrowing empties
 * it: a caller comparing what it can afford against what it cannot needs those two pools
 * kept apart.
 */
export function rankMoves(chess: Chess, style: MoveStyle, allowedTypes?: Set<string>,
                          opts: { allowCastle?: boolean } = {}): ScoredMove[] {
  const all = chess.moves({ verbose: true }) as unknown as VerboseMove[];
  const legal = opts.allowCastle === false ? all.filter(m => !castles(m)) : all;
  const pool = allowedTypes ? legal.filter(m => allowedTypes.has(m.piece)) : legal;

  if (style === 'random') {
    return pool.map(m => ({ ...m, score: Math.random() }))
      .sort((a, b) => b.score - a.score);
  }
  return pool.map(m => ({ ...m, score: scoreMove(chess, m) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Choose a legal move.
 *
 * 'random' is a uniform draw over legal moves -- this is what a blown clock plays, so a
 * timeout stays genuinely arbitrary and nobody can farm the timer for a good move.
 *
 * 'greedy' is the one-ply evaluation above, used by bot seats. Deliberately weak; it
 * exists to keep a rotation flowing, not to be an opponent.
 *
 * `allowedTypes` narrows the pool to piece types the mover can actually move. In cards
 * mode that is the hand's reach, so a blown clock plays a move the player could have
 * played rather than one the cards never permitted. It falls back to the full pool if the
 * narrowing leaves nothing, which cannot happen while the king is free but costs nothing
 * to guard.
 *
 * `allowCastle: false` removes castling from the pool entirely, including from that
 * fallback -- in cards mode it is the one king move that has to be paid for.
 */
export function pickMove(chess: Chess, style: MoveStyle, allowedTypes?: Set<string>,
                         opts: { allowCastle?: boolean } = {}): PickedMove | null {
  const narrowed = rankMoves(chess, style, allowedTypes, opts);
  const best = narrowed.length > 0 ? narrowed : rankMoves(chess, style, undefined, opts);
  const top = best[0];
  return top ? { from: top.from, to: top.to, promotion: top.promotion } : null;
}

/** Staged think time so a bot move is watchable rather than instantaneous. */
export function botThinkMs(): number {
  return 600 + Math.floor(Math.random() * 800);
}
