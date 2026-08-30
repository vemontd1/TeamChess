import { escapeHtml } from '../util/format';

/**
 * The small chart toolkit the admin panel draws with.
 *
 * Plain SVG, built as strings alongside the rest of the panel, because everything here is
 * a bar of some kind and a charting library would be a larger dependency than the code it
 * replaced. What it is not is a general chart library: it draws columns, bars and meters,
 * and anything else should be added deliberately rather than by growing an options bag.
 *
 * The rules it holds itself to, which are the reason it looks calm:
 *
 * - Marks carry the colour; text never does. Values, labels and legends wear the theme's
 *   ink, because a saturated hue at 11px on a near-black panel is not readable.
 * - Bars are capped at 24px, with a 2px gap doing the separating rather than a stroke.
 * - Every chart is also a table, in a `details` under it. Colour is never the only way to
 *   read a number: that is the fallback for colour blindness, for a screen reader, and
 *   for the person who wants the actual figure.
 * - One series gets no legend -- the title already names it.
 *
 * The three series colours are stepped for this panel's own surface and checked for
 * colour-blind separation as a set; they live in `charts.css` beside the note that says
 * so, and are read from there rather than written here.
 */

export interface Series {
  name: string;
  /** A CSS custom property name, e.g. `--viz-1`. */
  color: string;
  values: number[];
}

export interface ChartOpts {
  cats: string[];
  series: Series[];
  /** How a value is written in the tooltip and the table. */
  format?: (n: number) => string;
  /** Height of the plot in viewBox units. */
  height?: number;
  /** Draw every nth category label, for a crowded axis. */
  labelEvery?: number;
  /** What one category is, for the table's first column. */
  catLabel?: string;
  /** What the picture says, for anyone who cannot see it. */
  label?: string;
}

/*
 * The viewBox is close to the width a figure is actually drawn at, and that is not a
 * detail: everything inside an SVG scales with it, text included. Drawn at 720 units into
 * a 420px column, an 11-unit label renders at 6px -- legible in the file and unreadable
 * on the page. 480 keeps text within a fraction of its nominal size at every column width
 * this panel uses.
 */
const W = 480;
const PAD = { top: 12, right: 10, bottom: 26, left: 38 };
const MAX_BAR = 22;
const GAP = 2;

const fmtDefault = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** 1.5s, 40s, 3m 20s -- a duration a person can read at a glance. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(n: number, digits = 2): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

/**
 * An axis label has one line of a band to fit in, so durations lose their decimals here:
 * `1-2s`, not `1.0s-2.0s`. The exact bounds are in the table under every chart.
 */
export function compactMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/** Bucket bounds to axis labels: <1s, 1-2s, ..., 60s+. */
export function bucketLabels(bounds: number[], unit: 'ms' | 'plies'): string[] {
  const write = (n: number): string => (unit === 'ms' ? compactMs(n) : String(n));
  const out = bounds.map((b, i) => (i === 0 ? `<${write(b)}` : `${write(bounds[i - 1])}-${write(b)}`));
  out.push(`${write(bounds[bounds.length - 1])}+`);
  return out;
}

/** A clean top for the axis, so the ticks are numbers rather than measurements. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (v <= step * mag) return step * mag;
  }
  return 10 * mag;
}

/** A column with its data-end rounded and its baseline square. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rad = Math.min(r, w / 2, h);
  if (h <= 0.5) return '';
  return `M${x},${y + h}V${y + rad}Q${x},${y} ${x + rad},${y}`
    + `H${x + w - rad}Q${x + w},${y} ${x + w},${y + rad}V${y + h}Z`;
}

/** The same, lying down: the rounded end is the right one. */
function barPathH(x: number, y: number, w: number, h: number, r = 4): string {
  const rad = Math.min(r, h / 2, w);
  if (w <= 0.5) return '';
  return `M${x},${y}H${x + w - rad}Q${x + w},${y} ${x + w},${y + rad}`
    + `V${y + h - rad}Q${x + w},${y + h} ${x + w - rad},${y + h}H${x}Z`;
}

function tip(cat: string, series: Series[], i: number, format: (n: number) => string): string {
  const lines = series.map(s =>
    `${series.length > 1 ? `${s.name}: ` : ''}${format(s.values[i] ?? 0)}`);
  return escapeHtml([cat, ...lines].join(' · '));
}

function table(o: ChartOpts, format: (n: number) => string): string {
  return `<details class="viz-table-wrap"><summary>Table</summary>
    <div class="viz-table-scroll"><table class="viz-table">
      <thead><tr><th>${escapeHtml(o.catLabel ?? '')}</th>
        ${o.series.map(s => `<th>${escapeHtml(s.name)}</th>`).join('')}</tr></thead>
      <tbody>${o.cats.map((c, i) => `<tr><th>${escapeHtml(c)}</th>
        ${o.series.map(s => `<td>${escapeHtml(format(s.values[i] ?? 0))}</td>`).join('')}
      </tr>`).join('')}</tbody>
    </table></div></details>`;
}

/**
 * Columns: a category on the x axis, one or more series in each band.
 *
 * Used for every distribution here, because a histogram's buckets are ordered and a
 * column reads left to right the way the buckets do.
 */
export function columnChart(o: ChartOpts): string {
  const format = o.format ?? fmtDefault;
  const height = o.height ?? 200;
  const plotW = W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const base = PAD.top + plotH;

  const all = o.series.flatMap(s => s.values);
  const top = niceMax(Math.max(...all, 0));
  const band = plotW / Math.max(1, o.cats.length);
  const barW = Math.min(MAX_BAR, Math.max(3, band / o.series.length - GAP - 2));
  const groupW = barW * o.series.length + GAP * (o.series.length - 1);
  const every = o.labelEvery ?? 1;

  const ticks = [0, top / 2, top];
  const grid = ticks.map(t => {
    const y = base - (t / top) * plotH;
    return `<line class="viz-grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y}" y2="${y}"/>
      <text class="viz-tick" x="${PAD.left - 8}" y="${y + 3.5}" text-anchor="end">${
        escapeHtml(format(t))}</text>`;
  }).join('');

  const marks = o.cats.map((cat, i) => {
    const x0 = PAD.left + i * band + (band - groupW) / 2;
    const cols = o.series.map((s, k) => {
      const v = s.values[i] ?? 0;
      const h = top > 0 ? (v / top) * plotH : 0;
      const x = x0 + k * (barW + GAP);
      return `<path d="${barPath(x, base - h, barW, h)}" fill="var(${s.color})"/>`;
    }).join('');
    const label = i % every === 0
      ? `<text class="viz-cat" x="${PAD.left + i * band + band / 2}" y="${base + 14}"
          text-anchor="middle">${escapeHtml(cat)}</text>`
      : '';
    return `${cols}${label}
      <rect class="viz-hit" x="${PAD.left + i * band}" y="${PAD.top}" width="${band}"
        height="${plotH}" data-tip="${tip(cat, o.series, i, format)}"/>`;
  }).join('');

  return `<div class="viz">
    <svg viewBox="0 0 ${W} ${height}" role="img" preserveAspectRatio="xMidYMid meet"
      aria-label="${escapeHtml(o.label ?? '')}">
      ${grid}
      <line class="viz-axis" x1="${PAD.left}" x2="${W - PAD.right}" y1="${base}" y2="${base}"/>
      ${marks}
    </svg>
    ${table(o, format)}
  </div>`;
}

/**
 * A line over an ordered x axis, for a value that moves rather than one that is counted.
 *
 * The only thing here that is not a bar, and it earns it: a material trajectory is a
 * shape -- who was ahead, when it turned, how far it swung -- and a column per ply would
 * draw a comb instead of a shape.
 *
 * `zeroed` puts the baseline in the middle and scales symmetrically, which is what a
 * signed value needs: a lead of two pawns and a deficit of two have to be the same
 * distance from nothing, or the picture lies about the game.
 */
export function lineChart(o: ChartOpts & { zeroed?: boolean }): string {
  const format = o.format ?? fmtDefault;
  const height = o.height ?? 190;
  const plotW = W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const base = PAD.top + plotH;

  const all = o.series.flatMap(s => s.values);
  const top = niceMax(Math.max(...all.map(Math.abs), 0));
  const lo = o.zeroed ? -top : 0;
  const span = top - lo || 1;
  const y = (v: number): number => base - ((v - lo) / span) * plotH;
  const x = (i: number): number => PAD.left
    + (o.cats.length <= 1 ? plotW / 2 : (i / (o.cats.length - 1)) * plotW);
  const every = o.labelEvery ?? 1;

  const ticks = o.zeroed ? [top, 0, -top] : [top, top / 2, 0];
  const grid = ticks.map(t => `<line class="viz-grid${t === 0 ? ' viz-zero' : ''}"
      x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t)}" y2="${y(t)}"/>
    <text class="viz-tick" x="${PAD.left - 6}" y="${y(t) + 3.5}"
      text-anchor="end">${escapeHtml(format(t))}</text>`).join('');

  const lines = o.series.map(s => {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`);
    if (pts.length === 0) return '';
    const last = s.values.length - 1;
    return `<path class="viz-area" d="M${x(0)},${y(lo === 0 ? 0 : 0)}L${pts.join('L')}
        L${x(last)},${y(0)}Z" fill="var(${s.color})"/>
      <polyline class="viz-line" points="${pts.join(' ')}" stroke="var(${s.color})"/>
      <circle class="viz-dot" cx="${x(last)}" cy="${y(s.values[last])}" r="4"
        fill="var(${s.color})"/>`;
  }).join('');

  const hits = o.cats.map((cat, i) => {
    const band = plotW / Math.max(1, o.cats.length);
    const label = i % every === 0
      ? `<text class="viz-cat" x="${x(i)}" y="${base + 14}"
          text-anchor="middle">${escapeHtml(cat)}</text>`
      : '';
    return `${label}<rect class="viz-hit" x="${x(i) - band / 2}" y="${PAD.top}"
      width="${band}" height="${plotH}" data-tip="${tip(cat, o.series, i, format)}"/>`;
  }).join('');

  return `<div class="viz">
    <svg viewBox="0 0 ${W} ${height}" role="img" preserveAspectRatio="xMidYMid meet"
      aria-label="${escapeHtml(o.label ?? '')}">
      ${grid}
      ${lines}
      ${hits}
    </svg>
    ${table(o, format)}
  </div>`;
}

/**
 * Horizontal bars, for categories whose names are words rather than ranges -- a funnel
 * stage, a card kind. The label sits in the row, so nothing has to be rotated.
 */
export function barChart(o: ChartOpts & { rowHeight?: number }): string {
  const format = o.format ?? fmtDefault;
  const rowH = o.rowHeight ?? 24;
  const labelW = 112;
  // Two series need room for both numbers: they are printed in legend order, because a
  // single figure at the end of a pair of bars says nothing about which bar it belongs to.
  const valueW = o.series.length > 1 ? 84 : 54;
  const plotW = W - labelW - valueW;
  const all = o.series.flatMap(s => s.values);
  const top = niceMax(Math.max(...all, 0));
  const height = o.cats.length * rowH + 8;
  const thickness = Math.min(MAX_BAR, (rowH - 8) / o.series.length - (o.series.length > 1 ? GAP : 0));

  const rows = o.cats.map((cat, i) => {
    const y0 = i * rowH + 4;
    const groupH = thickness * o.series.length + GAP * (o.series.length - 1);
    const bars = o.series.map((s, k) => {
      const v = s.values[i] ?? 0;
      const w = top > 0 ? (v / top) * plotW : 0;
      const y = y0 + (rowH - 8 - groupH) / 2 + k * (thickness + GAP);
      return `<path d="${barPathH(labelW, y, w, thickness)}" fill="var(${s.color})"/>`;
    }).join('');
    const written = o.series.map(s => format(s.values[i] ?? 0)).join(' / ');
    return `<text class="viz-cat" x="0" y="${y0 + rowH / 2 - 2}"
        dominant-baseline="middle">${escapeHtml(cat)}</text>
      ${bars}
      <text class="viz-value" x="${W}" y="${y0 + rowH / 2 - 2}" text-anchor="end"
        dominant-baseline="middle">${escapeHtml(written)}</text>
      <rect class="viz-hit" x="0" y="${y0 - 2}" width="${W}" height="${rowH}"
        data-tip="${tip(cat, o.series, i, format)}"/>`;
  }).join('');

  return `<div class="viz">
    <svg viewBox="0 0 ${W} ${height}" role="img" preserveAspectRatio="xMidYMid meet"
      aria-label="${escapeHtml(o.label ?? '')}">
      ${rows}
    </svg>
    ${table(o, format)}
  </div>`;
}

/** The identity channel that is not colour: a dot, the name, in ordinary ink. */
export function legend(series: Series[]): string {
  if (series.length < 2) return '';
  return `<div class="viz-legend">${series.map(s =>
    `<span><i style="background:var(${s.color})"></i>${escapeHtml(s.name)}</span>`).join('')}</div>`;
}

export interface FigureOpts {
  title: string;
  note?: string;
  /** Small figures above the chart: the numbers worth reading without hovering. */
  stats?: Array<{ label: string; value: string }>;
  series?: Series[];
  chart: string;
}

export function figure(o: FigureOpts): string {
  return `<figure class="viz-fig">
    <figcaption>
      <span class="viz-title">${escapeHtml(o.title)}</span>
      ${o.note ? `<span class="viz-note">${escapeHtml(o.note)}</span>` : ''}
    </figcaption>
    ${o.stats && o.stats.length > 0 ? `<div class="viz-stats">${o.stats.map(s =>
      `<div><b>${escapeHtml(s.value)}</b><span>${escapeHtml(s.label)}</span></div>`)
      .join('')}</div>` : ''}
    ${o.series ? legend(o.series) : ''}
    ${o.chart}
  </figure>`;
}

/**
 * One tooltip for the whole page, moved to whatever is under the pointer.
 *
 * A chart in HTML is interactive whether or not it was designed to be -- people point at
 * bars. The alternative to a tooltip is a number printed on every mark, which is how a
 * readable chart becomes an unreadable one.
 */
export function wireCharts(root: HTMLElement): () => void {
  let tipEl: HTMLElement | null = null;

  const hide = (): void => { tipEl?.remove(); tipEl = null; };

  const show = (target: SVGElement, text: string): void => {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'viz-tip';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    const box = target.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const left = Math.min(window.innerWidth - w - 8,
      Math.max(8, box.left + box.width / 2 - w / 2));
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${Math.max(8, box.top - tipEl.offsetHeight - 8)}px`;
  };

  const over = (e: Event): void => {
    const hit = (e.target as Element).closest?.('.viz-hit') as SVGElement | null;
    if (!hit) { hide(); return; }
    show(hit, hit.getAttribute('data-tip') ?? '');
  };

  root.addEventListener('pointerover', over);
  root.addEventListener('pointerleave', hide);
  window.addEventListener('scroll', hide, true);
  return () => {
    root.removeEventListener('pointerover', over);
    root.removeEventListener('pointerleave', hide);
    window.removeEventListener('scroll', hide, true);
    hide();
  };
}
