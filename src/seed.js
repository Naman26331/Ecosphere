// Seeds a full year of believable ESG history.
//
// Deterministic on purpose: a seeded PRNG means `npm run reset` reproduces the
// exact same database every time, so the numbers you rehearse the demo against
// are the numbers on screen when you present.
import { migrate, run, all, get, tx } from './db.js';
import db from './db.js';

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

console.log('EcoSphere :: seeding');

migrate();

// Wipe in FK-safe order so re-seeding is always clean.
for (const t of [
  'audit_log', 'user_badges', 'participations', 'carbon_transactions',
  'compliance_issues', 'reports', 'esg_goals', 'challenges', 'badges',
  'policies', 'emission_factors', 'users', 'departments', 'settings',
]) {
  db.exec(`DELETE FROM ${t}`);
}

tx(() => {
  // --- Settings -------------------------------------------------------------
  // The 40/30/30 split lives here, not in code, so Settings can retune it.
  const settings = [
    ['weight_environmental', '40'],
    ['weight_social', '30'],
    ['weight_governance', '30'],
    ['org_name', 'Vertex Industries Ltd.'],
    ['reporting_year', '2026'],
    ['auto_approve_threshold', '0.85'], // AI confidence needed to skip human review
    ['ocr_auto_post_threshold', '0.80'],
    ['renewable_mix', '82'],
  ];
  for (const [k, v] of settings) run(`INSERT INTO settings (key, value) VALUES (?, ?)`, [k, v]);

  // --- Departments ----------------------------------------------------------
  // employee_count is written back from the real users table further down, so
  // the participation-rate denominator can never drift from the headcount.
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
  // The named leads appear on screen (leaderboards, issue owners, activity feed).
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

  // ...and the rest of the workforce is generated up to each department's target
  // headcount, because "% of employees participating" is only a real metric if
  // the employees actually exist as rows.
  const HEADCOUNT = { MFG: 120, LOG: 60, SLS: 80, IT: 45, CORP: 30, 'R&D': 35 };
  const FIRST = ['Arjun','Maya','Kabir','Leila','Noah','Sofia','Rohan','Elena','Tariq','Ava','Jonas','Isha','Pedro','Anya','Samir','Clara','Dev','Nadia','Felix','Zara','Ravi','Mila','Owen','Divya','Hugo','Reem','Kian','Lucia','Amir','Freya'];
  const LAST  = ['Kapoor','Mendes','Okafor','Larsen','Ahmed','Rossi','Nakamura','Silva','Haas','Kowalski','Batista','Fischer','Nair','Duarte','Petrov','Osei','Lindqvist','Varga','Moreau','Bianchi','Sethi','Vargas','Jensen','Iqbal','Costa','Weber','Bhat','Ferreira','Novak','Adeyemi'];

  const userIds = [];
  const seen = new Set();
  const addUser = (name, role, code) => {
    let base = name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, '.');
    let email = `${base}@vertex.example`;
    let n = 2;
    while (seen.has(email)) email = `${base}${n++}@vertex.example`; // collisions are inevitable
    seen.add(email);
    const { id } = run(
      `INSERT INTO users (name, email, role, department_id, xp) VALUES (?, ?, ?, ?, 0)`,
      [name, email, role, deptId[code]]
    );
    userIds.push({ id, code, role });
  };

  for (const [name, role, code] of leads) addUser(name, role, code);

  for (const [code, target] of Object.entries(HEADCOUNT)) {
    const have = userIds.filter((u) => u.code === code).length;
    for (let i = have; i < target; i++) {
      addUser(`${pick(FIRST)} ${pick(LAST)}`, 'employee', code);
    }
  }

  // Headcount == rows. Now participation_rate means what it says.
  for (const code of Object.keys(deptId)) {
    run(`UPDATE departments SET employee_count = ? WHERE id = ?`, [
      userIds.filter((u) => u.code === code).length,
      deptId[code],
    ]);
  }

  // --- Carbon transactions: 12 months of activity ---------------------------
  // Emissions trend downwards over the year so the "we are improving" story the
  // dashboard tells is actually present in the data, not asserted on top of it.
  const activityMix = {
    MFG: ['Grid electricity', 'Diesel', 'Natural gas', 'Landfill waste'],
    LOG: ['Diesel', 'Road freight', 'Petrol'],
    SLS: ['Air travel', 'Petrol', 'Grid electricity'],
    IT: ['Grid electricity', 'Solar (on-site)', 'Recycled waste'],
    CORP: ['Grid electricity', 'Air travel', 'Water supply'],
    'R&D': ['Grid electricity', 'Natural gas', 'Water supply'],
  };
  const baseVolume = { MFG: 3.0, LOG: 1.8, SLS: 1.0, IT: 0.6, CORP: 0.5, 'R&D': 0.7 };

  // Typical volume per logging cycle, before the department scale and decay.
  // Each department logs EVERY activity it runs, every cycle -- a plant meters
  // its electricity and its diesel and its gas. Picking one at random instead
  // made each department's series so lumpy that the downward trend vanished
  // into the noise, and goal progress became meaningless.
  const BASE_QTY = {
    'Grid electricity': 1500,
    'Solar (on-site)': 650,
    Diesel: 260,
    Petrol: 80,
    'Natural gas': 400,
    'Air travel': 1900,
    'Road freight': 1100,
    'Landfill waste': 375,
    'Recycled waste': 190,
    'Water supply': 60,
  };

  let txCount = 0;
  for (let day = 364; day >= 0; day -= 6) {
    // 0 = a year ago, 1 = today. Emissions decay 35% across the window -- a
    // steep but defensible corporate reduction, and steep enough that the signal
    // clears the month-to-month noise in the ledger.
    const progress = 1 - day / 364;
    const decay = 1 - 0.35 * progress;

    for (const code of Object.keys(activityMix)) {
      for (const activity of activityMix[code]) {
        if (rnd() > 0.8) continue; // the odd missed reading, as in real life

        const f = factorId[activity];
        // +/-15% jitter keeps it lifelike without drowning the trend.
        const scale = baseVolume[code] * decay * between(0.85, 1.15);
        const quantity = Math.round(BASE_QTY[activity] * scale);

        // Roughly 3 in 5 rows came in through the OCR pipeline rather than typing.
        const viaOcr = rnd() < 0.6;
        const conf = viaOcr ? between(0.82, 0.98) : null;
        const status = viaOcr && conf < 0.85 ? 'pending' : 'verified';
        const author = pick(userIds.filter((u) => u.code === code));

        run(
          `INSERT INTO carbon_transactions
             (department_id, emission_factor_id, user_id, activity_date, quantity,
              co2e_kg, source, document_ref, ai_confidence, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            deptId[code],
            f.id,
            author.id,
            iso(daysAgo(day)),
            quantity,
            Math.round(quantity * f.factor * 100) / 100,
            viaOcr ? 'ocr' : 'manual',
            viaOcr ? `${activity.toLowerCase().replace(/[^a-z]/g, '-')}-${iso(daysAgo(day))}.pdf` : null,
            conf ? Math.round(conf * 100) / 100 : null,
            status,
            iso(daysAgo(day)),
          ]
        );
        txCount++;
      }
    }
  }

  // --- Goals ----------------------------------------------------------------
  // Goals are measured on a 90-day run-rate, and BOTH numbers come out of the
  // ledger we just wrote:
  //   baseline_co2 = what this department emitted in its first 90-day window
  //   current_co2  = what it emitted in the last 90 days
  //   target_co2   = baseline minus the reduction this goal commits to
  // Deriving both from the same window is the whole point -- otherwise progress
  // compares an annual baseline against a quarterly actual and pins at 100%.
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

  // [name, dept, committed reduction vs baseline, deadline]
  // Emissions fall ~26% between the two windows, so a goal committing to less
  // than that lands "completed", one committing to far more is still in flight,
  // and the one whose deadline has already passed is "at risk". That spread is
  // deliberate: a board of goals that are all green is a board nobody believes.
  const goals = [
    ['EV Fleet Conversion', 'LOG', 0.28, iso(daysAgo(-240))],
    ['Logistics Decarbonisation', 'LOG', 0.32, iso(daysAgo(-172))],
    ['HQ Energy Retrofit', 'CORP', 0.36, iso(daysAgo(-40))],
    ['Zero Landfill Manufacturing', 'MFG', 0.40, iso(daysAgo(-120))],
    ['Renewable Power Purchase', 'IT', 0.45, iso(daysAgo(-90))],
    ['Scope 3 Supplier Audit', 'MFG', 0.60, iso(daysAgo(30))], // deadline already gone
  ];

  for (const [name, code, reduction, deadline] of goals) {
    const baseline = windowEmissions(code, 365, 275); // the same quarter, a year ago
    const current = windowEmissions(code, 90, 0);     // the quarter just gone
    const target = Math.round(baseline * (1 - reduction) * 10) / 10;

    // Status is computed, never authored.
    const span = baseline - target;
    const done = span > 0 ? (baseline - current) / span : 0;
    const overdue = new Date(deadline) < new Date();

    let status;
    if (current <= target) status = 'completed';
    else if (overdue || done < 0.25) status = 'at_risk';
    else if (done >= 0.55) status = 'on_track';
    else status = 'pending';

    run(
      `INSERT INTO esg_goals (name, department_id, baseline_co2, target_co2, current_co2, deadline, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, deptId[code], baseline, target, current, deadline, status]
    );
  }

  // --- Badges ---------------------------------------------------------------
  const badges = [
    ['First Step', 'Complete your first sustainability challenge', 'footprint', 'bronze', 50],
    ['Green Sprout', 'Reach 150 XP of verified impact', 'potted_plant', 'bronze', 150],
    ['Carbon Cutter', 'Reach 300 XP of verified impact', 'co2', 'silver', 300],
    ['Eco Warrior', 'Reach 600 XP of verified impact', 'shield_person', 'gold', 600],
    ['Planet Guardian', 'Reach 1000 XP of verified impact', 'public', 'platinum', 1000],
  ];
  for (const [name, desc, icon, tier, xp] of badges) {
    run(
      `INSERT INTO badges (name, description, icon, tier, xp_threshold) VALUES (?, ?, ?, ?, ?)`,
      [name, desc, icon, tier, xp]
    );
  }

  // --- Challenges -----------------------------------------------------------
  const challenges = [
    ['Tree Plantation Drive', 'Tree Plantation', 'Plant a sapling and upload a photo with the planted tree.', 100, 120, 'park'],
    ['Blood Donation Camp', 'Blood Donation', 'Donate blood at any certified camp and upload your donor slip.', 150, 180, 'bloodtype'],
    ['Beach Cleanup Sprint', 'Beach Cleanup', 'Join a shoreline cleanup. Upload a photo of collected waste.', 120, 140, 'waves'],
    ['ESG Foundations Workshop', 'ESG Workshop', 'Attend the 90-minute ESG foundations session.', 80, 90, 'school'],
    ['Zero-Emission Commute', 'Commute', 'Cycle, walk or take public transport for a full week.', 90, 100, 'directions_bike'],
    ['Circular Office Audit', 'Waste Reduction', 'Audit your floor’s waste segregation and log the findings.', 110, 130, 'recycling'],
    ['Energy Saver Pro', 'Energy Saving', 'Cut your workstation’s standby draw. Upload a meter reading.', 70, 80, 'bolt'],
  ];
  const challengeIds = [];
  for (const [title, category, desc, points, xp, icon] of challenges) {
    const { id } = run(
      `INSERT INTO challenges (title, category, description, points, xp, icon, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [title, category, desc, points, xp, icon, iso(daysAgo(60)), iso(daysAgo(-30))]
    );
    challengeIds.push({ id, points, xp });
  }

  // --- Participations -------------------------------------------------------
  // Some auto-approved by AI vision, some rejected, some still queued -- so the
  // Social approval screen has real work sitting in it during the demo.
  for (const u of userIds) {
    const n = Math.floor(between(0, 4.5));
    const taken = new Set();
    for (let i = 0; i < n; i++) {
      const c = pick(challengeIds);
      if (taken.has(c.id)) continue;
      taken.add(c.id);

      const roll = rnd();
      const status = roll < 0.66 ? 'approved' : roll < 0.85 ? 'pending' : 'rejected';
      const conf = status === 'approved' ? between(0.86, 0.99)
        : status === 'pending' ? between(0.55, 0.84)
        : between(0.1, 0.4);

      run(
        `INSERT INTO participations
           (challenge_id, user_id, proof_url, status, ai_confidence, ai_reason,
            points_awarded, submitted_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          u.id,
          `/uploads/proof-${c.id}-${u.id}.jpg`,
          status,
          Math.round(conf * 100) / 100,
          status === 'approved' ? 'Image contents match the challenge category.'
            : status === 'pending' ? 'Below auto-approval confidence, queued for review.'
            : 'Image contents do not match the challenge category.',
          status === 'approved' ? c.points : 0,
          iso(daysAgo(Math.floor(between(1, 55)))),
          status === 'pending' ? null : iso(daysAgo(Math.floor(between(0, 20)))),
        ]
      );

      if (status === 'approved') {
        run(`UPDATE users SET xp = xp + ? WHERE id = ?`, [c.xp, u.id]);
      }
    }
  }

  // Award every badge each user's XP has already earned.
  for (const u of userIds) {
    const { xp } = get(`SELECT xp FROM users WHERE id = ?`, [u.id]);
    for (const b of all(`SELECT id FROM badges WHERE xp_threshold <= ?`, [xp])) {
      run(
        `INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)`,
        [u.id, b.id]
      );
    }
  }

  // --- Policies -------------------------------------------------------------
  const policies = [
    ['Environmental Management Policy', 'GRI', '3.1', 'active'],
    ['Business Responsibility & Sustainability Report', 'BRSR', '2.0', 'active'],
    ['Climate Risk Disclosure', 'TCFD', '1.4', 'active'],
    ['Supplier Code of Conduct', 'SASB', '2.2', 'active'],
    ['Anti-Corruption Policy', 'GRI', '1.9', 'active'],
    ['Water Stewardship Standard', 'SASB', '0.9', 'draft'],
  ];
  for (const [name, fw, ver, status] of policies) {
    run(
      `INSERT INTO policies (name, framework, version, status, last_reviewed) VALUES (?, ?, ?, ?, ?)`,
      [name, fw, ver, status, iso(daysAgo(Math.floor(between(20, 200))))]
    );
  }

  // --- Compliance issues ----------------------------------------------------
  // A couple are deliberately left open and past due, so the governance score is
  // dented and the chatbot's "overdue issues in IT" question returns real rows.
  // dueOffset is days from today: negative = already past due.
  // Three are left genuinely overdue (two of them in IT) -- that is what the
  // chatbot's "overdue compliance issues in IT" question reads back.
  const issues = [
    ['Scope 3 supplier data incomplete', 'MFG', 'high', 'resolved', 30, 'GRI'],
    ['Waste manifest missing for Q2', 'MFG', 'medium', 'resolved', 21, 'BRSR'],
    ['Emissions logbook reconciliation', 'MFG', 'low', 'resolved', 44, 'GRI'],
    ['Hazardous storage recertification', 'MFG', 'medium', 'in_progress', 18, 'BRSR'],
    ['Vendor ESG questionnaire overdue', 'LOG', 'high', 'open', -14, 'SASB'],
    ['Fuel logbook reconciliation gap', 'LOG', 'low', 'resolved', 30, 'GRI'],
    ['Fleet emissions audit', 'LOG', 'medium', 'resolved', 26, 'TCFD'],
    ['Data centre PUE not reported', 'IT', 'medium', 'open', -6, 'TCFD'],
    ['Access review for ESG datastore', 'IT', 'critical', 'in_progress', -3, 'SASB'],
    ['E-waste disposal certificate pending', 'IT', 'medium', 'open', 14, 'BRSR'],
    ['Cloud carbon reporting enabled', 'IT', 'low', 'resolved', 35, 'GRI'],
    ['Board ESG training not logged', 'CORP', 'medium', 'resolved', 45, 'GRI'],
    ['Climate risk scenario refresh', 'CORP', 'high', 'in_progress', 22, 'TCFD'],
    ['Whistleblower policy review', 'CORP', 'medium', 'resolved', 52, 'GRI'],
    ['Travel emissions policy breach', 'SLS', 'low', 'resolved', 60, 'GRI'],
    ['Customer ESG claims unverified', 'SLS', 'medium', 'open', 9, 'SASB'],
    ['Sales collateral greenwashing check', 'SLS', 'medium', 'resolved', 33, 'SASB'],
    ['Lab chemical inventory audit', 'R&D', 'high', 'resolved', 15, 'BRSR'],
    ['Grant sustainability reporting', 'R&D', 'low', 'open', 28, 'GRI'],
    ['Material lifecycle assessment', 'R&D', 'medium', 'resolved', 40, 'TCFD'],
  ];
  for (const [title, code, severity, status, dueOffset, fw] of issues) {
    const owner = pick(userIds.filter((u) => u.code === code && u.role === 'manager')) ?? userIds[0];
    run(
      `INSERT INTO compliance_issues
         (title, department_id, owner_id, framework, severity, status, due_date, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title, deptId[code], owner.id, fw, severity, status,
        iso(daysAgo(-dueOffset)),
        iso(daysAgo(Math.floor(between(30, 120)))),
        status === 'resolved' ? iso(daysAgo(Math.floor(between(1, 25)))) : null,
      ]
    );
  }

  // --- Reports --------------------------------------------------------------
  const reports = [
    ['Q3 Carbon Emissions Detailed Analysis', 'environmental', 'GRI', 'Q3 2026'],
    ['Annual DEI Milestone Report', 'social', 'BRSR', 'FY 2026'],
    ['Governance Compliance Audit 2026', 'governance', 'SASB', 'FY 2026'],
    ['Scope 1-2-3 Inventory Summary', 'environmental', 'TCFD', 'H1 2026'],
  ];
  for (const [title, type, fw, period] of reports) {
    run(
      `INSERT INTO reports (title, type, framework, period, status, created_by, generated_at)
       VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
      [title, type, fw, period, userIds[0].id, iso(daysAgo(Math.floor(between(2, 40))))]
    );
  }

  // --- Realign goal.current_co2 with the transactions we just wrote ----------
  // Goals must agree with the ledger. Anything else and the demo contradicts itself.
  for (const g of all(`SELECT id, department_id, baseline_co2, target_co2 FROM esg_goals`)) {
    if (!g.department_id) continue;
    const { kg } = get(
      `SELECT COALESCE(SUM(co2e_kg), 0) AS kg FROM carbon_transactions
        WHERE department_id = ? AND status = 'verified'
          AND activity_date >= date('now', '-90 days')`,
      [g.department_id]
    );
    const current = Math.round((kg / 1000) * 10) / 10; // -> tCO2e
    if (g.target_co2 > 0 && current > 0) {
      run(`UPDATE esg_goals SET current_co2 = ? WHERE id = ?`, [current, g.id]);
    }
  }

  // --- Audit log ------------------------------------------------------------
  run(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
     VALUES ('system', 'seed', 'database', NULL, 'Initial dataset provisioned')`
  );
});

const counts = {
  departments: get(`SELECT COUNT(*) n FROM departments`).n,
  users: get(`SELECT COUNT(*) n FROM users`).n,
  emission_factors: get(`SELECT COUNT(*) n FROM emission_factors`).n,
  carbon_transactions: get(`SELECT COUNT(*) n FROM carbon_transactions`).n,
  goals: get(`SELECT COUNT(*) n FROM esg_goals`).n,
  challenges: get(`SELECT COUNT(*) n FROM challenges`).n,
  participations: get(`SELECT COUNT(*) n FROM participations`).n,
  badges_awarded: get(`SELECT COUNT(*) n FROM user_badges`).n,
  compliance_issues: get(`SELECT COUNT(*) n FROM compliance_issues`).n,
};
console.table(counts);
console.log('EcoSphere :: seed complete');
