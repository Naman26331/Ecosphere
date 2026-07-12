// The only file that knows which SQL engine we run on.
// Everything above this line talks in all(), get(), run(), tx().
// Moving to Postgres = reimplement these four against `pg`; nothing else changes.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DB_PATH = process.env.DB_PATH || join(root, 'data', 'ecosphere.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL'); // concurrent reads while the AI pipeline writes

/** Apply the schema. Idempotent -- every statement is CREATE ... IF NOT EXISTS. */
export function migrate() {
  db.exec(readFileSync(join(root, 'src', 'schema.sql'), 'utf8'));
}

export const all = (sql, params = []) => db.prepare(sql).all(...params);
export const get = (sql, params = []) => db.prepare(sql).get(...params) ?? null;

export function run(sql, params = []) {
  const r = db.prepare(sql).run(...params);
  return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Append-only audit trail. Called by every route that mutates state. */
export function audit(actor, action, entity, entityId, detail = '') {
  run(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?)`,
    [actor, action, entity, entityId, detail]
  );
}

export { DB_PATH };
export default db;
