// Seeds a full year of believable ESG history.
//
// Deterministic on purpose: a seeded PRNG means `npm run reset` reproduces the
// exact same database every time.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './lib/auth.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DB_PATH = join(root, 'data', 'ecosphere.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const migrate = () => {
  db.exec(readFileSync(join(root, 'src', 'schema.sql'), 'utf8'));
};

const all = (sql, params = []) => db.prepare(sql).all(...params);
const get = (sql, params = []) => db.prepare(sql).get(...params) ?? null;
const run = (sql, params = []) => {
  const r = db.prepare(sql).run(...params);
  return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
};
const tx = (fn) => {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

// Mulberry32 -- tiny, fast, and stable across Node versions.
let _s = 20260712;
const rnd = () => {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

console.log('EcoSphere :: seeding (SQLite local)');

migrate();

// Wipe in FK-safe order so re-seeding is always clean.
for (const t of [
  'audit_log', 'notifications', 'user_badges', 'redemptions', 'participations', 'carbon_transactions',
  'compliance_issues', 'reports', 'esg_goals', 'challenges', 'badges', 'rewards',
  'policies', 'emission_factors', 'users', 'departments', 'settings',
]) {
  db.exec(`DELETE FROM ${t}`);
}

tx(() => {
  // --- Settings -------------------------------------------------------------
  const settings = [
    ['weight_environmental', '40'],
    ['weight_social', '30'],
    ['weight_governance', '30'],
    ['org_name', 'Vertex Industries Ltd.'],
    ['reporting_year', '2026'],
    ['auto_approve_threshold', '0.85'],
    ['ocr_auto_post_threshold', '0.80'],
    ['renewable_mix', '82'],
    ['erp_api_key', 'eco-erp-demo-key-2026'],
  ];
  for (const [k, v] of settings) run(`INSERT INTO settings (key, value) VALUES (?, ?)`, [k, v]);

  // --- Departments ----------------------------------------------------------
  const departments = [
    ['Manufacturing', 'MFG', 'Rajesh Iyer'],
    ['Logistics', 'LOG', 'Sara Chen'],
    ['Sales', 'SLS', 'Marcus Webb'],
    ['Information Technology', 'IT', 'Priya Sharma'],
    ['Corporate', 'CORP', 'Alex Rivera'],
    ['Research & Development', 'R&D', 'Dr. Lena Novak'],
  ];
  const deptId = {};
  for (const [name, code, head] of departments) {
    const { id } = run(
      `INSERT INTO departments (name, code, head, employee_count) VALUES (?, ?, ?, 0)`,
      [name, code, head]
    );
    deptId[code] = id;
  }

  // --- Emission factors (kg CO2e per unit) ----------------------------------
  const factors = [
    ['Electricity', 'Grid electricity', 'kWh', 0.716, 2, 'CEA India CO2 Baseline v19'],
    ['Electricity', 'Solar (on-site)', 'kWh', 0.041, 2, 'IPCC AR6 lifecycle'],
    ['Fuel', 'Diesel', 'litre', 2.68, 1, 'DEFRA 2024'],
    ['Fuel', 'Petrol', 'litre', 2.31, 1, 'DEFRA 2024'],
    ['Fuel', 'Natural gas', 'm3', 2.02, 1, 'DEFRA 2024'],
    ['Travel', 'Air travel', 'km', 0.154, 3, 'DEFRA 2024 (short-haul)'],
    ['Travel', 'Road freight', 'km', 0.107, 3, 'GLEC Framework v3'],
    ['Waste', 'Landfill waste', 'kg', 0.458, 3, 'DEFRA 2024'],
    ['Waste', 'Recycled waste', 'kg', 0.021, 3, 'DEFRA 2024'],
    ['Water', 'Water supply', 'm3', 0.344, 3, 'DEFRA 2024'],
  ];
  const factorId = {};
  for (const [category, activity, unit, f, scope, source] of factors) {
    const { id } = run(
      `INSERT INTO emission_factors (category, activity, unit, factor_kgco2e, scope, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [category, activity, unit, f, scope, source]
    );
    factorId[activity] = { id, factor: f, unit };
  }

  // --- Users ----------------------------------------------------------------
  const leads = [
    ['Alex Rivera', 'officer', 'CORP'], ['Priya Sharma', 'manager', 'IT'],
    ['Rajesh Iyer', 'manager', 'MFG'], ['Sara Chen', 'manager', 'LOG'],
    ['Marcus Webb', 'manager', 'SLS'], ['Dr. Lena Novak', 'manager', 'R&D'],
    ['Aditi Rao', 'employee', 'MFG'], ['Tom Baker', 'employee', 'MFG'],
    ['Wei Zhang', 'employee', 'MFG'], ['Nina Patel', 'employee', 'LOG'],
    ['Omar Haddad', 'employee', 'LOG'], ['Grace Kim', 'employee', 'SLS'],
    ['Diego Santos', 'employee', 'SLS'], ['Yuki Tanaka', 'employee', 'IT'],
    ['Ravi Menon', 'employee', 'IT'], ['Chloe Dubois', 'employee', 'CORP'],
    ['Ibrahim Sow', 'employee', 'R&D'], ['Hannah Cole', 'employee', 'R&D'],
    ['Luis Ortega', 'employee', 'MFG'], ['Fatima Noor', 'employee', 'LOG'],
    ['Ethan Brooks', 'employee', 'SLS'], ['Meera Joshi', 'employee', 'IT'],
  ];

  const HEADCOUNT = { MFG: 120, LOG: 60, SLS: 80, IT: 45, CORP: 30, 'R&D': 35 };
  const FIRST = ['Arjun','Maya','Kabir','Leila','Noah','Sofia','Rohan','Elena','Tariq','Ava','Jonas','Isha','Pedro','Anya','Samir','Clara','Dev','Nadia','Felix','Zara','Ravi','Mila','Owen','Divya','Hugo','Reem','Kian','Lucia','Amir','Freya'];
  const LAST  = ['Kapoor','Mendes','Okafor','Larsen','Ahmed','Rossi','Nakamura','Silva','Haas','Kowalski','Batista','Fischer','Nair','Duarte','Petrov','Osei','Lindqvist','Varga','Moreau','Bianchi','Sethi','Vargas','Jensen','Iqbal','Costa','Weber','Bhat','Ferreira','Novak','Adeyemi'];

  const DEMO_PASSWORD = 'eco1234';
  const demoHash = () => hashPassword(DEMO_PASSWORD);

  const userIds = [];
  const seen = new Set();
  const addUser = (name, role, code) => {
    let base = name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, '.');
    let email = `${base}@vertex.example`;
    let n = 2;
    while (seen.has(email)) email = `${base}${n++}@vertex.example`;
    seen.add(email);
    
    const dId = deptId[code];
    if (!dId) {
      throw new Error(`Department code ${code} not found in deptId. Available keys: ${Object.keys(deptId).join(', ')}`);
    }

    const { id } = run(
      `INSERT INTO users (name, email, role, department_id, xp, password_hash)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [name, email, role, dId, demoHash()]
    );
    userIds.push({ id, code, role, email });
  };

  for (const [name, role, code] of leads) addUser(name, role, code);

  for (const [code, target] of Object.entries(HEADCOUNT)) {
    const have = userIds.filter((u) => u.code === code).length;
    for (let i = have; i < target; i++) {
      addUser(`${pick(FIRST)} ${pick(LAST)}`, 'employee', code);
    }
  }

  // Headcount == rows.
  for (const code of Object.keys(deptId)) {
    run(`UPDATE departments SET employee_count = ? WHERE id = ?`, [
      userIds.filter((u) => u.code === code).length,
      deptId[code],
    ]);
  }

  // --- Carbon transactions: 12 months of activity ---------------------------
  const activityMix = {
    MFG: ['Grid electricity', 'Diesel', 'Natural gas', 'Landfill waste'],
    LOG: ['Diesel', 'Road freight', 'Petrol'],
    SLS: ['Air travel', 'Petrol', 'Grid electricity'],
    IT: ['Grid electricity', 'Solar (on-site)', 'Recycled waste'],
    CORP: ['Grid electricity', 'Air travel', 'Water supply'],
    'R&D': ['Grid electricity', 'Natural gas', 'Water supply'],
  };
  const baseVolume = { MFG: 3.0, LOG: 1.8, SLS: 1.0, IT: 0.6, CORP: 0.5, 'R&D': 0.7 };

  const addRow = (code, fId, days, co2, type = 'manual', documentRef = null, confidence = null) => {
    const activeDate = iso(daysAgo(days));
    const factor = factorId[fId];
    const qty = Math.round((co2 / factor.factor) * 10) / 10;
    const finalCo2 = Math.round(qty * factor.factor * 100) / 100;

    const uId = pick(userIds.filter((u) => u.code === code)).id;

    run(
      `INSERT INTO carbon_transactions (department_id, emission_factor_id, user_id, activity_date, quantity, co2e_kg, source, document_ref, ai_confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', datetime('now', ?))`,
      [deptId[code], factor.id, uId, activeDate, qty, finalCo2, type, documentRef, confidence, `-${days} days`]
    );
  };

  // Populate 365 days of activity
  for (let d = 360; d >= 0; d--) {
    const isWeekend = [0, 6].includes(daysAgo(d).getDay());
    const monthlyTrend = 1.0 - (360 - d) / 360 * 0.25; // 25% reduction over the year

    for (const [code, activities] of Object.entries(activityMix)) {
      if (isWeekend && code !== 'MFG') continue;

      const multiplier = between(0.7, 1.3) * baseVolume[code] * monthlyTrend;

      for (const act of activities) {
        if (rnd() > 0.85) continue; // skip some days

        let scale = 1.0;
        if (act === 'Grid electricity') scale = 1500;
        else if (act === 'Diesel') scale = 200;
        else if (act === 'Natural gas') scale = 300;
        else if (act === 'Water supply') scale = 80;
        else if (act === 'Air travel') scale = 2500;
        else if (act === 'Petrol') scale = 80;
        else if (act === 'Road freight') scale = 1200;
        else scale = 100;

        const co2 = multiplier * scale;

        // Make some of them OCR inputs
        const isOcr = rnd() > 0.90 && d > 5;
        const type = isOcr ? 'ocr' : 'manual';
        const doc = isOcr ? `bill-${code.toLowerCase()}-${act.toLowerCase().replace(/[^a-z]/g,'')}-${d}.pdf` : null;
        const conf = isOcr ? between(0.82, 0.98) : null;

        addRow(code, act, d, co2, type, doc, conf);
      }
    }
  }

  const windowEmissions = (code, fromDays, toDays) =>
    Math.round(
      (get(
        `SELECT COALESCE(SUM(co2e_kg), 0) AS kg FROM carbon_transactions
          WHERE department_id = ? AND status = 'verified'
            AND activity_date >= date('now', ?) AND activity_date < date('now', ?)`,
        [deptId[code], `-${fromDays} days`, `-${toDays} days`]
      ).kg /
        1000) *
        10
    ) / 10;

  // --- Goals ----------------------------------------------------------------
  const goals = [
    ['Scope 1 & 2 Reduction', 'MFG', 0.20, 90],
    ['Green Logistics Transition', 'LOG', 0.15, 120],
    ['Sustainable IT Operations', 'IT', 0.30, 90],
    ['R&D Carbon Efficiency', 'R&D', 0.25, 180],
    ['Net Zero Travel Policy', 'SLS', 0.40, 150],
    ['Zero Waste Headquarters', 'CORP', 0.50, 90],
  ];
  for (const [name, code, targetRed, daysLimit] of goals) {
    const base = windowEmissions(code, 360, 270);
    const target = Math.round(base * (1.0 - targetRed) * 10) / 10;
    const cur = windowEmissions(code, 90, 0);

    const deadline = iso(daysAgo(-daysLimit));
    const isMissed = daysLimit < 0;
    const isCompleted = cur <= target;

    let status = 'on_track';
    if (isCompleted) status = 'completed';
    else if (isMissed || cur > base * 1.1) status = 'at_risk';

    run(
      `INSERT INTO esg_goals (name, department_id, baseline_co2, target_co2, current_co2, deadline, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, deptId[code], base, target, cur, deadline, status]
    );
  }

  // --- Challenges -----------------------------------------------------------
  const challenges = [
    ['Cycle to Work', 'Commute', 'Ditch the car and bike to work this week.', 50, 100, 'directions_bike', 30, 0],
    ['Tree Plantation Drive', 'Tree Plantation', 'Plant a sapling at home or in your community.', 80, 150, 'park', 60, 30],
    ['Energy Audit', 'Energy Saving', 'Report three electrical items left on standby in your floor.', 30, 60, 'tungsten', 15, -10],
    ['Zero Plastic Week', 'Waste Reduction', 'Bring your own container for lunch every day.', 40, 80, 'eco', 7, -5],
    ['CSR ESG Seminar', 'ESG Workshop', 'Attend the corporate governance masterclass.', 25, 50, 'school', 1, -20],
    ['Beach Cleanup', 'Beach Cleanup', 'Join the weekend beach cleanup drive.', 100, 200, 'waves', 2, -45],
  ];
  const chalId = {};
  for (const [title, cat, desc, pts, xp, icon, duration, startOffset] of challenges) {
    const start = iso(daysAgo(startOffset + duration));
    const end = iso(daysAgo(startOffset));
    const status = startOffset < 0 ? 'closed' : 'open';

    const { id } = run(
      `INSERT INTO challenges (title, category, description, points, xp, icon, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, cat, desc, pts, xp, icon, start, end, status]
    );
    chalId[title] = { id, cat, pts, xp };
  }

  // --- Participations (Challenge Submissions) -------------------------------
  const approvedList = [];
  for (const u of userIds) {
    for (const [title, chal] of Object.entries(chalId)) {
      if (rnd() > 0.4) continue; // skip some challenge enrollments

      const isRndLead = leads.some(([name]) => name === u.name);
      const isPast = ['Energy Audit', 'CSR ESG Seminar', 'Beach Cleanup'].includes(title);

      const days = isPast ? between(10, 60) : between(1, 10);
      const submittedAt = iso(daysAgo(days));

      let status = 'approved';
      if (!isPast && rnd() > 0.8) status = 'pending';
      if (isRndLead && status === 'approved' && rnd() > 0.95) status = 'rejected';

      const isVerified = status === 'approved';
      const aiConf = isVerified ? between(0.86, 0.98) : between(0.40, 0.72);
      const aiReason = isVerified 
        ? `Verified: Visual match for "${chal.cat}" detected.` 
        : `Uncertain: Upload does not clearly show activity matching "${chal.cat}".`;

      const ptsAwarded = isVerified ? chal.pts : 0;
      const proofUrl = `/uploads/proof-${u.id}-${chal.id}.jpg`;

      run(
        `INSERT INTO participations (challenge_id, user_id, proof_url, status, ai_confidence, ai_reason, points_awarded, submitted_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?)`,
        [chal.id, u.id, proofUrl, status, aiConf, aiReason, ptsAwarded, `-${days} days`, isVerified ? submittedAt : null]
      );

      if (isVerified) {
        approvedList.push({ uId: u.id, points: chal.pts, xp: chal.xp, title });
      }
    }
  }

  // --- Badges ---------------------------------------------------------------
  const badges = [
    ['Eco Starter', 'Earned your first 100 XP.', 'energy_savings_leaf', 'bronze', 100],
    ['Carbon Crusader', 'Helped log emission records and verified PUE compliance.', 'co2', 'silver', 300],
    ['Susty Champ', 'Active in community beach cleanups and trees plantation drives.', 'volunteer_activism', 'gold', 600],
    ['ESG Ambassador', 'The highest level of corporate ESG governance leadership.', 'shield_with_heart', 'platinum', 1000],
  ];
  const badgeId = {};
  for (const [name, desc, icon, tier, xp] of badges) {
    const { id } = run(
      `INSERT INTO badges (name, description, icon, tier, xp_threshold) VALUES (?, ?, ?, ?, ?)`,
      [name, desc, icon, tier, xp]
    );
    badgeId[name] = { id, xp };
  }

  // --- Rewards --------------------------------------------------------------
  const rewards = [
    ['Organic Coffee Beans', '1kg ethically sourced single-origin medium roast.', 100, 15, 'active', 'coffee'],
    ['Bamboo Desk Organizer', 'Handcrafted modular workspace sustainability tray.', 250, 8, 'active', 'table_rows'],
    ['Solar Power Bank', '10,000mAh backup battery charged completely by solar cell.', 500, 4, 'active', 'solar_power'],
    ['1-on-1 Lunch with CEO', 'Discuss Vertex corporate sustainability future with the board.', 1500, 1, 'active', 'restaurant'],
    ['Tree Planting Dedicated Plate', 'A metal plate with your name on a newly planted sapling.', 150, 0, 'active', 'nature'],
  ];
  for (const [name, desc, pts, stock, status, icon] of rewards) {
    run(
      `INSERT INTO rewards (name, description, points_required, stock, status, icon)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, desc, pts, stock, status, icon]
    );
  }

  // --- Policies -------------------------------------------------------------
  const policies = [
    ['GRI Standard Disclosure Draft', 'GRI', 'v1.4', 'active', '2026-06-12'],
    ['BRSR India Disclosures', 'BRSR', 'v2.0', 'active', '2026-05-18'],
    ['TCFD Risk Alignment Strategy', 'TCFD', 'v1.1', 'active', '2026-04-10'],
    ['SASB Industrial Standards Audit', 'SASB', 'v3.0', 'draft', null],
  ];
  for (const [name, framework, ver, status, reviewed] of policies) {
    run(
      `INSERT INTO policies (name, framework, version, status, last_reviewed) VALUES (?, ?, ?, ?, ?)`,
      [name, framework, ver, status, reviewed]
    );
  }

  // --- Propagate XP, point balances, and badge allocations -------------------
  for (const u of userIds) {
    const history = approvedList.filter((a) => a.uId === u.id);
    const xp = history.reduce((s, a) => s + a.xp, 0);
    const pts = history.reduce((s, a) => s + a.points, 0);

    run(`UPDATE users SET xp = ?, points_balance = ? WHERE id = ?`, [xp, pts, u.id]);

    for (const [bName, b] of Object.entries(badgeId)) {
      if (xp >= b.xp) {
        const days = Math.round(between(10, 50));
        run(
          `INSERT INTO user_badges (user_id, badge_id, awarded_at) VALUES (?, ?, datetime('now', ?))`,
          [u.id, b.id, `-${days} days`]
        );
      }
    }
  }

  // --- Redemptions ----------------------------------------------------------
  for (const u of userIds) {
    const bal = get(`SELECT points_balance, name FROM users WHERE id = ?`, [u.id]);
    if (bal.points_balance > 150 && rnd() > 0.5) {
      const reward = get(`SELECT * FROM rewards WHERE stock > 0 AND points_required <= ?`, [bal.points_balance]);
      if (reward) {
        const days = Math.round(between(2, 20));
        run(`UPDATE rewards SET stock = stock - 1 WHERE id = ?`, [reward.id]);
        run(`UPDATE users SET points_balance = points_balance - ? WHERE id = ?`, [reward.points_required, u.id]);
        run(
          `INSERT INTO redemptions (reward_id, user_id, points_spent, status, redeemed_at)
           VALUES (?, ?, ?, 'confirmed', datetime('now', ?))`,
          [reward.id, u.id, reward.points_required, `-${days} days`]
        );
      }
    }
  }

  // --- Compliance Issues ----------------------------------------------------
  const compliance = [
    ['Data centre PUE not reported', 'IT', 'Priya Sharma', 'GRI', 'medium', 'open', 6, -15, null],
    ['Hazardous chemical handling audit', 'MFG', 'Rajesh Iyer', 'BRSR', 'critical', 'resolved', 20, -50, -42],
    ['Freight provider sustainability proof', 'LOG', 'Sara Chen', 'TCFD', 'high', 'in_progress', 15, -10, null],
    ['Gender pay gap report upload', 'CORP', 'Alex Rivera', 'BRSR', 'medium', 'resolved', 30, -90, -85],
    ['Scope 3 travel emission check', 'SLS', 'Marcus Webb', 'GRI', 'low', 'open', 45, 10, null],
    ['R&D Lab waste disposal audit', 'R&D', 'Dr. Lena Novak', 'GRI', 'high', 'open', 30, 20, null],
  ];
  for (const [title, code, owner, fw, sev, status, dueOffset, createdOffset, resolvedOffset] of compliance) {
    const ownerId = get(`SELECT id FROM users WHERE name = ?`, [owner]).id;
    const due = iso(daysAgo(-dueOffset));
    const created = iso(daysAgo(-createdOffset));
    const resolved = resolvedOffset ? iso(daysAgo(-resolvedOffset)) : null;

    run(
      `INSERT INTO compliance_issues (title, department_id, owner_id, framework, severity, status, due_date, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?)`,
      [title, deptId[code], ownerId, fw, sev, status, due, `${createdOffset} days`, resolved ? `datetime('now', '${resolvedOffset} days')` : null]
    );
  }

  // --- Reports --------------------------------------------------------------
  const reportList = [
    ['Q1 Environmental Performance', 'environmental', 'GRI', '2026-Q1', 1],
    ['BRSR India Board Disclosures', 'governance', 'BRSR', '2026-FY', 2],
    ['Vertex Social Engagement Index', 'social', 'GRI', '2026-H1', 1],
  ];
  for (const [title, type, fw, period, createdBy] of reportList) {
    const uId = pick(userIds).id;
    const days = Math.round(between(5, 80));
    run(
      `INSERT INTO reports (title, type, framework, period, status, snapshot, created_by, generated_at)
       VALUES (?, ?, ?, ?, 'ready', '{}', ?, datetime('now', ?))`,
      [title, type, fw, period, uId, `-${days} days`]
    );
  }

  // --- Notifications --------------------------------------------------------
  const notifs = [
    ['IT', 'badge', '🏅 Badge Unlocked: Eco Starter', 'Congratulations! You earned the bronze badge "Eco Starter".', 'military_tech', 0, '/gamification.html', 5],
    ['MFG', 'challenge', '✅ Challenge Approved: Tree Plantation Drive', 'Your submission was approved! You earned 80 points and 150 XP.', 'check_circle', 1, '/gamification.html', 8],
    ['IT', 'compliance', '⚠️ Overdue Task: PUE Compliance', 'Your department is past due on reporting server room cooling factor.', 'warning', 0, '/governance.html', 3],
  ];
  for (const [code, type, title, msg, icon, read, link, offset] of notifs) {
    const usersInDept = userIds.filter((u) => u.code === code);
    if (usersInDept.length > 0) {
      const uId = pick(usersInDept).id;
      run(
        `INSERT INTO notifications (user_id, type, title, message, icon, read, link, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
        [uId, type, title, msg, icon, read, link, `-${offset} days`]
      );
    }
  }

  // --- Audit logs -----------------------------------------------------------
  const logs = [
    ['Priya Sharma', 'login', 'user', 2, 'priya.sharma@vertex.example', 1],
    ['Rajesh Iyer', 'participation_approved', 'participation', 5, 'Tree Plantation Drive', 3],
    ['Alex Rivera', 'reward_redeemed', 'reward', 3, 'Alex Rivera redeemed "Solar Power Bank" for 500 points', 2],
  ];
  for (const [actor, action, ent, entId, detail, offset] of logs) {
    run(
      `INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
      [actor, action, ent, entId, detail, `-${offset} days`]
    );
  }
});

console.log('EcoSphere :: seed complete');
