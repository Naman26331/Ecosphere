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

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

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

let _cachedSecret = null;

/**
 * The signing secret. Loaded async once and cached in memory.
 * Falls back to a generated value stored in settings.
 */
async function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (_cachedSecret) return _cachedSecret;

  const row = await get(`SELECT value FROM settings WHERE key = 'session_secret'`);
  if (row) { _cachedSecret = row.value; return row.value; }

  const generated = randomBytes(32).toString('hex');
  await run(`INSERT INTO settings (key, value) VALUES (?, ?)`, ['session_secret', generated]);
  _cachedSecret = generated;
  return generated;
}

const sign = async (payload) => createHmac('sha256', await secret()).update(payload).digest('hex');

export async function createToken(userId) {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expires}`;
  return `${payload}.${await sign(payload)}`;
}

export async function readToken(token) {
  if (!token) return null;
  const [id, expires, signature] = token.split('.');
  if (!id || !expires || !signature) return null;

  const expected = await sign(`${id}.${expires}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (Date.now() > Number(expires)) return null;
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

const SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';

export const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax${SECURE}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;

export const clearCookie = () =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax${SECURE}; Path=/; Max-Age=0`;

export async function currentUser(req) {
  const userId = await readToken(parseCookies(req)[SESSION_COOKIE]);
  if (!userId) return null;
  return get(
    `SELECT u.id, u.name, u.email, u.role, u.department_id, u.xp, u.points_balance,
            d.name AS department
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?`,
    [userId]
  );
}

export async function login(email, password) {
  const user = await get(`SELECT * FROM users WHERE lower(email) = lower(?)`, [String(email ?? '').trim()]);

  const stored = user?.password_hash ?? 'scrypt$00$00';
  const ok = verifyPassword(String(password ?? ''), stored);

  if (!user || !ok) {
    throw Object.assign(new Error('Incorrect email or password'), { status: 401 });
  }

  await run(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);
  return {
    token: await createToken(user.id),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

export { SESSION_COOKIE };
