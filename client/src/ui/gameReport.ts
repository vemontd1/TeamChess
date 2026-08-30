import { escapeHtml } from '../util/format';
import {
  barChart, figure, fmtMs, fmtNum, fmtPct, lineChart, type Series,
} from './charts';
import type { ArchivedGame, Color, GameMetrics, HistoryEntry, SideMetrics } from '../types';

/**
 * Your game, measured.
 *
 * Everything here was recorded while the game was played and none of it could have been
 * reconstructed afterwards -- which is the whole argument for instrumenting a ply at the
 * moment it happens rather than counting results at the end.
 *
 * Two rules about tone, because a report about someone's own play is not a dashboard:
 *
 * - **It compares, it does not grade.** Your numbers against your opponent's, on the same
 *   axis. There is no score, no letter, and no advice about what you should have played.
 * - **It says what it does not know.** The hanging check looks one ply ahead and does not
 *   search the recapture, so a piece that was traded reads as a piece that was left. That
 *   caveat is printed next to the number rather than buried in a doc, because a player who
 *   reads "you hung 4 pieces" and cannot see why will not trust the next number either.
 *
 * A pure string renderer with no DOM behind it, so the same function draws into the review
 * modal and into the preview harness.
 */

const KIND_ORDER = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'wild'];

function sideName(game: ArchivedGame, color: Color): string {
  const names = color === 'white' ? game.white : game.black;
  return names.join(', ') || (color === 'white' ? 'White' : 'Black');
}

/** A row of the comparison table: one measurement, both sides. */
interface Row {
  label: string;
  you: string;
  them: string;
  /** Which side the number favours, when that is a meaningful thing to say. */
  better?: 'you' | 'them' | null;
  note?: string;
}

function lower(a: number, b: number): 'you' | 'them' | null {
  if (a === b) return null;
  return a < b ? 'you' : 'them';
}

function higher(a: number, b: number): 'you' | 'them' | null {
  if (a === b) return null;
  return a > b ? 'you' : 'them';
}

function rowsFor(mine: SideMetrics, theirs: SideMetrics, cards: boolean): Row[] {
  const rows: Row[] = [
    { label: 'Moves', you: String(mine.moves), them: String(theirs.moves) },
    {
      label: 'Think time, typical', you: fmtMs(mine.thinkMsMean),
      them: fmtMs(theirs.thinkMsMean),
    },
    {
      label: 'Think time, slowest tenth', you: fmtMs(mine.thinkMsP90),
      them: fmtMs(theirs.thinkMsP90),
      note: 'Your p90: nine turns in ten were faster than this.',
    },
    {
      label: 'Waiting to move', you: fmtMs(mine.waitMsMean),
      them: fmtMs(theirs.waitMsMean),
      better: lower(mine.waitMsMean, theirs.waitMsMean),
      note: 'Your previous turn ending to your next one opening.',
    },
    { label: 'Captures', you: String(mine.captures), them: String(theirs.captures),
      better: higher(mine.captures, theirs.captures) },
    { label: 'Checks given', you: String(mine.checksGiven),
      them: String(theirs.checksGiven) },
    {
      label: 'Pieces left hanging', you: String(mine.hangs), them: String(theirs.hangs),
      better: lower(mine.hangs, theirs.hangs),
      note: 'One ply deep and no recapture searched, so a trade can read as a piece left.',
    },
    {
      label: 'Material left on the table', you: fmtNum(mine.missedTotal, 1),
      them: fmtNum(theirs.missedTotal, 1),
      better: lower(mine.missedTotal, theirs.missedTotal),
      note: 'The best capture you could afford, minus what you took, added up over the game.',
    },
    {
      label: 'Moves the clock played', you: String(mine.autoMoves),
      them: String(theirs.autoMoves), better: lower(mine.autoMoves, theirs.autoMoves),
    },
  ];

  if (cards) {
    rows.push(
      {
        label: 'Legal moves your hand could pay for',
        you: fmtPct(mine.affordableRatioMean, 0),
        them: fmtPct(theirs.affordableRatioMean, 0),
        better: higher(mine.affordableRatioMean, theirs.affordableRatioMean),
      },
      {
        label: 'Turns the cards did not constrain', you: String(mine.openTurns),
        them: String(theirs.openTurns),
      },
      {
        label: 'Turns with one move only', you: String(mine.forcedTurns),
        them: String(theirs.forcedTurns), better: lower(mine.forcedTurns, theirs.forcedTurns),
      },
      { label: 'Cards spent', you: String(mine.cardsSpent), them: String(theirs.cardsSpent) },
      {
        label: 'Emergencies', you: String(mine.emergencies), them: String(theirs.emergencies),
        better: lower(mine.emergencies, theirs.emergencies),
        note: 'Turns where no card in hand could move anything.',
      },
      { label: 'Sacrifices', you: String(mine.sacrifices), them: String(theirs.sacrifices) },
    );
  }
  return rows;
}

function comparison(rows: Row[], youName: string, themName: string): string {
  return `<table class="rep-table">
    <thead><tr><th></th>
      <th>${escapeHtml(youName)}</th><th>${escapeHtml(themName)}</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <th>${escapeHtml(r.label)}${r.note
        ? `<span class="rep-note">${escapeHtml(r.note)}</span>` : ''}</th>
      <td class="${r.better === 'you' ? 'rep-better' : ''}">${escapeHtml(r.you)}</td>
      <td class="${r.better === 'them' ? 'rep-better' : ''}">${escapeHtml(r.them)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

/**
 * The material graph, from your side of the board.
 *
 * Stored from White's point of view, so Black's copy is negated: a report that told a
 * Black player they were four pawns down when they were four up would be worse than no
 * graph at all.
 */
function materialFigure(m: GameMetrics, you: Color): string {
  const values = m.plies.map(p => (you === 'white' ? p.materialAfter : -p.materialAfter));
  if (values.length === 0) return '';
  return figure({
    title: 'Material, your side of it',
    note: 'Above the line is ahead. Kings are not counted, and neither is position -- this '
      + 'is the pieces on the board, nothing else.',
    chart: lineChart({
      cats: m.plies.map(p => String(Math.ceil(p.ply / 2))),
      series: [{ name: 'Material', color: '--viz-1', values }],
      format: n => (n > 0 ? `+${fmtNum(n, 1)}` : fmtNum(n, 1)),
      catLabel: 'move',
      label: 'Material balance from your side, over the game',
      labelEvery: Math.max(1, Math.ceil(values.length / 12)),
      zeroed: true,
      height: 200,
    }),
  });
}

/** What you held against what you spent, by kind. Counts, not shares: it is one game. */
function cardsFigure(mine: SideMetrics): string {
  const kinds = [...new Set([...Object.keys(mine.drawnKinds), ...Object.keys(mine.spentKinds)])]
    .sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  if (kinds.length === 0) return '';

  const series: Series[] = [
    { name: 'Held, summed over turns', color: '--viz-1',
      values: kinds.map(k => mine.drawnKinds[k] ?? 0) },
    { name: 'Spent', color: '--viz-2', values: kinds.map(k => mine.spentKinds[k] ?? 0) },
  ];
  return figure({
    title: 'Your cards',
    note: 'Held is counted every turn you were holding it, so a card you sat on all game '
      + 'shows large. The gap between the two is what the deck gave you and you could not use.',
    series,
    chart: barChart({
      cats: kinds.map(k => k[0].toUpperCase() + k.slice(1)),
      series,
      format: n => String(Math.round(n)),
      catLabel: 'kind',
      label: 'Cards held and cards spent, by kind',
    }),
  });
}

/**
 * The moves where material was left hanging.
 *
 * Capped at eight, newest first, because a list of thirty is not a report -- it is the
 * game again, and the player has that already.
 */
function hangList(m: GameMetrics, history: HistoryEntry[], you: Color): string {
  const hung = m.plies.filter(p => p.color === you && p.hung)
    .sort((a, b) => b.hungValue - a.hungValue)
    .slice(0, 8);
  if (hung.length === 0) {
    return `<p class="rep-empty">Nothing of yours was left where it could simply be
      taken. That is rarer than it sounds.</p>`;
  }
  return `<ol class="rep-hangs">${hung.map(p => {
    const san = history.find(h => h.ply === p.ply)?.san ?? '';
    return `<li><b>${Math.ceil(p.ply / 2)}${p.color === 'white' ? '.' : '…'}
      ${escapeHtml(san)}</b>
      <span>left ${fmtNum(p.hungValue, 1)} hanging</span></li>`;
  }).join('')}</ol>
  <p class="rep-caveat">Read as a rate, not a verdict: this looks one ply ahead and does
    not search the recapture, so a piece you meant to trade appears here too.</p>`;
}

/** What the browser reported about your own turns, when it reported anything. */
function clientLine(m: GameMetrics, you: Color): string {
  const c = m.client?.[you];
  if (!c || c.plies === 0) return '';
  const bits: string[] = [];
  if (c.pickups > 0) {
    bits.push(`picked a piece up and put it back <b>${c.pickups}</b> time${
      c.pickups === 1 ? '' : 's'}`);
  }
  if (c.cardSelections > 0) {
    bits.push(`changed your mind about a card <b>${c.cardSelections}</b> time${
      c.cardSelections === 1 ? '' : 's'}`);
  }
  if (c.firstTouchMs > 0) {
    bits.push(`took <b>${fmtMs(c.firstTouchMs)}</b> to touch the board once a turn opened`);
  }
  if (c.premovesPlayed > 0) bits.push(`played <b>${c.premovesPlayed}</b> queued move(s)`);
  if (c.premovesRejected > 0) {
    bits.push(`had <b>${c.premovesRejected}</b> refused as no longer playable`);
  }
  if (bits.length === 0) return '';
  return `<p class="rep-client">Over ${c.plies} of your turns, you ${bits.join(', ')}.</p>`;
}

function resultLine(game: ArchivedGame, you: Color): string {
  if (game.result === 'unfinished') return 'Unfinished';
  if (game.result === 'draw') return 'Drawn';
  return game.result === you ? 'You won' : 'You lost';
}

/**
 * The report. `you` is the side it is written for; a spectator gets White's view, which is
 * the same numbers with the labels the right way round.
 */
export function reportHtml(game: ArchivedGame, you: Color | null): string {
  const side: Color = you ?? 'white';
  const other: Color = side === 'white' ? 'black' : 'white';
  const m = game.metrics;

  if (!m || m.plies.length === 0) {
    return `<div class="report"><p class="rep-empty">This game was played before the app
      measured them, so there is nothing to report on. Every game from now on carries its
      own record.</p></div>`;
  }

  const mine = m[side];
  const theirs = m[other];
  const cards = game.config.mode === 'cards';

  return `<div class="report">
    <header class="rep-head">
      <div>
        <div class="rep-result">${escapeHtml(resultLine(game, side))}
          <span class="rep-reason">${escapeHtml(game.reason)}</span></div>
        <div class="rep-sub">${escapeHtml(sideName(game, side))} against
          ${escapeHtml(sideName(game, other))} ·
          ${cards ? 'Chess Cards' : 'Team Chess'} ·
          ${m.plies.length} plies in ${fmtMs(m.durationMs)} at the board</div>
      </div>
    </header>

    <div class="rep-tiles">
      <div><b>${fmtMs(mine.thinkMsMean)}</b><span>your typical think</span></div>
      <div><b>${cards ? fmtPct(mine.affordableRatioMean, 0) : fmtMs(mine.waitMsMean)}</b>
        <span>${cards ? 'of legal moves affordable' : 'typical wait to move'}</span></div>
      <div><b>${mine.captures}</b><span>captures</span></div>
      <div><b>${mine.hangs}</b><span>pieces left hanging</span></div>
      ${m.comeback ? '<div><b>↩</b><span>the winner was behind</span></div>'
        : `<div><b>${m.leadChanges}</b><span>lead changes</span></div>`}
    </div>

    ${clientLine(m, side)}

    <div class="rep-figs">
      ${materialFigure(m, side)}
      ${cards ? cardsFigure(mine) : ''}
    </div>

    <section class="rep-section">
      <h3>Side by side</h3>
      ${comparison(rowsFor(mine, theirs, cards), 'You', sideName(game, other))}
    </section>

    <section class="rep-section">
      <h3>Where material went</h3>
      ${hangList(m, game.history, side)}
    </section>
  </div>`;
}
