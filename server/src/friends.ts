import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountById, accountByName } from './accounts.js';
import type { FriendView, FriendsView } from './types.js';

/**
 * Friends: who you play with, and whether they are here.
 *
 * Two people, both signed in, who have each agreed to it. Requests rather than a
 * one-sided list, because the thing a friend can do is put an invitation on your screen
 * while you are in the middle of a game, and that is not something a stranger should be
 * able to arrange by typing your name.
 *
 * Storage is the same dull shape as every other store here: one JSON file per account
 * under `FRIENDS_DIR`, defaulting to `data/friends`, read once at startup and written on
 * change. A friendship is stored on both sides -- twice the writes, but every read is one
 * file, and a list of friends is read far more often than it is changed.
 *
 * Presence is not stored at all. It is a map of who has a live socket, rebuilt from
 * nothing every time the server starts, because that is exactly what it means.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.FRIENDS_DIR
  ?? path.resolve(HERE, '..', '..', 'data', 'friends');

/** Nobody needs more than this, and a cap is what stops a list becoming a payload. */
const MAX_FRIENDS = 200;
const MAX_PENDING = 100;

interface StoredFriends {
  id: string;
  /** Accepted, both ways. */
  friends: string[];
  /** Requests this account has sent, and requests waiting on it. */
  outgoing: string[];
  incoming: string[];
}

const cache = new Map<string, StoredFriends>();
let ready = false;

function ensureDir(): boolean {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn(`[friends] cannot use ${DIR}:`, (err as Error).message);
    return false;
  }
}

export function initFriends(): void {
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
      const f = JSON.parse(raw) as StoredFriends;
      if (f?.id && Array.isArray(f.friends)) cache.set(f.id, normalise(f));
    } catch {
      console.warn(`[friends] skipping unreadable ${name}`);
    }
  }
  console.log(`[friends] ${cache.size} list(s) in ${DIR}`);
}

function normalise(f: Partial<StoredFriends> & { id: string }): StoredFriends {
  return {
    id: f.id,
    friends: (f.friends ?? []).slice(0, MAX_FRIENDS),
    outgoing: (f.outgoing ?? []).slice(0, MAX_PENDING),
    incoming: (f.incoming ?? []).slice(0, MAX_PENDING),
  };
}

function load(id: string): StoredFriends {
  if (!ready) initFriends();
  let f = cache.get(id);
  if (!f) {
    f = { id, friends: [], outgoing: [], incoming: [] };
    cache.set(id, f);
  }
  return f;
}

function save(f: StoredFriends): void {
  try {
    if (!ensureDir()) return;
    const target = path.join(DIR, `${f.id}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(f), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn('[friends] save failed:', (err as Error).message);
  }
}

// ---------- presence ----------

/**
 * Who is connected, and where.
 *
 * An account can have several sockets -- two tabs, a phone as well as a laptop -- so this
 * is a set per account rather than a flag. The room is whatever the newest socket is in,
 * which is the one a friend would be joining.
 */
const online = new Map<string, Map<string, string | null>>();

export function nowOnline(accountId: string, socketId: string, roomId: string | null): void {
  const sockets = online.get(accountId) ?? new Map<string, string | null>();
  sockets.set(socketId, roomId);
  online.set(accountId, sockets);
}

export function nowOffline(socketId: string): void {
  for (const [accountId, sockets] of online) {
    if (!sockets.delete(socketId)) continue;
    if (sockets.size === 0) online.delete(accountId);
    return;
  }
}

/** The room a friend could be joined in, if they are in one. */
export function presenceOf(accountId: string): { online: boolean; roomId: string | null } {
  const sockets = online.get(accountId);
  if (!sockets || sockets.size === 0) return { online: false, roomId: null };
  let roomId: string | null = null;
  for (const room of sockets.values()) if (room) roomId = room;
  return { online: true, roomId };
}

/** Every live socket for an account, so an invitation can be put in front of them. */
export function socketsOf(accountId: string): string[] {
  return [...(online.get(accountId)?.keys() ?? [])];
}

export function onlineCount(): number {
  return online.size;
}

// ---------- the list ----------

function viewOf(id: string): FriendView | null {
  const account = accountById(id);
  if (!account) return null;
  const { online: isOnline, roomId } = presenceOf(id);
  return { id, name: account.username, online: isOnline, roomId };
}

function views(ids: string[]): FriendView[] {
  return ids.map(viewOf).filter((v): v is FriendView => v != null)
    .sort((a, b) => (Number(b.online) - Number(a.online))
      || a.name.localeCompare(b.name));
}

export function friendsView(id: string): FriendsView {
  const f = load(id);
  return {
    friends: views(f.friends),
    incoming: views(f.incoming),
    outgoing: views(f.outgoing),
  };
}

/** Are these two friends? The one question the invite path has to ask. */
export function areFriends(a: string, b: string): boolean {
  return load(a).friends.includes(b);
}

export interface FriendResult {
  ok: boolean;
  error?: string;
  /** True when this call completed a friendship rather than opening a request. */
  accepted?: boolean;
  /** The other account, for telling them about it. */
  otherId?: string;
}

/**
 * Ask to be someone's friend, by name.
 *
 * If they have already asked you, this accepts instead -- which is what both people meant
 * by it, and saves the second person hunting for a button they have no reason to expect.
 */
export function requestFriend(id: string, username: string): FriendResult {
  const other = accountByName(username);
  if (!other) return { ok: false, error: 'No account by that name' };
  if (other.id === id) return { ok: false, error: 'You are already your own company' };

  const mine = load(id);
  const theirs = load(other.id);

  if (mine.friends.includes(other.id)) {
    return { ok: false, error: `You and ${other.username} are already friends` };
  }
  if (mine.friends.length >= MAX_FRIENDS) {
    return { ok: false, error: 'Your friend list is full' };
  }

  // They asked first: this is an acceptance wearing another name.
  if (mine.incoming.includes(other.id)) return accept(id, other.id);

  if (mine.outgoing.includes(other.id)) {
    return { ok: false, error: `${other.username} has not answered yet` };
  }
  if (theirs.incoming.length >= MAX_PENDING) {
    return { ok: false, error: 'That player has too many requests waiting' };
  }

  mine.outgoing.push(other.id);
  theirs.incoming.push(id);
  save(mine);
  save(theirs);
  return { ok: true, accepted: false, otherId: other.id };
}

export function accept(id: string, otherId: string): FriendResult {
  const mine = load(id);
  const theirs = load(otherId);
  if (!mine.incoming.includes(otherId)) return { ok: false, error: 'No request from them' };

  mine.incoming = mine.incoming.filter(x => x !== otherId);
  theirs.outgoing = theirs.outgoing.filter(x => x !== id);
  if (!mine.friends.includes(otherId)) mine.friends.push(otherId);
  if (!theirs.friends.includes(id)) theirs.friends.push(id);
  save(mine);
  save(theirs);
  return { ok: true, accepted: true, otherId };
}

/**
 * Remove a friend, decline a request, or withdraw one.
 *
 * All three are the same operation -- "there is no longer a link between these two" --
 * and giving them one name means no state can be left behind on one side of it.
 */
export function unfriend(id: string, otherId: string): FriendResult {
  const mine = load(id);
  const theirs = load(otherId);
  const had = mine.friends.includes(otherId)
    || mine.incoming.includes(otherId) || mine.outgoing.includes(otherId);

  mine.friends = mine.friends.filter(x => x !== otherId);
  mine.incoming = mine.incoming.filter(x => x !== otherId);
  mine.outgoing = mine.outgoing.filter(x => x !== otherId);
  theirs.friends = theirs.friends.filter(x => x !== id);
  theirs.incoming = theirs.incoming.filter(x => x !== id);
  theirs.outgoing = theirs.outgoing.filter(x => x !== id);
  save(mine);
  save(theirs);
  return had ? { ok: true, otherId } : { ok: false, error: 'Nothing to remove' };
}

/** Everyone who should be told that this account's presence changed. */
export function friendIdsOf(id: string): string[] {
  return [...load(id).friends];
}

/** For the admin overview: how many friendships exist at all. */
export function friendshipCount(): number {
  if (!ready) initFriends();
  let n = 0;
  for (const f of cache.values()) n += f.friends.length;
  return Math.round(n / 2);
}
