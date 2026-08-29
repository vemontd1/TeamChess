// Derive captured pieces and material balance straight from a FEN.
const START: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export interface Captured { type: string; count: number; }
export interface CapturedInfo {
  whiteCaptured: Captured[]; // black pieces White has taken
  blackCaptured: Captured[]; // white pieces Black has taken
  advantage: number;         // >0 White ahead, <0 Black ahead (points)
}

export function capturedInfo(fen: string): CapturedInfo {
  const board = fen.split(' ')[0];
  const count: Record<'w' | 'b', Record<string, number>> = { w: {}, b: {} };
  for (const ch of board) {
    if (/[pnbrqk]/i.test(ch)) {
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const t = ch.toLowerCase();
      count[color][t] = (count[color][t] || 0) + 1;
    }
  }
  const missing = (color: 'w' | 'b'): Captured[] => {
    const arr: Captured[] = [];
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const m = (START[t] || 0) - (count[color][t] || 0);
      if (m > 0) arr.push({ type: t, count: m });
    }
    return arr;
  };
  const whiteCaptured = missing('b');
  const blackCaptured = missing('w');
  const val = (arr: Captured[]) => arr.reduce((s, x) => s + VALUE[x.type] * x.count, 0);
  return { whiteCaptured, blackCaptured, advantage: val(whiteCaptured) - val(blackCaptured) };
}
