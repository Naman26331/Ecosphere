// The only file that knows which SQL engine we run on.
// Everything above this line talks in all(), get(), run(), tx().
//
// When DATABASE_URL is set (Render Postgres), uses `pg`.
// When not set, falls back to the local SQLite file for local development.
//
// The pg API is async; SQLite is sync. We wrap both behind the SAME async
// interface so callers are identical regardless of which engine is active.

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

const USE_PG = !!process.env.DATABASE_URL;

let _pool = null;
let _sqlite = null;

if (USE_PG) {
  // Render Postgres
  const { default: pg } = await import('pg');
  const { Pool } = pg;
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // required for Render's self-signed cert
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  console.log('[db] connected to Render Postgres');
} else {
  // Local SQLite fallback
  const { DatabaseSync } = await import('node:sqlite');
  const DB_PATH = process.env.DB_PATH || join(root, 'data', 'ecosphere.db');
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _sqlite = new DatabaseSync(DB_PATH);
  _sqlite.exec('PRAGMA foreign_keys = ON');
  _sqlite.exec('PRAGMA journal_mode = WAL');
  console.log(`[db] using local SQLite: ${DB_PATH}`);
}

// ---------------------------------------------------------------------------
// Unified async API — all(), get(), run(), tx()
// ---------------------------------------------------------------------------

/**
 * Execute a SELECT and return all rows as plain objects.
 * Postgres uses $1/$2 placeholders; SQLite uses ?. We convert automatically.
 */
export async function all(sql, params = []) {
  if (_pool) {
    const pgSql = toPgPlaceholders(sql);
    const { rows } = await _pool.query(pgSql, params);
    return rows;
  }
  return _sqlite.prepare(sql).all(...params);
}

/** Execute a SELECT and return the first row, or null. */
export async function get(sql, params = []) {
  if (_pool) {
    const pgSql = toPgPlaceholders(sql);
    const { rows } = await _pool.query(pgSql, params);
    return rows[0] ?? null;
  }
  return _sqlite.prepare(sql).get(...params) ?? null;
}

/**
 * Execute INSERT / UPDATE / DELETE.
 * Returns { id, changes } so callers stay the same as before.
 */
export async function run(sql, params = []) {
  if (_pool) {
    // For INSERT…RETURNING id, or plain mutations
    const pgSql = toPgPlaceholders(
      sql.toLowerCase().includes('insert') && !sql.toLowerCase().includes('returning')
        ? sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id'
        : sql
    );
    const { rows, rowCount } = await _pool.query(pgSql, params);
    return { id: rows[0]?.id ?? null, changes: rowCount };
  }
  const r = _sqlite.prepare(sql).run(...params);
  return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

/**
 * Run an async function inside a transaction.
 * Rolls back if fn() throws.
 */
export async function tx(fn) {
  if (_pool) {
    const client = await _pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  // SQLite sync path
  _sqlite.exec('BEGIN');
  try {
    const out = await fn();
    _sqlite.exec('COMMIT');
    return out;
  } catch (err) {
    _sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Apply the schema. Idempotent — every statement is CREATE ... IF NOT EXISTS.
 * Called once on server start.
 */
export async function migrate() {
  const schemaFile = _pool ? 'schema.postgres.sql' : 'schema.sql';
  const sql = readFileSync(join(root, 'src', schemaFile), 'utf8');
  if (_pool) {
    // Split on semicolons and run each statement; pg can't run a multi-statement string.
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 1 && !s.startsWith('--'));
    for (const stmt of statements) {
      await _pool.query(stmt);
    }
  } else {
    _sqlite.exec(sql);
  }
}

/** Append-only audit trail. */
export async function audit(actor, action, entity, entityId, detail = '') {
  await run(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?)`,
    [actor, action, entity, entityId, detail]
  );
}

// ---------------------------------------------------------------------------
// Helper — convert SQLite ? placeholders to Postgres $1, $2, ...
// ---------------------------------------------------------------------------

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Expose the pool/db for callers that need raw exec (seed.js wipe loop).
export const pool = _pool;
export const sqliteDb = _sqlite;
export const IS_PG = USE_PG;

export default _pool ?? _sqlite;
