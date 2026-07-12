-- EcoSphere Auto-Pilot -- relational schema
-- Split into MASTER DATA (rarely changes, admin-maintained) and
-- TRANSACTIONAL DATA (appended constantly by users + the AI pipeline).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- MASTER DATA
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS departments (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  code           TEXT    NOT NULL UNIQUE,
  head           TEXT,
  employee_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  role          TEXT    NOT NULL DEFAULT 'employee',   -- employee | manager | officer | admin
  department_id INTEGER REFERENCES departments(id),
  avatar        TEXT,
  xp            INTEGER NOT NULL DEFAULT 0
);

-- kg of CO2e released per 1 unit of activity. The heart of the OCR pipeline:
-- extracted quantity x factor_kgco2e = carbon_transactions.co2e_kg
CREATE TABLE IF NOT EXISTS emission_factors (
  id            INTEGER PRIMARY KEY,
  category      TEXT    NOT NULL,          -- Electricity | Fuel | Travel | Waste | Water
  activity      TEXT    NOT NULL,          -- 'Grid electricity', 'Diesel', ...
  unit          TEXT    NOT NULL,          -- kWh | litre | km | kg | m3
  factor_kgco2e REAL    NOT NULL,
  scope         INTEGER NOT NULL DEFAULT 2,-- GHG Protocol scope 1/2/3
  source        TEXT,                      -- e.g. 'DEFRA 2024', 'CEA India v19'
  UNIQUE (category, activity)
);

CREATE TABLE IF NOT EXISTS badges (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE,
  description   TEXT,
  icon          TEXT    NOT NULL DEFAULT 'military_tech',
  tier          TEXT    NOT NULL DEFAULT 'bronze',   -- bronze | silver | gold | platinum
  xp_threshold  INTEGER NOT NULL                     -- auto-awarded when user.xp >= this
);

CREATE TABLE IF NOT EXISTS policies (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  framework     TEXT    NOT NULL,          -- GRI | BRSR | TCFD | SASB
  version       TEXT    NOT NULL DEFAULT '1.0',
  status        TEXT    NOT NULL DEFAULT 'active',   -- active | draft | retired
  last_reviewed TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- TRANSACTIONAL DATA
-- ---------------------------------------------------------------------------

-- One row per utility bill line / fuel receipt / logged activity.
-- `source` = 'ocr' rows were created by the AI pipeline with no manual typing.
CREATE TABLE IF NOT EXISTS carbon_transactions (
  id                 INTEGER PRIMARY KEY,
  department_id      INTEGER NOT NULL REFERENCES departments(id),
  emission_factor_id INTEGER NOT NULL REFERENCES emission_factors(id),
  user_id            INTEGER REFERENCES users(id),
  activity_date      TEXT    NOT NULL,          -- ISO yyyy-mm-dd
  quantity           REAL    NOT NULL,
  co2e_kg            REAL    NOT NULL,          -- quantity * factor, denormalised on write
  source             TEXT    NOT NULL DEFAULT 'manual',  -- manual | ocr | import
  document_ref       TEXT,                      -- uploaded filename, if any
  ai_confidence      REAL,                      -- 0..1, null for manual entry
  status             TEXT    NOT NULL DEFAULT 'verified', -- verified | pending | rejected
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS esg_goals (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  baseline_co2  REAL    NOT NULL,     -- where we started (tCO2e)
  target_co2    REAL    NOT NULL,     -- where we must land
  current_co2   REAL    NOT NULL,     -- where we are now
  deadline      TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' -- on_track | at_risk | completed | pending
);

CREATE TABLE IF NOT EXISTS challenges (
  id          INTEGER PRIMARY KEY,
  title       TEXT    NOT NULL,
  category    TEXT    NOT NULL,      -- must match what AI vision verifies against
  description TEXT,
  points      INTEGER NOT NULL DEFAULT 0,
  xp          INTEGER NOT NULL DEFAULT 0,
  icon        TEXT    NOT NULL DEFAULT 'flag',
  start_date  TEXT,
  end_date    TEXT,
  status      TEXT    NOT NULL DEFAULT 'open'  -- open | closed
);

-- An employee submits photo proof; AI vision verifies it against challenge.category.
CREATE TABLE IF NOT EXISTS participations (
  id             INTEGER PRIMARY KEY,
  challenge_id   INTEGER NOT NULL REFERENCES challenges(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  proof_url      TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  ai_confidence  REAL,
  ai_reason      TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  submitted_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  reviewed_at    TEXT,
  UNIQUE (challenge_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  badge_id   INTEGER NOT NULL REFERENCES badges(id),
  awarded_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS compliance_issues (
  id            INTEGER PRIMARY KEY,
  title         TEXT    NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  owner_id      INTEGER REFERENCES users(id),
  framework     TEXT,
  severity      TEXT    NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  status        TEXT    NOT NULL DEFAULT 'open',   -- open | in_progress | resolved
  due_date      TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY,
  title        TEXT    NOT NULL,
  type         TEXT    NOT NULL DEFAULT 'custom', -- custom | environmental | social | governance
  framework    TEXT,
  period       TEXT,
  status       TEXT    NOT NULL DEFAULT 'ready',  -- ready | generating | failed
  -- The scores AS THEY STOOD when the report was generated, stored as JSON.
  -- A report is a point-in-time record: recomputing it later would silently
  -- rewrite history, which is exactly what an audit is supposed to prevent.
  snapshot     TEXT,
  created_by   INTEGER REFERENCES users(id),
  generated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Append-only. Every state change the backend makes lands here, so the
-- "Audit Log" screen is a real record and not decoration.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  entity     TEXT    NOT NULL,
  entity_id  INTEGER,
  detail     TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Hot paths: dashboard aggregates by department, feed reads by recency.
CREATE INDEX IF NOT EXISTS idx_ct_dept   ON carbon_transactions(department_id);
CREATE INDEX IF NOT EXISTS idx_ct_date   ON carbon_transactions(activity_date);
CREATE INDEX IF NOT EXISTS idx_part_user ON participations(user_id);
CREATE INDEX IF NOT EXISTS idx_ci_status ON compliance_issues(status);
CREATE INDEX IF NOT EXISTS idx_audit_at  ON audit_log(created_at DESC);
