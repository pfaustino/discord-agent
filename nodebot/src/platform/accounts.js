// Customer accounts: sign-up, sign-in, and the session cookie that carries
// one around.
//
// Deliberately separate from web/auth.js. That file answers "what may this
// person do to THIS Discord server", derived from that server's own roles —
// it is for the people running a bot. This one answers "which customer is
// this", which is a different question with a different answer for the same
// human: the person who owns the account and the person who moderates the
// server are often not each other.
import {
  createHmac, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';
import { SECRET_KEY } from '../config.js';
import { getDb } from '../db.js';
import { newId } from '../credits/ledger.js';

// Same fallback as web/auth.js: without a configured secret, sign with a
// per-process key so sessions reset on restart rather than being predictable.
const SECRET = SECRET_KEY || randomBytes(32).toString('hex');
export const SESSION_TTL = 30 * 86400; // seconds — customers, not admins
export const SESSION_COOKIE = 'platform_session';

const now = () => Math.floor(Date.now() / 1000);

/* ── Passwords ────────────────────────────────────────────────────────────── */

const SCRYPT_KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

/** `scrypt$<salt hex>$<key hex>`. The salt is stored with the hash because
 *  it has to be — it is not a secret, it is what stops one rainbow table
 *  covering every account at once. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let key;
  try {
    key = scryptSync(String(password), Buffer.from(parts[1], 'hex'), SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== key.length) return false;
  return timingSafeEqual(key, expected);
}

/** Why this password is not acceptable, or null if it is. */
export function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isEmail(email) {
  return EMAIL_RE.test(normalizeEmail(email));
}

/* ── Accounts ─────────────────────────────────────────────────────────────── */

/** Everything except the password hash — what is safe to send to a browser. */
export function publicAccount(row) {
  if (!row) return null;
  const { password_hash: _hash, ...rest } = row;
  return {
    id: rest.id,
    name: rest.name,
    email: rest.email,
    venue: rest.venue,
    credits: rest.credits_milli / 1000,
    isStaff: Boolean(rest.is_staff),
    autoTopUp: safeJson(rest.auto_topup, {}),
    createdAt: rest.created_at * 1000,
  };
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function getAccount(id) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(String(id)) || null;
}

export function accountByEmail(email) {
  return getDb().prepare('SELECT * FROM accounts WHERE email = ?').get(normalizeEmail(email)) || null;
}

export class AccountError extends Error {}

/**
 * Create a customer account.
 *
 * `venue` is a property of the account, not of a server, and mixing them on
 * one account is out of scope: the metering, the invoicing and the failure
 * modes all differ, and a per-server venue would mean answering what happens
 * when a managed server runs dry on an account that also has BYOK servers.
 */
export function createAccount({
  name, email, password, venue = 'managed', isStaff = false,
}) {
  const cleanEmail = normalizeEmail(email);
  if (!isEmail(cleanEmail)) throw new AccountError('That does not look like an email address.');
  if (!String(name || '').trim()) throw new AccountError('An account name is required.');
  if (!['managed', 'enterprise'].includes(venue)) throw new AccountError(`Unknown venue: ${venue}`);
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
  if (accountByEmail(cleanEmail)) throw new AccountError('An account with that email already exists.');

  const id = newId('acct');
  const stamp = now();
  getDb().prepare(`
    INSERT INTO accounts (id, name, email, password_hash, venue, credits_milli,
                          auto_topup, is_staff, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, '{}', ?, ?, ?)
  `).run(id, String(name).trim(), cleanEmail, hashPassword(password), venue,
  isStaff ? 1 : 0, stamp, stamp);
  return getAccount(id);
}

/** @returns the account row, or null when the email or password is wrong.
 *  Deliberately does not say which — that difference is a way to find out
 *  whether an address has an account here. */
export function authenticate(email, password) {
  const account = accountByEmail(email);
  if (!account) {
    // Hash anyway, so a missing account does not answer noticeably faster
    // than a wrong password and turn timing into an account-existence oracle.
    verifyPassword(password, `scrypt$${'00'.repeat(16)}$${'00'.repeat(SCRYPT_KEYLEN)}`);
    return null;
  }
  return verifyPassword(password, account.password_hash) ? account : null;
}

export function setPassword(accountId, password) {
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
  getDb().prepare('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(password), now(), String(accountId));
}

export function setStaff(accountId, isStaff) {
  getDb().prepare('UPDATE accounts SET is_staff = ?, updated_at = ? WHERE id = ?')
    .run(isStaff ? 1 : 0, now(), String(accountId));
}

export function setAutoTopUp(accountId, config) {
  getDb().prepare('UPDATE accounts SET auto_topup = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(config || {}), now(), String(accountId));
}

export function listAccounts({ limit = 200 } = {}) {
  return getDb().prepare('SELECT * FROM accounts ORDER BY created_at DESC LIMIT ?')
    .all(Number(limit));
}

/* ── Sessions ─────────────────────────────────────────────────────────────── */

function sign(payload) {
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Session token: `expiry.accountId.signature`.
 *
 * The account id is inside the signed payload, so it cannot be swapped for
 * somebody else's. Staff-ness deliberately is NOT in the token — it is read
 * from the account row on every request, so revoking it takes effect at once
 * rather than whenever that person's cookie happens to expire. */
export function createSession(accountId) {
  const expiry = String(now() + SESSION_TTL);
  const payload = `${expiry}.${encodeURIComponent(accountId)}`;
  return `${payload}.${sign(payload)}`;
}

/** @returns {{accountId: string, expiresAt: number}|null} */
export function readSession(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [expiry, accountId, signature] = parts;
  if (!safeEqual(signature, sign(`${expiry}.${accountId}`))) return null;
  const expiresAt = parseInt(expiry, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) return null;
  return { accountId: decodeURIComponent(accountId), expiresAt };
}

export const sessionCookie = (token) => `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL}; `
  + 'Path=/; HttpOnly; SameSite=Lax; Secure';

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Max-Age=0; Path=/; `
  + 'HttpOnly; SameSite=Lax; Secure';
