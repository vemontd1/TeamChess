/**
 * Classic Staunton silhouettes as inline SVG, drawn on a 45x45 grid.
 *
 * Each piece is a single path so it can be filled and stroked as one shape, then
 * duplicated per colour. White is bone with a warm brown outline; black is near-black
 * with an amber rim-light, which is what keeps dark pieces legible on dark squares.
 */

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PieceColor = 'w' | 'b';
export type PieceCode = `${PieceColor}${PieceType}`;

/** Body paths, drawn in a 45x45 viewBox with the base sitting near y=38. */
const BODY: Record<PieceType, string> = {
  p: `M22.5 9a4.6 4.6 0 0 0-2.6 8.4c-1.6.9-2.7 2.6-2.7 4.6 0 2.2 1.3 4.1 3.2 5
      -2.6 1.2-6.2 4.5-7.2 12.4h19.6c-1-7.9-4.6-11.2-7.2-12.4a5.6 5.6 0 0 0 3.2-5
      c0-2-1.1-3.7-2.7-4.6A4.6 4.6 0 0 0 22.5 9z`,

  r: `M11 39h23v-4H11v4zm2-4.5h19v-4.5H13v4.5zM14 30V17h17v13H14zM11.5 17V9.5h4V13h4V9.5h6V13h4V9.5h4V17h-22z`,

  /* Horse in profile facing left: chest, throat, muzzle, brow, ear, then the mane
     down the back to the base. */
  n: `M13.6 38c.3-4.4 1.7-8.1 4.1-11.3 1.2-1.6 2-3 2.4-4.4
      -2.4 1.4-5.2 2.6-7.2 2-1.6-.6-1.8-2.4-.6-4.4 1.4-2.4 3.6-4.8 6-6.8
      .4-2 1.2-4.4 2.6-5.6 1.2-1 2.2-.4 2.4 1.2.1.8 0 1.6-.2 2.2
      3.4.6 6.2 2.8 7.8 6 1.6 3.2 2.1 7.2 2.2 11.6V38H13.6z`,

  b: `M22.5 8a2.6 2.6 0 0 0-1.6 4.7c-2.8 1.7-4.8 5-4.8 8.6 0 2.6 1 4.6 2.4 6.2
      -1.6.9-2.7 2.2-3.3 3.6h13.6c-.6-1.4-1.7-2.7-3.3-3.6 1.4-1.6 2.4-3.6 2.4-6.2
      0-3.6-2-6.9-4.8-8.6A2.6 2.6 0 0 0 22.5 8zM12 38h21c0-2.3-1.6-4-4-4H16c-2.4 0-4 1.7-4 4z`,

  q: `M9 13.5a2.2 2.2 0 1 1 2.6 2.2l2.3 7.2 3.2-8.4a2.2 2.2 0 1 1 2.6-.4l1.9 8.6 1.9-8.6
      a2.2 2.2 0 1 1 2.6.4l3.2 8.4 2.3-7.2A2.2 2.2 0 1 1 36 13.5c0 1-.7 1.9-1.6 2.1L31.5 31h-18
      L10.6 15.6A2.2 2.2 0 0 1 9 13.5zM13 33h19c0 2-1 3-2.5 3h-14C14 36 13 35 13 33z
      M13.5 38h18v-1.2h-18V38z`,

  /* Domed crown over a pinched collar, flaring to a stepped base; the cross sits
     above as a detail stroke. */
  k: `M22.5 10.4c3.3 0 5.7 2.2 5.7 5.4 0 1.8-.8 3.2-2 4.2 2.6 3 4.6 7.6 5.2 13H13.6
      c.6-5.4 2.6-10 5.2-13-1.2-1-2-2.4-2-4.2 0-3.2 2.4-5.4 5.7-5.4z
      M12.2 34.2h20.6v3.6H12.2v-3.6z`,
};

/** Extra strokes drawn on top of the body (crosses, crenellations, mitre slits). */
const DETAIL: Partial<Record<PieceType, string>> = {
  k: `M22.5 3.8v6.4M19.7 6.4h5.6M18.7 20a7.6 7.6 0 0 0 7.6 0`,
  b: `M22.5 15.5v5.5M20 18.2h5`,
  q: `M13.5 33.5h18M14 30.5h17`,
  r: `M14 30h17M13 34.6h19`,
  n: `M19.4 15.4a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3M26 15c1.6 2.4 2.4 5.6 2.6 9`,
};

const WHITE_FILL = '#E8DCC8';
const WHITE_STROKE = '#6B5A42';
const BLACK_FILL = '#23201E';
const BLACK_STROKE = '#0B0A09';
const RIM = '#E8B04B';

function svgFor(code: PieceCode): string {
  const color = code[0] as PieceColor;
  const type = code[1] as PieceType;
  const isWhite = color === 'w';
  const fill = isWhite ? WHITE_FILL : BLACK_FILL;
  const stroke = isWhite ? WHITE_STROKE : BLACK_STROKE;
  const detail = DETAIL[type];

  // The black set carries a faint amber rim under the body so its silhouette separates
  // from the dark squares; the white set relies on its own dark outline instead.
  const rim = isWhite ? '' :
    `<path d="${BODY[type]}" fill="none" stroke="${RIM}" stroke-width="2.6"
       stroke-linejoin="round" stroke-linecap="round" opacity="0.30"
       transform="translate(0,0.5)"/>`;

  return `<svg viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg" class="pc-svg">
  <g class="pc-shadow"><ellipse cx="22.5" cy="39.6" rx="10.5" ry="2.4"/></g>
  ${rim}
  <path d="${BODY[type]}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"
        stroke-linejoin="round" stroke-linecap="round"/>
  ${detail ? `<path d="${detail}" fill="none" stroke="${stroke}" stroke-width="1.4"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>` : ''}
</svg>`;
}

const cache = new Map<PieceCode, string>();

export function pieceSvg(code: PieceCode): string {
  let s = cache.get(code);
  if (!s) { s = svgFor(code); cache.set(code, s); }
  return s;
}

export const ALL_PIECES: PieceCode[] = [
  'wp', 'wn', 'wb', 'wr', 'wq', 'wk',
  'bp', 'bn', 'bb', 'br', 'bq', 'bk',
];

/** Material glyphs for the captured tray, at a smaller weight. */
export function trayIcon(color: PieceColor, type: PieceType): string {
  return pieceSvg(`${color}${type}` as PieceCode);
}
