import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { BugReport, ReportContext } from './types.js';

/**
 * Bug reports, filed from inside the running app.
 *
 * The reason this exists is that the alternative is a person remembering. A problem seen
 * mid-game is described accurately for about thirty seconds and then becomes "something
 * was wrong with the cards"; a report filed from the room it happened in carries the room,
 * the game, the mode, the position and the browser along with the sentence.
 *
 * Storage is the same dull shape as the archive: one JSON file per report under
 * `REPORTS_DIR`, defaulting to `data/reports`, with an in-memory index so listing never
 * touches the disk.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.REPORTS_DIR
  ?? path.resolve(HERE, '..', '..', 'data', 'reports');

const MAX_INDEX = 1000;
export const MAX_REPORT_CHARS = 2000;

const index: BugReport[] = [];
let ready = false;

function ensureDir(): boolean {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn(`[reports] cannot use ${DIR}:`, (err as Error).message);
    return false;
  }
}

export function initReports(): void {
  if (ready) return;
  ready = true;
  if (!ensureDir()) return;
  let names: string[];
  try {
    names = fs.readdirSync(DIR).filter(n => n.endsWith('.json'));
  } catch { return; }

  for (const name of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as BugReport;
      if (r?.id && typeof r.text === 'string') index.push(r);
    } catch {
      console.warn(`[reports] skipping unreadable ${name}`);
    }
  }
  index.sort((a, b) => b.at - a.at);
  if (index.length > MAX_INDEX) index.length = MAX_INDEX;
  console.log(`[reports] ${index.length} report(s) in ${DIR}`);
}

function write(r: BugReport): boolean {
  try {
    if (!ensureDir()) return false;
    const target = path.join(DIR, `${r.id}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.warn('[reports] save failed:', (err as Error).message);
    return false;
  }
}

/** Strip control characters and clamp; the client is never trusted for either. */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = Array.from(raw)
    .map(ch => (ch.charCodeAt(0) < 0x20 && ch !== '\n' ? ' ' : ch))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, MAX_REPORT_CHARS) : null;
}

/** Only the fields we asked for, each clamped -- context arrives from the client. */
function cleanContext(raw: unknown): ReportContext {
  const c = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    route: str(c.route, 120),
    roomId: str(c.roomId, 16),
    mode: c.mode === 'cards' || c.mode === 'team' ? c.mode : null,
    gameSeq: num(c.gameSeq),
    status: str(c.status, 16),
    fen: str(c.fen, 100),
    plies: num(c.plies),
    userAgent: str(c.userAgent, 300),
    viewport: str(c.viewport, 24),
  };
}

export interface FileReportInput {
  text: unknown;
  context: unknown;
  accountId: string | null;
  reporter: string;
}

export function fileReport(input: FileReportInput): BugReport | null {
  if (!ready) initReports();
  const text = cleanText(input.text);
  if (!text) return null;

  const report: BugReport = {
    id: `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`,
    at: Date.now(),
    text,
    reporter: input.reporter.slice(0, 24),
    accountId: input.accountId,
    context: cleanContext(input.context),
    resolved: false,
  };

  if (!write(report)) return null;
  index.unshift(report);
  if (index.length > MAX_INDEX) index.length = MAX_INDEX;
  return report;
}

export function listReports(limit = 100): BugReport[] {
  if (!ready) initReports();
  return index.slice(0, Math.min(Math.max(1, limit), MAX_INDEX));
}

/** Mark one report done, or put it back. Returns the report, or null if there is no such. */
export function setResolved(id: string, resolved: boolean): BugReport | null {
  if (!ready) initReports();
  const r = index.find(x => x.id === id);
  if (!r) return null;
  r.resolved = resolved;
  r.resolvedAt = resolved ? Date.now() : undefined;
  write(r);
  return r;
}

export function openCount(): number {
  if (!ready) initReports();
  return index.filter(r => !r.resolved).length;
}
