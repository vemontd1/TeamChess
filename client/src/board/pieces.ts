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
  p: `M22.5 12.4a4.3 4.3 0 0 0-2.4 7.9c-1.5.8-2.5 2.4-2.5 4.3 0 2 1.2 3.8 3 4.7
      -2.5 1.1-5.8 4.1-6.8 8.7h17.4c-1-4.6-4.3-7.6-6.8-8.7a5.2 5.2 0 0 0 3-4.7
      c0-1.9-1-3.5-2.5-4.3a4.3 4.3 0 0 0-2.4-7.9z`,

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

  /*
   * The king used to be a dome on a flared base -- which is also what a pawn is, only
   * larger, and at board size the two were genuinely hard to tell apart. It is now built
   * from the four things that make a Staunton king read at a glance and that a pawn has
   * none of: a cross carried in the silhouette itself, a crown that widens rather than
   * closes, a pinched collar, and a base twice the pawn's width.
   *
   * Cross, then crown shoulders, then the collar, then the two-tier base.
   */
  k: `M21.1 2.6h2.8v2.9h2.9v2.8h-2.9v2.9c3.6.6 6.2 3.4 6.2 6.8 0 2.1-1 4-2.6 5.2
      1.4.8 2.3 2.1 2.3 3.6 0 1.2-.5 2.3-1.4 3.1h2.2l1.9 4.5H12.5l1.9-4.5h2.2
      c-.9-.8-1.4-1.9-1.4-3.1 0-1.5.9-2.8 2.3-3.6a7 7 0 0 1-2.6-5.2
      c0-3.4 2.6-6.2 6.2-6.8V8.3h-2.9V5.5h2.9V2.6z
      M10.6 34.4h23.8v3.6H10.6v-3.6z`,
};

/** Extra strokes drawn on top of the body (crosses, crenellations, mitre slits). */
const DETAIL: Partial<Record<PieceType, string>> = {
  k: `M17.6 26.7h9.8M12.6 34.5h19.8`,
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

  // A hard-edged ellipse under the piece is a shape, not a shadow: at board size its rim
  // aliased into a visible stair-stepped band. Blurring it in the SVG -- where the filter
  // runs at the rasterised size rather than on a scaled bitmap -- is what makes it read as
  // contact rather than as a drawn oval. The id is per-colour so two <defs> never collide.
  const blurId = `pcsh-${code}`;

  return `<svg viewBox="-3 -3 51 51" xmlns="http://www.w3.org/2000/svg" class="pc-svg">
  <defs>
    <filter id="${blurId}" x="-50%" y="-120%" width="200%" height="340%">
      <feGaussianBlur stdDeviation="1.15"/>
    </filter>
  </defs>
  <g class="pc-shadow" filter="url(#${blurId})">
    <ellipse cx="22.5" cy="39.4" rx="11.4" ry="2.5"/>
  </g>
  ${rim}
  <path d="${BODY[type]}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"
        stroke-linejoin="round" stroke-linecap="round"/>
  ${detail ? `<path d="${detail}" fill="none" stroke="${stroke}" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>` : ''}
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
