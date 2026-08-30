import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import type { Account, AuthResult } from './types.js';

/**
 * Registration: a username, a password, and nothing else.
 *
 * The browser token this server already used as an identity was never one. It is a
 * bearer credential kept in localStorage: clear the browser and you are a new person,
 * open the game on your phone and you are a different person again, and there is no way
 * to be the same player in two places. That is fine for reclaiming a seat after a refresh,
 * which is all it was built for, and useless for a record you are meant to accumulate.
 *
 * So an account owns the record now, and the browser token keeps its original job. The
 * two are deliberately separate: signing out must not cost you the seat you are sitting
 * in, and reclaiming a seat must not depend on being signed in at all.
 *
 * Guests still play. Only the record needs an account, which is the thing that cannot
 * work without one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.ACCOUNTS_DIR
  ?? path.resolve(HERE, '..', '..', 'data', 'accounts');

const scryptAsync = promisify(scrypt) as
  (secret: string, salt: string, len: number) => Promise<Buffer>;

/** scrypt at the Node default cost, which is ~100ms here -- deliberately not cheap. */
const KEY_LEN = 64;

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;     // scrypt will hash anything; this bounds the work someone
                              // else can make this server do

/** Sessions last a month, then the player signs in again. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredAccount {
  id: string;
  username: string;
  usernameLower: string;
  salt: string;
  hash: string;
  createdAt: number;
  lastSeenAt: number;
}

const byId = new Map<string, StoredAccount>();
const byName = new Map<string, StoredAccount>();
let ready = false;

function ensureDir(): boolean {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn(`[accounts] cannot use ${DIR}:`, (err as Error).message);
    return false;
  }
}

/**
 * The key that signs sessions.
 *
 * Taken from `SESSION_SECRET` where one is set, which is what a real deployment should
 * do -- it survives a redeploy and can be rotated. Failing that one is generated and
 * written beside the accounts, so a local server does not invalidate every session each
 * time it restarts. Failing even that it lives for the life of the process, and everyone
 * signs in again after a restart, which is inconvenient rather than unsafe.
 */
let secret: Buffer | null = null;

function sessionSecret(): Buffer {
  if (secret) return secret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) { secret = Buffer.from(fromEnv, 'utf8'); return secret; }

  const file = path.join(DIR, '.session-secret');
  try {
    if (ensureDir()) {
      if (fs.existsSync(file)) {
        secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
        if (secret.length >= 32) return secret;
      }
      const fresh = randomBytes(48);
      fs.writeFileSync(file, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600 });
      secret = fresh;
      return secret;
    }
  } catch (err) {
    console.warn('[accounts] no persistent session secret:', (err as Error).message);
  }
  secret = randomBytes(48);
  return secret;
}

export function initAccounts(): void {
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
      const a = JSON.parse(raw) as StoredAccount;
      if (a?.id && a.usernameLower && a.hash && a.salt) {
        byId.set(a.id, a);
        byName.set(a.usernameLower, a);
      }
    } catch {
      console.warn(`[accounts] skipping unreadable ${name}`);
    }
  }
  console.log(`[accounts] ${byId.size} account(s) in ${DIR}`);
}

function save(a: StoredAccount): boolean {
  try {
    if (!ensureDir()) return false;
    const target = path.join(DIR, `${a.id}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(a), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.warn('[accounts] save failed:', (err as Error).message);
    return false;
  }
}

function publicOf(a: StoredAccount): Account {
  return { id: a.id, username: a.username, createdAt: a.createdAt };
}

// ---------- sessions ----------

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

/**
 * A session is `<id>.<issuedAt>.<signature>` and carries no server-side state.
 *
 * Nothing has to be stored or looked up, and a restart does not log everyone out as long
 * as the secret survives. The cost is that a session cannot be revoked individually --
 * rotating `SESSION_SECRET` revokes all of them at once, which for a chess app is the
 * right trade.
 */
export function makeSession(id: string): string {
  const payload = `${id}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

/** The account a session token names, or null if it is absent, forged, or expired. */
export function accountFromSession(token: unknown): Account | null {
  if (typeof token !== 'string' || token.length > 400) return null;
  const at = token.lastIndexOf('.');
  if (at <= 0) return null;
  const payload = token.slice(0, at);
  const given = token.slice(at + 1);

  const expected = sign(payload);
  // compared byte for byte in constant time; a length mismatch is answered the same way
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;

  const [id, issued] = payload.split('.');
  const at2 = Number(issued);
  if (!id || !Number.isFinite(at2) || Date.now() - at2 > SESSION_MS) return null;

  if (!ready) initAccounts();
  const a = byId.get(id);
  return a ? publicOf(a) : null;
}

// ---------- register and sign in ----------

function checkCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Usernames are 3-24 characters, letters, numbers, dashes and underscores.';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Passwords need at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) return 'That password is too long.';
  return null;
}

export async function register(username: unknown, password: unknown): Promise<AuthResult> {
  if (!ready) initAccounts();
  const bad = checkCredentials(username, password);
  if (bad) return { ok: false, error: bad };

  const name = username as string;
  const lower = name.toLowerCase();
  if (byName.has(lower)) return { ok: false, error: 'That username is taken.' };

  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password as string, salt, KEY_LEN)).toString('hex');
  const now = Date.now();
  const account: StoredAccount = {
    id: randomBytes(8).toString('hex'),
    username: name,
    usernameLower: lower,
    salt,
    hash,
    createdAt: now,
    lastSeenAt: now,
  };

  // Written before it is announced: an account the player is told they have, that did not
  // reach the disk, is worse than a failed registration they can simply retry.
  if (!save(account)) return { ok: false, error: 'Could not create the account. Try again.' };
  byId.set(account.id, account);
  byName.set(lower, account);

  return { ok: true, account: publicOf(account), session: makeSession(account.id) };
}

export async function login(username: unknown, password: unknown): Promise<AuthResult> {
  if (!ready) initAccounts();
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { ok: false, error: 'Enter a username and password.' };
  }
  const a = byName.get(username.toLowerCase());

  // A missing account still costs a hash, so "no such user" and "wrong password" take the
  // same time to answer and the reply cannot be used to enumerate who is registered.
  const salt = a?.salt ?? 'no-such-account';
  const given = await scryptAsync(password.slice(0, MAX_PASSWORD), salt, KEY_LEN);
  if (!a) return { ok: false, error: 'Wrong username or password.' };

  const known = Buffer.from(a.hash, 'hex');
  if (given.length !== known.length || !timingSafeEqual(given, known)) {
    return { ok: false, error: 'Wrong username or password.' };
  }

  a.lastSeenAt = Date.now();
  save(a);
  return { ok: true, account: publicOf(a), session: makeSession(a.id) };
}

export function accountById(id: string): Account | null {
  if (!ready) initAccounts();
  const a = byId.get(id);
  return a ? publicOf(a) : null;
}
