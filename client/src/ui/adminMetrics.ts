import { escapeHtml, timeAgo } from '../util/format';
import {
  barChart, bucketLabels, columnChart, figure, fmtMs, fmtNum, fmtPct, type Series,
} from './charts';
import type {
  Distribution, GameMode, GuardrailRow, Insights, ModeInsights,
} from '../types';

/**
 * The metrics tab: the archive rolled up, drawn.
 *
 * Its own module because it is a different kind of thing from the rest of the admin page.
 * The other tabs list records -- reports, games, setups -- and a list is mostly markup.
 * This one is a reading of the game, and the decisions in it (which target a number is
 * held to, which distribution answers which question, what a phase is) are worth keeping
 * where they can be read together.
 *
 * Nothing here fetches. It is handed the aggregate and returns a string, which is what
 * makes it renderable outside a browser -- the preview harness under `test/` draws these
 * same figures to a file.
 */

// ---------- the metrics tab ----------

const MODE_NAME: Record<GameMode, string> = { cards: 'Chess Cards', team: 'Team Chess' };

/** A word and a mark, so a status is never only a colour. */
const STATUS: Record<GuardrailRow['status'], { mark: string; word: string }> = {
  good: { mark: '✓', word: 'on target' },
  watch: { mark: '!', word: 'just outside' },
  off: { mark: '✕', word: 'off target' },
  info: { mark: '→', word: 'no ceiling' },
  unknown: { mark: '?', word: 'too little play' },
};

function writeValue(unit: GuardrailRow['unit'], value: number): string {
  return unit === 'pct' ? fmtPct(value) : unit === 'ms' ? fmtMs(value) : fmtNum(value);
}

/**
 * One target, and where we sit against it.
 *
 * A meter rather than a chart: there is one number and a band it is supposed to be in,
 * and the fastest way to read that is to see the mark inside the band or outside it. The
 * scale runs a third above whatever is largest, so a value that has gone well past its
 * ceiling still has somewhere to be drawn.
 */
function guardrailRow(g: GuardrailRow): string {
  const s = STATUS[g.status];
  const value = g.value ?? 0;
  const top = Math.max(value, g.max ?? 0, (g.min ?? 0) * 2, 1e-9) * 1.35;
  const at = (n: number): number => Math.min(100, Math.max(0, (n / top) * 100));
  const bandFrom = at(g.min ?? 0);
  const bandTo = at(g.max ?? top);
  const reading = g.value == null ? 'no reading' : writeValue(g.unit, value);

  return `<article class="grd grd-${g.status}">
    <header>
      <span class="grd-label">${escapeHtml(g.label)}</span>
      <span class="grd-scope">${g.scope === 'all' ? 'both modes'
        : escapeHtml(MODE_NAME[g.scope as GameMode])}</span>
      <span class="grd-status"><i aria-hidden="true">${s.mark}</i> ${s.word}</span>
    </header>
    <div class="grd-body">
      <b class="grd-value">${g.value == null ? '—' : escapeHtml(reading)}</b>
      <div class="grd-meter" role="img"
        aria-label="${escapeHtml(`${g.label}: ${reading}, target ${g.target}, ${s.word}`)}">
        ${g.min != null || g.max != null
          ? `<span class="grd-band"
              style="left:${bandFrom}%;width:${Math.max(1, bandTo - bandFrom)}%"></span>`
          : ''}
        ${g.value != null ? `<span class="grd-fill" style="width:${at(value)}%"></span>
          <span class="grd-mark" style="left:${at(value)}%"></span>` : ''}
      </div>
      <span class="grd-target">target ${escapeHtml(g.target)}</span>
    </div>
    <p class="grd-why">${escapeHtml(g.why)}
      <span class="grd-n">${g.samples.toLocaleString()} ${
        g.unit === 'ratio' ? 'games' : 'measured'}</span></p>
  </article>`;
}

/** A distribution, with the numbers worth reading printed above it. */
function distributionFigure(title: string, note: string, d: Distribution): string {
  const write = (n: number): string => (d.unit === 'ms' ? fmtMs(n) : `${n}`);
  if (d.n === 0) {
    return `<figure class="viz-fig"><figcaption>
      <span class="viz-title">${escapeHtml(title)}</span></figcaption>
      <p class="viz-empty">Nothing measured yet.</p></figure>`;
  }
  return figure({
    title,
    note,
    stats: [
      { label: 'median', value: write(d.p50) },
      { label: 'p90', value: write(d.p90) },
      { label: 'mean', value: write(Math.round(d.mean)) },
      { label: 'longest', value: write(d.max) },
    ],
    chart: columnChart({
      cats: bucketLabels(d.bounds, d.unit),
      series: [{ name: title, color: '--viz-1', values: d.counts }],
      format: n => `${Math.round(n)}`,
      catLabel: d.unit === 'ms' ? 'range' : 'plies',
      label: `${title}: how many of the ${d.n} measured fell in each range`,
      height: 190,
    }),
  });
}

/** Shares rather than counts: what was held and what was spent are different sizes. */
function cardKindsFigure(m: ModeInsights): string {
  const kinds = [...new Set([...Object.keys(m.drawnKinds), ...Object.keys(m.spentKinds)])];
  if (kinds.length === 0) return '';
  const heldTotal = Object.values(m.drawnKinds).reduce((a, b) => a + b, 0) || 1;
  const spentTotal = Object.values(m.spentKinds).reduce((a, b) => a + b, 0) || 1;
  kinds.sort((a, b) => (m.drawnKinds[b] ?? 0) - (m.drawnKinds[a] ?? 0));

  const series: Series[] = [
    { name: 'Held', color: '--viz-1',
      values: kinds.map(k => (m.drawnKinds[k] ?? 0) / heldTotal) },
    { name: 'Spent', color: '--viz-2',
      values: kinds.map(k => (m.spentKinds[k] ?? 0) / spentTotal) },
  ];

  return figure({
    title: 'Cards held against cards spent',
    note: 'The share of each. A kind held far more often than it is spent is a kind the '
      + 'deck deals into hands that cannot use it.',
    series,
    chart: barChart({
      cats: kinds.map(k => k[0].toUpperCase() + k.slice(1)),
      series,
      format: n => fmtPct(n, 0),
      catLabel: 'kind',
      label: 'Share of cards held and spent, by piece kind',
    }),
  });
}

/** How the mode behaves at each end of a game, which is not the same behaviour. */
function phaseFigure(m: ModeInsights): string {
  if (m.plies === 0) return '';
  const cats = ['Opening (to 20)', 'Middle (21-60)', 'Endgame (61+)'];
  const series: Series[] = m.mode === 'cards'
    ? [
      { name: 'Legal moves affordable', color: '--viz-1',
        values: m.phases.map(p => p.affordableRatio) },
      { name: 'Open turns', color: '--viz-2', values: m.phases.map(p => p.openTurnRate) },
      { name: 'Emergency turns', color: '--viz-3',
        values: m.phases.map(p => p.emergencyRate) },
    ]
    : [
      { name: 'Pieces left hanging', color: '--viz-1',
        values: m.phases.map(p => p.hangRate) },
      { name: 'Moves the clock played', color: '--viz-2',
        values: m.phases.map(p => p.autoRate) },
    ];

  return figure({
    title: 'By phase of the game',
    note: `Plies measured: ${m.phases.map(p => p.plies.toLocaleString()).join(' / ')}.`,
    series,
    chart: columnChart({
      cats,
      series,
      format: n => fmtPct(n, 0),
      catLabel: 'phase',
      label: 'Mode health across the opening, the middle game and the endgame',
      height: 190,
    }),
  });
}

function modeTiles(m: ModeInsights): string {
  const tiles: Array<[string, string]> = m.mode === 'cards'
    ? [
      ['games measured', m.games.toLocaleString()],
      ['plies', m.plies.toLocaleString()],
      ['legal moves affordable', fmtPct(m.affordableRatio, 0)],
      ['open turns', fmtPct(m.openTurnRate)],
      ['only the king could move', fmtPct(m.onlyKingRate)],
      ['one move only', fmtPct(m.forcedRate)],
      ['emergency turns', fmtPct(m.emergencyRate)],
      ['sacrifices per game', fmtNum(m.sacrificesPerGame)],
    ]
    : [
      ['games measured', m.games.toLocaleString()],
      ['plies', m.plies.toLocaleString()],
      ['median think', fmtMs(m.think.p50)],
      ['p90 wait to move', fmtMs(m.wait.p90)],
      ['moves the clock played', fmtPct(m.autoRate)],
      ['pieces left hanging', fmtPct(m.hangRate)],
      ['captures', fmtPct(m.captureRate)],
      ['comebacks', fmtPct(m.comebackRate, 0)],
    ];
  return `<div class="adm-tiles">${tiles.map(([label, value]) =>
    `<div class="adm-tile"><b>${escapeHtml(value)}</b>
      <span>${escapeHtml(label)}</span></div>`).join('')}</div>`;
}

/**
 * The room funnel.
 *
 * Read downwards: each step is a room that got that far, so the interesting number is
 * never a bar but the gap between two of them. A mode that is never *started* is failing
 * somewhere no in-game metric can see.
 */
function funnelFigure(ins: Insights): string {
  const f = ins.funnel;
  if (f.created === 0) {
    return `<figure class="viz-fig"><figcaption>
      <span class="viz-title">Rooms, step by step</span></figcaption>
      <p class="viz-empty">No rooms created since the counters started.</p>
      </figure>`;
  }
  const cats = ['Created', 'Both sides in', 'Started', 'First move', 'Finished',
    'Played again'];
  const values = [f.created, f.seated, f.started, f.firstMove, f.finished, f.rematch];
  const lost = f.created - f.started;

  return figure({
    title: 'Rooms, step by step',
    note: `${lost.toLocaleString()} of ${f.created.toLocaleString()} rooms never started a `
      + 'game. Counted live, so they begin at the deploy that added them rather than at '
      + 'the first game in the archive.',
    chart: barChart({
      cats,
      series: [{ name: 'Rooms', color: '--viz-1', values }],
      format: n => Math.round(n).toLocaleString(),
      catLabel: 'step',
      label: 'How many rooms reached each step, from created to a second game',
      rowHeight: 30,
    }),
  });
}

function dailyFigure(ins: Insights): string {
  const days = ins.daily.slice(-30);
  if (days.length === 0) return '';
  return figure({
    title: 'Games finished per day',
    note: 'Only days with play in them.',
    chart: columnChart({
      cats: days.map(d => d.day.slice(5)),
      series: [{ name: 'Games', color: '--viz-1', values: days.map(d => d.games) }],
      format: n => `${Math.round(n)}`,
      catLabel: 'day',
      label: 'Games finished per day',
      labelEvery: days.length > 12 ? 3 : 1,
      height: 170,
    }),
  });
}

/**
 * What the browsers reported.
 *
 * Kept in its own section with its own heading, because it is a different kind of
 * evidence from everything above it: the server measured the rest, and a client reported
 * this. It can be wrong, it can be missing, and it can be a lie -- so it says how many
 * plies it actually covers, and nothing on the page reads a rule from it.
 */
function clientFigures(m: ModeInsights): string {
  if (m.clientPlies === 0) {
    return `<figure class="viz-fig"><figcaption>
      <span class="viz-title">What the browser saw</span></figcaption>
      <p class="viz-empty">No client has reported yet. Games played before the channel
        existed carry none of this, and a client can always send nothing.</p></figure>`;
  }

  const devices = Object.entries(m.devices).sort((a, b) => b[1] - a[1]);
  const premoves = m.premovesPlayed + m.premovesRejected;

  return `${figure({
    title: 'What the browser saw',
    note: `Reported on ${m.clientPlies.toLocaleString()} of ${m.plies.toLocaleString()} `
      + 'plies. Advisory: a client can lie, so nothing rules on it.',
    stats: [
      { label: 'put back per turn', value: fmtNum(m.pickupsPerPly) },
      { label: 'card changes per turn', value: fmtNum(m.cardSelectionsPerPly) },
      { label: 'to first touch', value: fmtMs(m.firstTouch.p50) },
      { label: 'premoves played', value: String(m.premovesPlayed) },
      { label: 'premoves refused', value: premoves > 0
        ? `${Math.round((m.premovesRejected / premoves) * 100)}%` : '0%' },
      { label: 'reviews opened', value: String(m.reviewOpens) },
      { label: 'drawer opened', value: String(m.drawerOpens) },
    ],
    chart: columnChart({
      cats: bucketLabels(m.firstTouch.bounds, 'ms'),
      series: [{ name: 'Turns', color: '--viz-3', values: m.firstTouch.counts }],
      format: n => String(Math.round(n)),
      catLabel: 'time to first touch',
      label: 'How long after a turn opened the player first touched the board',
      height: 180,
    }),
  })}
  ${devices.length === 0 ? '' : figure({
    title: 'What it was played on',
    note: 'Turns, by the device class the browser reported when it played them.',
    chart: barChart({
      cats: devices.map(([k]) => k[0].toUpperCase() + k.slice(1)),
      series: [{ name: 'Turns', color: '--viz-2', values: devices.map(([, n]) => n) }],
      format: n => Math.round(n).toLocaleString(),
      catLabel: 'device',
      label: 'Turns played per device class',
    }),
  })}`;
}

function reasonsFigure(m: ModeInsights): string {
  const rows = Object.entries(m.reasons).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return '';
  return figure({
    title: 'How these games ended',
    chart: barChart({
      cats: rows.map(([k]) => k),
      series: [{ name: 'Games', color: '--viz-1', values: rows.map(([, n]) => n) }],
      format: n => Math.round(n).toLocaleString(),
      catLabel: 'ending',
      label: 'How games in this mode ended',
    }),
  });
}

/** The whole tab. `mode` is the mode the distributions under the guardrails are for. */
export function metricsTab(ins: Insights, mode: GameMode): string {
  const m = ins.modes.find(x => x.mode === mode) ?? ins.modes[0] ?? null;

  return `
    <section class="panel edge">
      <div class="panel-head"><span class="panel-title">Mode health</span>
        <span class="games-count">against the targets in docs/METRICS.md</span></div>
      <div class="adm-guardrails">${ins.guardrails.map(guardrailRow).join('')}</div>
    </section>

    ${!m ? `
    <section class="panel edge"><div class="games-empty">
      <div class="games-empty-mark">◔</div>
      <p>No measured games yet. Every game finished from here on is measured as it is
        played; anything older is in the archive without a per-ply record.</p>
    </div></section>` : `
    <section class="panel edge">
      <div class="panel-head"><span class="panel-title">By mode</span>
        ${ins.modes.length > 1 ? `<div class="adm-modes">${ins.modes.map(x =>
          `<button class="adm-mode${x.mode === m.mode ? ' on' : ''}"
            data-mode="${x.mode}">${escapeHtml(MODE_NAME[x.mode])}
            <i>${x.games}</i></button>`).join('')}</div>` : ''}
      </div>
      ${modeTiles(m)}
      <div class="adm-figs">
        ${distributionFigure('Think time', 'Turn open to move made, over every ply.',
          m.think)}
        ${distributionFigure('Wait between your turns',
          'Your previous turn ending to this one opening. In a team game this is what the '
          + 'rotation actually costs.', m.wait)}
        ${distributionFigure('Game length', 'Plies per game.', m.length)}
        ${phaseFigure(m)}
        ${m.mode === 'cards' ? cardKindsFigure(m) : ''}
        ${reasonsFigure(m)}
        ${clientFigures(m)}
      </div>
    </section>`}

    <section class="panel edge">
      <div class="panel-head"><span class="panel-title">Rooms and days</span></div>
      <div class="adm-figs">
        ${funnelFigure(ins)}
        ${dailyFigure(ins)}
      </div>
    </section>

    <section class="panel edge adm-foot">
      <span>${ins.gamesCovered.toLocaleString()} game(s) measured${
        ins.gamesUnmeasured > 0
          ? `, ${ins.gamesUnmeasured.toLocaleString()} archived before metrics existed`
          : ''}${ins.updatedAt > 0 ? ` · updated ${timeAgo(ins.updatedAt)}` : ''}</span>
      <button class="btn btn-sm" data-act="rebuild"
        title="Read every archived game again and recount. Safe, and slow.">
        Rebuild from archive</button>
    </section>`;
}
