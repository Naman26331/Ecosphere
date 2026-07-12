-- EcoSphere Auto-Pilot -- PostgreSQL schema
-- Translated from SQLite for Render Postgres.
-- Run via: migrate() in db.js on server start.
-- Every statement is idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

-- ---------------------------------------------------------------------------
-- MASTER DATA
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS departments (
  id             SERIAL PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  code           TEXT    NOT NULL UNIQUE,
  head           TEXT,
  employee_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE,
  role           TEXT    NOT NULL DEFAULT 'employee',
  department_id  INTEGER REFERENCES departments(id),
  avatar         TEXT,
  xp             INTEGER NOT NULL DEFAULT 0,
  points_balance INTEGER NOT NULL DEFAULT 0,
  password_hash  TEXT,
  last_login     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS emission_factors (
  id            SERIAL PRIMARY KEY,
  category      TEXT    NOT NULL,
  activity      TEXT    NOT NULL,
  unit          TEXT    NOT NULL,
  factor_kgco2e REAL    NOT NULL,
  scope         INTEGER NOT NULL DEFAULT 2,
  source        TEXT,
  UNIQUE (category, activity)
);

CREATE TABLE IF NOT EXISTS badges (
  id            SERIAL PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE,
  description   TEXT,
  icon          TEXT    NOT NULL DEFAULT 'military_tech',
  tier          TEXT    NOT NULL DEFAULT 'bronze',
  xp_threshold  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rewards (
  id              SERIAL PRIMARY KEY,
  name            TEXT    NOT NULL,
  description     TEXT,
  points_required INTEGER NOT NULL,
  stock           INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'active',
  icon            TEXT    NOT NULL DEFAULT 'redeem'
);

CREATE TABLE IF NOT EXISTS policies (
  id            SERIAL PRIMARY KEY,
  name          TEXT    NOT NULL,
  framework     TEXT    NOT NULL,
  version       TEXT    NOT NULL DEFAULT '1.0',
  status        TEXT    NOT NULL DEFAULT 'active',
  last_reviewed TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- TRANSACTIONAL DATA
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS carbon_transactions (
  id                 SERIAL PRIMARY KEY,
  department_id      INTEGER NOT NULL REFERENCES departments(id),
  emission_factor_id INTEGER NOT NULL REFERENCES emission_factors(id),
  user_id            INTEGER REFERENCES users(id),
  activity_date      DATE    NOT NULL,
  quantity           REAL    NOT NULL,
  co2e_kg            REAL    NOT NULL,
  source             TEXT    NOT NULL DEFAULT 'manual',
  document_ref       TEXT,
  ai_confidence      REAL,
  status             TEXT    NOT NULL DEFAULT 'verified',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS esg_goals (
  id            SERIAL PRIMARY KEY,
  name          TEXT    NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  baseline_co2  REAL    NOT NULL,
  target_co2    REAL    NOT NULL,
  current_co2   REAL    NOT NULL,
  deadline      DATE    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS challenges (
  id          SERIAL PRIMARY KEY,
  title       TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  description TEXT,
  points      INTEGER NOT NULL DEFAULT 0,
  xp          INTEGER NOT NULL DEFAULT 0,
  icon        TEXT    NOT NULL DEFAULT 'flag',
  start_date  DATE,
  end_date    DATE,
  status      TEXT    NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS participations (
  id             SERIAL PRIMARY KEY,
  challenge_id   INTEGER NOT NULL REFERENCES challenges(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  proof_url      TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending',
  ai_confidence  REAL,
  ai_reason      TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at    TIMESTAMPTZ,
  UNIQUE (challenge_id, user_id)
);

CREATE TABLE IF NOT EXISTS redemptions (
  id           SERIAL PRIMARY KEY,
  reward_id    INTEGER NOT NULL REFERENCES rewards(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  points_spent INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'confirmed',
  redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  badge_id   INTEGER NOT NULL REFERENCES badges(id),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS compliance_issues (
  id            SERIAL PRIMARY KEY,
  title         TEXT    NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  owner_id      INTEGER REFERENCES users(id),
  framework     TEXT,
  severity      TEXT    NOT NULL DEFAULT 'medium',
  status        TEXT    NOT NULL DEFAULT 'open',
  due_date      DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reports (
  id           SERIAL PRIMARY KEY,
  title        TEXT    NOT NULL,
  type         TEXT    NOT NULL DEFAULT 'custom',
  framework    TEXT,
  period       TEXT,
  status       TEXT    NOT NULL DEFAULT 'ready',
  snapshot     TEXT,
  created_by   INTEGER REFERENCES users(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  icon       TEXT    NOT NULL DEFAULT 'notifications',
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  link       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  actor      TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  entity     TEXT    NOT NULL,
  entity_id  INTEGER,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for hot paths
CREATE INDEX IF NOT EXISTS idx_ct_dept   ON carbon_transactions(department_id);
CREATE INDEX IF NOT EXISTS idx_ct_date   ON carbon_transactions(activity_date);
CREATE INDEX IF NOT EXISTS idx_part_user ON participations(user_id);
CREATE INDEX IF NOT EXISTS idx_ci_status ON compliance_issues(status);
CREATE INDEX IF NOT EXISTS idx_audit_at  ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
