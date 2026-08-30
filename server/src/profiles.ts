import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Color, GameSummary, Profile, ProfileGame, ProfileView, SideMetrics,
} from './types.js';

/**
 * Player profiles: a name, a tally, and the games behind it.
 *
 * A profile belongs to an account and is keyed by the account's id, which is why
 * registration exists at all. Keying it on the browser token instead -- as this did --
 * meant a record that could not survive clearing the browser and could not follow a
 * player to a second device, because that token is storage, not an identity.
 *
 * Guests are simply not recorded. There is nothing to record them against, and inventing
 * a per-browser identity to hang it on is exactly the thing that did not work.
 *
 * Storage matches `archive.ts` -- one JSON file per profile under `PROFILES_DIR`,
 * defaulting to `data/profiles`. Each file carries the player's own game list rather than
 * pointers into the archive, so listing a profile never opens another file, and a game
 * pruned out of the archive still shows in the record it belongs to.
 */

/**
 * Anchored to the repository rather than to the working directory. `npm start` runs the
 * server with its cwd inside `server/`, while `tsx server/src/index.ts` runs it from the
 * root -- a cwd-relative default therefore meant two different stores depending on how
 * the server happened to be launched, and a game written by one was invisible to the other.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.PROFILES_DIR
  ?? path.resolve(HERE, '..', '..', 'data', 'profiles');

/** Games kept per profile. Older ones fall off the list; the tally still counts them. */
const MAX_GAMES = 100;

interface StoredProfile {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  record: { wins: number; losses: number; draws: number };
  /** Newest first. */
  games: ProfileGame[];
  /** Games finished per day, `YYYY-MM-DD` -> count. Feeds the activity grid. */
  days?: Record<string, number>;
}

/** Days kept in the activity map: a little over a year, which is what the grid shows. */
const MAX_DAYS = 400;

/** Local-date key. The grid is read by a person in their own timezone, not in UTC. */
function dayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Drop days that have fallen off the far end of the grid, so the file cannot grow forever. */
function pruneDays(days: Record<string, number>): Record<string, number> {
  const keys = Object.keys(days).sort();
  if (keys.length <= MAX_DAYS) return days;
  const keep = new Set(keys.slice(-MAX_DAYS));
  const out: Record<string, number> = {};
  for (const k of keys) if (keep.has(k)) out[k] = days[k];
  return out;
}

const cache = new Map<string, StoredProfile>();
let ready = false;

function ensureDir(): boolean {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn(`[profiles] cannot use ${DIR}:`, (err as Error).message);
    return false;
  }
}

export function initProfiles(): void {
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
      const p = JSON.parse(raw) as StoredProfile;
      // parsed rather than trusted, for the same reason the archive is: one bad file
      // should cost one profile, not the whole store
      if (p?.id && Array.isArray(p.games) && p.record) {
        cache.set(p.id, backfillDays(p));
      }
    } catch {
      console.warn(`[profiles] skipping unreadable ${name}`);
    }
  }
  console.log(`[profiles] ${cache.size} profile(s) in ${DIR}`);
}

/**
 * Give an older profile the per-day counts it was saved without.
 *
 * The activity grid is fed by `days`, which is counted as games are recorded. Profiles
 * written before that field existed have none, so their grid came up empty despite a list
 * of games sitting right underneath it. The games carry `finishedAt`, so the counts can
 * be rebuilt from them -- capped at whatever the list still holds, which is the best that
 * can be known and a great deal better than nothing.
 */
function backfillDays(p: StoredProfile): StoredProfile {
  if (p.days && Object.keys(p.days).length > 0) return p;
  const days: Record<string, number> = {};
  for (const g of p.games) {
    if (typeof g?.finishedAt !== 'number') continue;
    const k = dayKey(g.finishedAt);
    days[k] = (days[k] ?? 0) + 1;
  }
  p.days = days;
  return p;
}

function save(p: StoredProfile): void {
  try {
    if (!ensureDir()) return;
    const target = path.join(DIR, `${p.id}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn('[profiles] save failed:', (err as Error).message);
  }
}

function load(id: string): StoredProfile | null {
  if (!ready) initProfiles();
  return cache.get(id) ?? null;
}

/**
 * Create or refresh the profile behind an account, and return it.
 *
 * Called whenever a signed-in player joins a room, which is what keeps the display name
 * current if the account is ever renamed. Games already recorded keep the name they were
 * played under.
 */
export function touchProfile(id: string, name: string): Profile {
  if (!ready) initProfiles();
  const now = Date.now();
  let p = cache.get(id);
  if (!p) {
    p = {
      id, name, createdAt: now, lastSeenAt: now,
      record: { wins: 0, losses: 0, draws: 0 }, games: [], days: {},
    };
    cache.set(id, p);
  }
  const renamed = name && name !== p.name;
  p.name = name || p.name;
  p.lastSeenAt = now;
  // A join is frequent and a rename is not, so only the interesting one hits the disk;
  // the timestamp catches up whenever something else does write.
  if (renamed || p.games.length === 0) save(p);
  return publicOf(p);
}

function publicOf(p: StoredProfile): Profile {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    lastSeenAt: p.lastSeenAt,
    games: p.record.wins + p.record.losses + p.record.draws,
    record: { ...p.record },
  };
}

/**
 * Record a finished game against one player's profile, from their side of the board.
 *
 * `metrics` is that side's roll-up, and is optional for the reason everything about
 * metrics is optional: a game that was not measured is still a game that was played.
 */
export function recordGame(
  id: string, name: string, summary: GameSummary, color: Color, metrics?: SideMetrics,
): void {
  if (!ready) initProfiles();
  let p = cache.get(id);
  if (!p) {
    touchProfile(id, name);
    p = cache.get(id)!;
  }

  // An unfinished game -- the room emptied mid-play -- is kept in the list but scores
  // nothing: it is a game the player can review, not a result they earned.
  const yourResult: ProfileGame['yourResult'] = summary.result === 'draw' ? 'draw'
    : summary.result === color ? 'win'
    : summary.result === 'unfinished' ? 'draw' : 'loss';

  if (summary.result !== 'unfinished') {
    if (yourResult === 'win') p.record.wins++;
    else if (yourResult === 'loss') p.record.losses++;
    else p.record.draws++;
  }

  const entry: ProfileGame = {
    ...summary,
    yourColor: color,
    yourResult,
    opponents: color === 'white' ? summary.black : summary.white,
    you: metrics,
  };
  p.games.unshift(entry);
  if (p.games.length > MAX_GAMES) p.games.length = MAX_GAMES;

  // Counted here rather than derived from `games` on read: the list is capped, and a year
  // of play would otherwise show a grid that quietly emptied from the left as old games
  // fell off it.
  const days = p.days ?? {};
  const key = dayKey(summary.finishedAt);
  days[key] = (days[key] ?? 0) + 1;
  p.days = pruneDays(days);

  p.lastSeenAt = Date.now();
  save(p);
}

/** How many profiles exist, for the admin overview. */
export function profileCount(): number {
  if (!ready) initProfiles();
  return cache.size;
}

export function profileView(id: string, limit = 25): ProfileView | null {
  // the id goes into a filename, so it is matched against a strict shape rather than
  // sanitised -- anything that is not an account id simply is not one
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const p = load(id);
  if (!p) return null;
  return {
    profile: publicOf(p),
    games: p.games.slice(0, Math.min(Math.max(1, limit), MAX_GAMES)),
    activity: { ...(p.days ?? {}) },
  };
}
