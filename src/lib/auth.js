// Authentication: password hashing and session cookies.
//
// Built entirely on node:crypto, so the zero-dependency rule still holds -- no
// bcrypt, no jsonwebtoken, no express-session.
import {
  scryptSync, randomBytes, timingSafeEqual, createHmac,
} from 'node:crypto';
import { get, run } from '../db.js';

const SESSION_COOKIE = 'eco_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours -- a working day

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Hash a password with scrypt.
 *
 * scrypt is deliberately slow and memory-hard, so an attacker holding the
 * database can't brute-force it at speed. Every password gets its own random
 * salt, so two people choosing the same password still get different hashes and
 * one cracked hash tells you nothing about the next.
 *
 * The plaintext is never written anywhere -- not to the database, not to a log.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/**
 * Check a password against a stored hash.
 *
 * timingSafeEqual, not `===`: a normal string compare bails out at the first
 * wrong byte, and the time it took leaks how much of the hash was right. This
 * always takes the same time regardless.
 */
export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;

  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * The signing secret. Generated once and kept in `settings`, so sessions survive
 * a restart instead of logging everyone out. In a real deployment this comes
 * from the environment, never the database -- hence the override.
 */
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const row = get(`SELECT value FROM settings WHERE key = 'session_secret'`);
  if (row) return row.value;

  const generated = randomBytes(32).toString('hex');
  run(`INSERT INTO settings (key, value) VALUES ('session_secret', ?)`, [generated]);
  return generated;
}

const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('hex');

/**
 * Build a session token: "<userId>.<expiry>.<signature>".
 *
 * Stateless -- there's no sessions table. The signature is what makes it safe:
 * anyone can read the user id out of the token, but they can't change it to
 * someone else's without the secret, and the server recomputes the signature on
 * every request. Editing the cookie to `1.<future>` gets you a 401.
 */
export function createToken(userId) {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/** Verify a token and return the user id, or null if it's forged or expired. */
export function readToken(token) {
  if (!token) return null;
  const [id, expires, signature] = token.split('.');
  if (!id || !expires || !signature) return null;

  const expected = sign(`${id}.${expires}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null; // tampered

  if (Date.now() > Number(expires)) return null; // expired
  return Number(id);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const i = part.indexOf('=');
      return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))];
    })
  );
}

// In production we're behind HTTPS, so mark the cookie Secure -- the browser then
// refuses to send it over plain HTTP, which is what stops it being sniffed in
// transit. Left off locally, because localhost is HTTP and a Secure cookie would
// simply never be sent, silently breaking login on your own machine.
const SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';

/**
 * HttpOnly so page scripts can't read the token (an XSS bug can't steal the
 * session). SameSite=Lax so another site can't ride the cookie on a form post.
 */
export const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax${SECURE}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;

export const clearCookie = () =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax${SECURE}; Path=/; Max-Age=0`;

/** The user this request belongs to, or null. The single source of truth. */
export function currentUser(req) {
  const userId = readToken(parseCookies(req)[SESSION_COOKIE]);
  if (!userId) return null;
  return get(
    `SELECT u.id, u.name, u.email, u.role, u.department_id, u.xp, u.points_balance,
            d.name AS department
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?`,
    [userId]
  );
}

/**
 * Log in. Deliberately gives the SAME error whether the email is unknown or the
 * password is wrong -- telling an attacker "that email exists, wrong password"
 * hands them a list of valid accounts.
 */
export function login(email, password) {
  const user = get(`SELECT * FROM users WHERE lower(email) = lower(?)`, [String(email ?? '').trim()]);

  // Hash even when the user doesn't exist, so a missing account doesn't answer
  // measurably faster than a wrong password and reveal itself that way.
  const stored = user?.password_hash ?? 'scrypt$00$00';
  const ok = verifyPassword(String(password ?? ''), stored);

  if (!user || !ok) {
    throw Object.assign(new Error('Incorrect email or password'), { status: 401 });
  }

  run(`UPDATE users SET last_login = datetime('now') WHERE id = ?`, [user.id]);
  return {
    token: createToken(user.id),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

export { SESSION_COOKIE };
