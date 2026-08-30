import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchivedGame, GameSummary, HistoryEntry, RoomConfig } from './types.js';

/**
 * The game archive: finished games written to disk as JSON, one file per game.
 *
 * A room is a live object that disappears the moment the last player leaves, so anything
 * worth keeping has to be copied out before that happens. What is kept is the whole game
 * -- every ply with the position it produced -- which is what makes a game reviewable
 * later without replaying it through a move generator.
 *
 * Storage is a directory, chosen by `GAMES_DIR`, defaulting to `data/games` beside the
 * repository. That is deliberately the dullest thing that works: no database to run
 * locally, and the files are readable and copyable on their own.
 *
 * On a host with an ephemeral filesystem -- a plain container, including Railway without
 * a volume attached -- the archive survives restarts but not redeploys. Point `GAMES_DIR`
 * at a mounted volume to make it durable.
 */

/**
 * Anchored to the repository rather than to the working directory. `npm start` runs the
 * server with its cwd inside `server/`, while `tsx server/src/index.ts` runs it from the
 * root -- a cwd-relative default therefore meant two different stores depending on how
 * the server happened to be launched, and a game written by one was invisible to the other.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.GAMES_DIR
  ?? path.resolve(HERE, '..', '..', 'data', 'games');

/** Newest-first summaries, held in memory so listing never touches the disk. */
const index: GameSummary[] = [];
const MAX_INDEX = 500;

let ready = false;

function ensureDir(): boolean {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn(`[archive] cannot use ${DIR}:`, (err as Error).message);
    return false;
  }
}

function summarise(game: ArchivedGame): GameSummary {
  return {
    id: game.id,
    roomId: game.roomId,
    mode: game.config.mode,
    finishedAt: game.finishedAt,
    plies: game.history.length,
    white: game.white,
    black: game.black,
    result: game.result,
    reason: game.reason,
  };
}

/**
 * Read what is already on disk once, at startup.
 *
 * Files are parsed rather than trusted: an archive that has been hand-edited, truncated by
 * a kill mid-write, or written by an older version should cost one skipped game, not the
 * whole listing.
 */
export function initArchive(): void {
  if (ready) return;
  ready = true;
  if (!ensureDir()) return;
  let names: string[];
  try {
    names = fs.readdirSync(DIR).filter(n => n.endsWith('.json'));
  } catch { return; }

  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(DIR, name), 'utf8');
      const game = JSON.parse(raw) as ArchivedGame;
      if (game?.id && Array.isArray(game.history)) index.push(summarise(game));
    } catch {
      console.warn(`[archive] skipping unreadable ${name}`);
    }
  }
  index.sort((a, b) => b.finishedAt - a.finishedAt);
  if (index.length > MAX_INDEX) index.length = MAX_INDEX;
  console.log(`[archive] ${index.length} game(s) in ${DIR}`);
}

/** Ids are opaque and URL-safe; the room id alone would collide across rematches. */
function makeId(roomId: string, at: number): string {
  return `${new Date(at).toISOString().slice(0, 10)}-${roomId}-`
    + Math.random().toString(36).slice(2, 8);
}

export interface SaveInput {
  roomId: string;
  config: RoomConfig;
  white: string[];
  black: string[];
  history: HistoryEntry[];
  startFen: string;
  finalFen: string;
  result: 'white' | 'black' | 'draw' | 'unfinished';
  reason: string;
}

/**
 * Write one game out. Returns the summary, or null if it was not worth keeping or could
 * not be stored -- a failed archive write must never take a game down with it, so every
 * path here is caught and reported rather than thrown.
 */
export function saveGame(input: SaveInput): GameSummary | null {
  if (input.history.length === 0) return null;   // nothing happened; nothing to review
  if (!ready) initArchive();

  const finishedAt = Date.now();
  const game: ArchivedGame = { id: makeId(input.roomId, finishedAt), finishedAt, ...input };

  try {
    if (!ensureDir()) return null;
    // written to a temporary name and renamed, so a crash mid-write cannot leave a
    // half-parsed file in the directory the index reads at startup
    const target = path.join(DIR, `${game.id}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(game), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn('[archive] save failed:', (err as Error).message);
    return null;
  }

  const summary = summarise(game);
  index.unshift(summary);
  if (index.length > MAX_INDEX) index.length = MAX_INDEX;
  return summary;
}

export function listGames(limit = 40): GameSummary[] {
  if (!ready) initArchive();
  return index.slice(0, Math.min(Math.max(1, limit), MAX_INDEX));
}

export function loadGame(id: string): ArchivedGame | null {
  if (!ready) initArchive();
  // the id goes into a filename, so it is matched against a strict shape rather than
  // sanitised -- anything with a slash or a dot in it is simply not an id
  if (!/^[a-z0-9-]{8,64}$/i.test(id)) return null;
  try {
    const raw = fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw) as ArchivedGame;
  } catch {
    return null;
  }
}

/**
 * Standard PGN, so a game can leave this app entirely and open in anything that reads
 * chess. The card mode's extras have no PGN representation, so the ones that change how a
 * move came about -- the clock playing it, a bot playing it -- are written as comments
 * rather than dropped.
 */
export function toPgn(game: ArchivedGame): string {
  const date = new Date(game.finishedAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const result = game.result === 'white' ? '1-0'
    : game.result === 'black' ? '0-1'
    : game.result === 'draw' ? '1/2-1/2' : '*';

  const tags: Array<[string, string]> = [
    ['Event', game.config.mode === 'cards' ? 'Chess Cards' : 'Team Chess'],
    ['Site', 'Bolotnoye Logovo'],
    ['Date', `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`],
    ['Round', '-'],
    ['White', game.white.join(', ') || '?'],
    ['Black', game.black.join(', ') || '?'],
    ['Result', result],
    ['Termination', game.reason || 'unterminated'],
  ];

  const body: string[] = [];
  for (let i = 0; i < game.history.length; i += 2) {
    const w = game.history[i];
    const b = game.history[i + 1];
    const note = (e: HistoryEntry | undefined): string =>
      !e ? '' : e.auto ? ' {clock}' : e.bot ? ' {bot}' : '';
    body.push(`${i / 2 + 1}. ${w.san}${note(w)}${b ? ` ${b.san}${note(b)}` : ''}`);
  }

  // PGN movetext wants lines under 80 columns
  const wrapped: string[] = [];
  let line = '';
  for (const token of [...body, result]) {
    if (line.length + token.length + 1 > 79) { wrapped.push(line); line = ''; }
    line += (line ? ' ' : '') + token;
  }
  if (line) wrapped.push(line);

  return `${tags.map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`).join('\n')}\n\n`
    + `${wrapped.join('\n')}\n`;
}

/** Exposed for the tests, and for anyone wondering where the files went. */
export function archiveDir(): string {
  return DIR;
}
