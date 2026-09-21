'use strict';
/**
 * Admin authentication: scrypt password hashing, server-side sessions,
 * CSRF tokens, login throttling and the one-time setup token.
 *
 * Choices worth stating out loud:
 *   - scrypt with a per-account random salt; no plaintext or reversible form is
 *     ever stored. Verification is constant-time.
 *   - sessions are server side and referenced by an HttpOnly cookie, so a
 *     stolen cookie can be revoked (logout-everywhere) and nothing sensitive
 *     lives in the browser.
 *   - login failures are counted per IP with a lockout window, so the panel
 *     cannot be brute-forced from one host.
 */
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const LOCK_AFTER = 10;             // failures before a lockout
const LOCK_MS = 15 * 60 * 1000;    // lockout duration

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return {
    salt,
    hash: hash.toString('base64'),
    params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen },
  };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const p = rec.params || SCRYPT;
  let got;
  try {
    got = crypto.scryptSync(password, rec.salt, p.keylen || SCRYPT.keylen, { N: p.N, r: p.r, p: p.p });
  } catch (e) {
    return false;
  }
  const want = Buffer.from(rec.hash, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Password policy, shared by the register form and the change-password form. */
function passwordProblem(password) {
  if (typeof password !== 'string') return 'password must be a string';
  if (password.length < 10) return 'password must be at least 10 characters';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'password must contain letters and numbers';
  if (password.length > 200) return 'password is too long';
  return null;
}

function ipHash(ip) {
  return crypto.createHash('sha256').update(`meow-ip:${ip}`).digest('hex').slice(0, 32);
}

/* --------------------------------------------------------------- login limit */

function lockedFor(store, ip) {
  const rec = store.data.loginFails[ipHash(ip)];
  if (!rec) return 0;
  const left = (rec.until || 0) - Date.now();
  return left > 0 ? left : 0;
}

function noteFailure(store, ip) {
  const k = ipHash(ip);
  const rec = store.data.loginFails[k] || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= LOCK_AFTER) { rec.until = Date.now() + LOCK_MS; rec.count = 0; }
  store.data.loginFails[k] = rec;
  store.dirty();
}

function clearFailures(store, ip) {
  delete store.data.loginFails[ipHash(ip)];
  store.dirty();
}

/* ------------------------------------------------------------------ sessions */

const COOKIE = 'meow_admin';

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function createSession(store, req, hours) {
  const id = crypto.randomBytes(32).toString('base64url');
  const sess = {
    id,
    csrf: crypto.randomBytes(24).toString('base64url'),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    ip: req.clientIp || '',
    ua: String(req.headers['user-agent'] || '').slice(0, 250),
    expiresAt: Date.now() + hours * 3600 * 1000,
  };
  store.data.sessions.push(sess);
  /* keep the session table small: at most 50 live sessions */
  if (store.data.sessions.length > 50) store.data.sessions.splice(0, store.data.sessions.length - 50);
  store.dirty();
  return sess;
}

function sessionFromRequest(store, req) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (!id) return null;
  const sess = store.data.sessions.find(s => s.id === id);
  if (!sess) return null;
  if (sess.expiresAt && sess.expiresAt < Date.now()) {
    store.data.sessions = store.data.sessions.filter(s => s.id !== id);
    store.dirty();
    return null;
  }
  sess.lastSeen = Date.now();
  store.dirty();
  return sess;
}

function dropSession(store, id) {
  const n = store.data.sessions.length;
  store.data.sessions = store.data.sessions.filter(s => s.id !== id);
  if (store.data.sessions.length !== n) store.dirty();
}

function cookieHeader(id, { secure, maxAgeSec, clear }) {
  const bits = [`${COOKIE}=${clear ? '' : id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) bits.push('Secure');
  bits.push(clear ? 'Max-Age=0' : `Max-Age=${maxAgeSec}`);
  return bits.join('; ');
}

/** CSRF: every state-changing admin call must echo the session's token, and
 *  same-origin is enforced as a second gate. */
function csrfOk(req, sess) {
  const got = req.headers['x-meow-csrf'];
  if (!got || typeof got !== 'string') return false;
  const a = Buffer.from(got), b = Buffer.from(sess.csrf || '');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  hashPassword, verifyPassword, passwordProblem, ipHash,
  lockedFor, noteFailure, clearFailures,
  parseCookies, createSession, sessionFromRequest, dropSession, cookieHeader, csrfOk,
  COOKIE, LOCK_AFTER, LOCK_MS,
};
