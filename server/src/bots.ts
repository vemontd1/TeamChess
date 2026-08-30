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

/**
 * Choose a legal move.
 *
 * 'random' is a uniform draw over legal moves -- this is what a blown clock plays,
 * so a timeout stays genuinely arbitrary and nobody can farm the timer for a good move.
 *
 * 'greedy' is a one-ply material grab used by bot seats: take the most valuable hanging
 * piece, otherwise promote, otherwise check, otherwise move at random. Deliberately weak;
 * it exists to keep a rotation flowing, not to be an opponent.
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
  const all = chess.moves({ verbose: true }) as unknown as VerboseMove[];
  const castles = (m: VerboseMove): boolean =>
    m.flags.includes('k') || m.flags.includes('q');
  // Castling is a king move, so `allowedTypes` waves it through -- but in cards mode it
  // costs a Rook card, and a hand without one cannot play it. Filtered before the pool is
  // narrowed, so the fallback below cannot quietly hand it back.
  const legal = opts.allowCastle === false ? all.filter(m => !castles(m)) : all;
  const narrowed = allowedTypes ? legal.filter(m => allowedTypes.has(m.piece)) : legal;
  const moves = narrowed.length > 0 ? narrowed : legal;
  if (moves.length === 0) return null;

  const take = (m: VerboseMove): PickedMove => ({
    from: m.from, to: m.to, promotion: m.promotion,
  });

  if (style === 'random') {
    return take(moves[Math.floor(Math.random() * moves.length)]);
  }

  let best: VerboseMove[] = [];
  let bestScore = -Infinity;
  for (const m of moves) {
    let score = 0;
    if (m.captured) score += pieceValue(m.captured) * 10;
    if (m.promotion) score += pieceValue(m.promotion) * 8;
    if (m.san.includes('#')) score += 1000;
    else if (m.san.includes('+')) score += 2;
    score += Math.random(); // break ties so the bot is not deterministic
    if (score > bestScore) { bestScore = score; best = [m]; }
    else if (score === bestScore) best.push(m);
  }
  return take(best[Math.floor(Math.random() * best.length)]);
}

/** Staged think time so a bot move is watchable rather than instantaneous. */
export function botThinkMs(): number {
  return 600 + Math.floor(Math.random() * 800);
}
