import { escapeHtml } from '../util/format';

/**
 * A year of play, one square per day — the shape GitHub uses for commits.
 *
 * It answers a question the tally cannot: not how many games, but *when*. A row of
 * results says you have played eleven games; this says you played nine of them in one
 * evening in March and have not been back since, which is the more interesting fact.
 *
 * Weeks are columns and days are rows, aligned so the grid always ends on today's column.
 *
 * **The day is decided here, not on the server.** The server has no idea what clock the
 * person reading this grid is on, and a game finished at 01:24 UTC was played at half
 * nine the previous evening in New York. Counting days server-side therefore lit a square
 * its player had not played on and left the one they had dark -- reported, correctly, as
 * "matches are not shown for the current date". So the server sends the moments and the
 * browser, which knows the timezone, sorts them into days.
 */

const DAY_MS = 86_400_000;
const WEEKS = 53;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function key(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Five steps, because more than that is a gradient nobody can read back to a number. */
function levelOf(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

export interface ActivitySummary {
  total: number;
  activeDays: number;
  busiest: { day: string; count: number } | null;
  /** Consecutive days up to and including today (or yesterday, if today is still empty). */
  streak: number;
}

/** Timestamps to a local-date tally: the one place a day is decided. */
export function bucketByDay(playedAt: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const at of playedAt) {
    if (!Number.isFinite(at)) continue;
    const k = key(new Date(at));
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function summarise(playedAt: number[]): ActivitySummary {
  const activity = bucketByDay(playedAt);
  const entries = Object.entries(activity).filter(([, n]) => n > 0);
  let total = 0;
  let busiest: ActivitySummary['busiest'] = null;
  for (const [day, n] of entries) {
    total += n;
    if (!busiest || n > busiest.count) busiest = { day, count: n };
  }

  // A streak that has to include today would read as broken every morning, so it is
  // allowed to end yesterday -- the day is not over yet.
  let streak = 0;
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  if (!activity[key(start)]) start.setTime(start.getTime() - DAY_MS);
  for (let d = new Date(start); activity[key(d)]; d.setTime(d.getTime() - DAY_MS)) streak++;

  return { total, activeDays: entries.length, busiest, streak };
}

export function renderActivityGrid(playedAt: number[]): string {
  const activity = bucketByDay(playedAt);
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  // End on the Saturday of this week so the final column is complete, then walk back a
  // whole number of weeks: the grid keeps its shape whatever day it is read on.
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const start = new Date(end);
  start.setDate(start.getDate() - (WEEKS * 7 - 1));

  const cells: string[] = [];
  const monthLabels: string[] = [];
  let lastMonth = -1;

  for (let w = 0; w < WEEKS; w++) {
    // A month is labelled on the first column that contains its first week, which is how
    // the labels stay one-per-month instead of repeating down a long month.
    const first = new Date(start);
    first.setDate(first.getDate() + w * 7);
    if (first.getMonth() !== lastMonth && first.getDate() <= 7) {
      lastMonth = first.getMonth();
      monthLabels.push(
        `<span class="act-month" style="--col:${w + 1}">${MONTHS[lastMonth]}</span>`);
    }

    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(day.getDate() + w * 7 + d);
      if (day > today) {
        cells.push(`<span class="act-cell act-future"></span>`);
        continue;
      }
      const k = key(day);
      const n = activity[k] ?? 0;
      const label = `${n === 0 ? 'No games' : n === 1 ? '1 game' : `${n} games`} on `
        + `${MONTHS[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`;
      cells.push(`<span class="act-cell act-l${levelOf(n)}"
        title="${escapeHtml(label)}"></span>`);
    }
  }

  return `
    <div class="act-wrap" style="--weeks:${WEEKS}">
      <div class="act-scroll">
        <div class="act-months">${monthLabels.join('')}</div>
        <div class="act-body">
          <div class="act-days">
            <span>Mon</span><span>Wed</span><span>Fri</span>
          </div>
          <div class="act-grid" style="--weeks:${WEEKS}">${cells.join('')}</div>
        </div>
      </div>
      <div class="act-legend">
        <span>Less</span>
        <span class="act-cell act-l0"></span>
        <span class="act-cell act-l1"></span>
        <span class="act-cell act-l2"></span>
        <span class="act-cell act-l3"></span>
        <span class="act-cell act-l4"></span>
        <span>More</span>
      </div>
    </div>`;
}
