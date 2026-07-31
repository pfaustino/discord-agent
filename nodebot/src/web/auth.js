// Password login with signed session-cookie tokens. Ported from web/auth.py.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DASHBOARD_PASSWORD, SECRET_KEY } from '../config.js';

// If SECRET_KEY isn't set, generate one per process (sessions reset on
// restart) rather than falling back to a predictable value.
const SECRET = SECRET_KEY || randomBytes(32).toString('hex');
export const TOKEN_TTL = 7 * 86400; // seconds

function sign(payload) {
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

/** Constant-time compare that tolerates length mismatches. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createToken() {
  const expiry = String(Math.floor(Date.now() / 1000) + TOKEN_TTL);
  return `${expiry}.${sign(expiry)}`;
}

export function verifyToken(token) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot === -1) return false;
  const expiry = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!safeEqual(signature, sign(expiry))) return false;
  const expiresAt = parseInt(expiry, 10);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() / 1000;
}

export function checkPassword(password) {
  // No password configured means no login is possible — never "anything works".
  if (!DASHBOARD_PASSWORD) return false;
  return safeEqual(password ?? '', DASHBOARD_PASSWORD);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function isAuthenticated(req) {
  return verifyToken(parseCookies(req.headers.cookie).session);
}
