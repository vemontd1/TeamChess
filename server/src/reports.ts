import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { BugReport, ReportAttachment, ReportContext } from './types.js';

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

/**
 * Screenshots.
 *
 * Bounded on every axis, because this is the one place an unauthenticated client can put
 * bytes on our disk. The client downscales before sending; these are the numbers the
 * server refuses past, not the ones it expects.
 */
export const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 3_000_000;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
};

function attachmentDir(reportId: string): string {
  return path.join(DIR, 'attachments', reportId);
}

const index: BugReport[] = [];
let ready = false;

/**
 * Screenshots belonging to a report that does not exist.
 *
 * They can only be left by a crash between the two writes that file a report -- which has
 * happened exactly once, to a deploy landing mid-submission -- but a folder of somebody's
 * screen with nothing to explain it is the last thing this store should hold on to. Swept
 * at startup, where the full list of reports is already in hand.
 */
function sweepOrphanAttachments(): void {
  const root = path.join(DIR, 'attachments');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch { return; }

  const known = new Set(index.map(r => r.id));
  for (const dir of dirs) {
    if (known.has(dir)) continue;
    try {
      fs.rmSync(path.join(root, dir), { recursive: true, force: true });
      console.log(`[reports] swept orphaned attachments for ${dir}`);
    } catch { /* a folder that will not go is not worth failing a start over */ }
  }
}

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
  sweepOrphanAttachments();
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

/**
 * Turn `data:image/png;base64,…` into bytes, or null.
 *
 * Everything is checked rather than trusted: the prefix, the declared type against an
 * allow-list, and the decoded size. A client can send anything, and this is the point
 * where "anything" stops.
 */
function decodeDataUrl(raw: unknown): { mime: string; buf: Buffer } | null {
  if (typeof raw !== 'string' || raw.length > MAX_ATTACHMENT_BYTES * 2) return null;
  const m = /^data:([a-z/+-]+);base64,(.+)$/i.exec(raw);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return null;
  try {
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) return null;
    return { mime, buf };
  } catch { return null; }
}

/**
 * A display name, and only ever a display name.
 *
 * The file on disk is named by its own hex id, so nothing the client sends reaches a path
 * -- which is the property that actually protects the directory. This tidies the label
 * anyway: separators become underscores and runs of dots collapse, so a name that was
 * trying to be a path does not go on reading like one in the panel.
 */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return 'screenshot';
  const base = raw
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .slice(0, 60);
  return base || 'screenshot';
}

function writeAttachments(reportId: string,
                          list: Array<{ name?: string; dataUrl?: string }>): ReportAttachment[] {
  const out: ReportAttachment[] = [];
  const dir = attachmentDir(reportId);
  let made = false;

  for (const item of list.slice(0, MAX_ATTACHMENTS)) {
    const decoded = decodeDataUrl(item?.dataUrl);
    if (!decoded) continue;
    // Made only once something has survived validation: a report whose attachments were
    // all rubbish should leave no trace on disk, not an empty directory nobody deletes.
    if (!made) {
      try { fs.mkdirSync(dir, { recursive: true }); made = true; }
      catch (err) {
        console.warn('[reports] no attachment dir:', (err as Error).message);
        return out;
      }
    }
    const id = randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(path.join(dir, `${id}.${EXT[decoded.mime]}`), decoded.buf);
      out.push({
        id,
        name: cleanName(item?.name),
        mime: decoded.mime,
        bytes: decoded.buf.length,
      });
    } catch (err) {
      console.warn('[reports] attachment write failed:', (err as Error).message);
    }
  }
  return out;
}

/** The bytes of one attachment, for an admin that has already been checked. */
export function readAttachment(reportId: string, attachmentId: string):
    { mime: string; base64: string } | null {
  if (!ready) initReports();
  // both ids go into a path, so both are matched against a shape rather than sanitised
  if (!/^[a-z0-9-]{8,64}$/i.test(reportId)) return null;
  if (!/^[a-f0-9]{12}$/.test(attachmentId)) return null;

  const report = index.find(r => r.id === reportId);
  const meta = report?.attachments?.find(a => a.id === attachmentId);
  if (!meta) return null;

  try {
    const file = path.join(attachmentDir(reportId), `${attachmentId}.${EXT[meta.mime]}`);
    return { mime: meta.mime, base64: fs.readFileSync(file).toString('base64') };
  } catch {
    return null;   // resolved, and the bytes are already gone
  }
}

/**
 * Delete a report's screenshots and forget they existed.
 *
 * Called when a report is resolved. A screenshot is evidence for a bug; once the bug is
 * fixed it is a picture of somebody's screen that we have no further reason to keep, and
 * keeping it is a decision nobody made.
 */
export function dropAttachments(report: BugReport): void {
  if (!report.attachments?.length) return;
  const dir = attachmentDir(report.id);
  for (const a of report.attachments) {
    try { fs.unlinkSync(path.join(dir, `${a.id}.${EXT[a.mime]}`)); } catch { /* already gone */ }
  }
  try { fs.rmdirSync(dir); } catch { /* not empty, or never existed */ }
  report.attachments = [];
}

export interface FileReportInput {
  text: unknown;
  context: unknown;
  attachments: unknown;
  accountId: string | null;
  reporter: string;
}

export function fileReport(input: FileReportInput): BugReport | null {
  if (!ready) initReports();
  const text = cleanText(input.text);
  if (!text) return null;

  const id = `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
  const report: BugReport = {
    id,
    at: Date.now(),
    text,
    reporter: input.reporter.slice(0, 24),
    accountId: input.accountId,
    context: cleanContext(input.context),
    attachments: [],
    resolved: false,
  };

  /*
   * The sentence lands first, the pictures after.
   *
   * It used to be the other way round -- attachments written into the report object, then
   * the whole thing saved -- and one report was lost to the gap: the images reached the
   * volume, the container was replaced mid-deploy, and the file that carried the text was
   * never written. What was left was a folder of screenshots belonging to a report nobody
   * could read.
   *
   * Written in this order, the worst a crash can now cost is the pictures on a report
   * that still says what was wrong, which is the half worth keeping.
   */
  if (!write(report)) return null;

  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    report.attachments = writeAttachments(
      id, input.attachments as Array<{ name?: string; dataUrl?: string }>);
    // A failure here leaves the report as it was saved a moment ago: text, no images.
    if (report.attachments.length > 0 && !write(report)) dropAttachments(report);
  }

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
  // Resolving throws the screenshots away. Reopening cannot bring them back, which is
  // worth knowing before pressing it -- the panel says so.
  if (resolved) dropAttachments(r);
  write(r);
  return r;
}

export function openCount(): number {
  if (!ready) initReports();
  return index.filter(r => !r.resolved).length;
}
