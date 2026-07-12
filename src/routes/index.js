// Every API route in the platform.
//
// Handlers just return a value -- the router serialises it as JSON. Throwing an
// error with a `status` property produces that HTTP status; anything else
// becomes a 500. That keeps the happy path in each handler uncluttered.
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { all, get, run, tx, audit } from '../db.js';
import * as esg from '../lib/esg.js';
import * as gamify from '../lib/gamify.js';
import * as ai from '../ai/index.js';
import * as auth from '../lib/auth.js';
import { readJson, readMultipart } from '../lib/http.js';

const UPLOADS = join(process.cwd(), 'data', 'uploads');
mkdirSync(UPLOADS, { recursive: true });

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Persist an upload and hand back the URL the browser will load it from. */
function saveUpload(file) {
  const ext = (file.filename.match(/\.[A-Za-z0-9]+$/) ?? ['.bin'])[0].toLowerCase();
  const name = `${randomUUID()}${ext}`;
  writeFileSync(join(UPLOADS, name), file.data);
  return `/uploads/${name}`;
}

export default function registerRoutes(r) {
  // =========================================================================
  // AUTH
  // =========================================================================

  /** Log in with the email + password held in the users table. */
  r.post('/api/auth/login', async (req, res) => {
    const { email, password } = await readJson(req);
    if (!email || !password) throw bad('Email and password are required');

    const { token, user } = auth.login(email, password); // throws 401 if wrong

    res.setHeader('Set-Cookie', auth.sessionCookie(token));
    audit(user.name, 'login', 'user', user.id, user.email);
    return { user };
  });

  r.post('/api/auth/logout', (req, res) => {
    const user = auth.currentUser(req);
    if (user) audit(user.name, 'logout', 'user', user.id, user.email);
    res.setHeader('Set-Cookie', auth.clearCookie());
    return { ok: true };
  });

  /** Who am I? The shell calls this on every page to render the real user. */
  r.get('/api/auth/me', (req) => {
    const user = auth.currentUser(req);
    if (!user) throw bad('Not signed in', 401);
    return { user };
  });

  // =========================================================================
  // DASHBOARD
  // =========================================================================

  r.get('/api/dashboard', () => {
    const o = esg.overall();
    const ytd = get(
      `SELECT ROUND(COALESCE(SUM(co2e_kg), 0) / 1000.0, 1) AS tco2e
         FROM carbon_transactions
        WHERE status = 'verified' AND activity_date >= date('now', 'start of year')`
    ).tco2e;

    // How much of the ledger the AI pipeline built without anyone typing.
    const auto = get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN source = 'ocr' THEN 1 ELSE 0 END) AS ocr
         FROM carbon_transactions`
    );

    return {
      org: get(`SELECT value FROM settings WHERE key = 'org_name'`)?.value ?? 'EcoSphere',
      score: o.score,
      pillars: {
        environmental: o.environmental,
        social: o.social,
        governance: o.governance,
      },
      weights: o.weights,
      leaderboard: esg.leaderboard(),
      trend: esg.emissionsTrend(6),
      stats: {
        emissions_ytd_tco2e: ytd,
        transactions: auto.total,
        ocr_automated_pct: auto.total ? Math.round((auto.ocr / auto.total) * 100) : 0,
        open_issues: get(
          `SELECT COUNT(*) AS n FROM compliance_issues WHERE status <> 'resolved'`
        ).n,
        pending_reviews: get(
          `SELECT COUNT(*) AS n FROM participations WHERE status = 'pending'`
        ).n,
        active_employees: get(
          `SELECT COUNT(DISTINCT user_id) AS n FROM participations WHERE status = 'approved'`
        ).n,
      },
      activity: all(
        `SELECT actor, action, entity, detail, created_at
           FROM audit_log ORDER BY id DESC LIMIT 8`
      ),
    };
  });

  r.get('/api/departments', () =>
    all(`SELECT id, name, code, head, employee_count FROM departments ORDER BY name`)
  );

  r.get('/api/audit-log', () =>
    all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 100`)
  );

  // =========================================================================
  // ENVIRONMENTAL
  // =========================================================================

  r.get('/api/environmental', () => {
    const e = esg.environmental();
    const byCategory = all(
      `SELECT ef.category,
              ROUND(SUM(ct.co2e_kg) / 1000.0, 2) AS tco2e,
              ef.scope
         FROM carbon_transactions ct
         JOIN emission_factors ef ON ef.id = ct.emission_factor_id
        WHERE ct.status = 'verified'
        GROUP BY ef.category ORDER BY tco2e DESC`
    );
    const byScope = all(
      `SELECT 'Scope ' || ef.scope AS scope,
              ROUND(SUM(ct.co2e_kg) / 1000.0, 2) AS tco2e
         FROM carbon_transactions ct
         JOIN emission_factors ef ON ef.id = ct.emission_factor_id
        WHERE ct.status = 'verified'
        GROUP BY ef.scope ORDER BY ef.scope`
    );
    return {
      score: e.score,
      kpis: e.kpis,
      trend: esg.emissionsTrend(12),
      byCategory,
      byScope,
      renewableMix: Number(
        get(`SELECT value FROM settings WHERE key = 'renewable_mix'`)?.value ?? 0
      ),
      // "Avoided emissions" = what we'd have emitted had we stayed at baseline.
      avoided: (() => {
        const goals = all(`SELECT baseline_co2, current_co2 FROM esg_goals`);
        const saved = goals.reduce((s, g) => s + Math.max(0, g.baseline_co2 - g.current_co2), 0);
        return { tco2e: Math.round(saved * 10) / 10, trees: Math.round((saved * 1000) / 21) };
      })(),
    };
  });

  r.get('/api/goals', () =>
    all(
      `SELECT g.*, d.name AS department,
              ROUND(
                CASE WHEN g.baseline_co2 - g.target_co2 > 0
                     THEN MIN(100.0, MAX(0.0,
                       (g.baseline_co2 - g.current_co2) * 100.0 / (g.baseline_co2 - g.target_co2)))
                     ELSE 100.0 END, 1) AS progress
         FROM esg_goals g LEFT JOIN departments d ON d.id = g.department_id
        ORDER BY g.deadline`
    )
  );

  r.post('/api/goals', async (req) => {
    const b = await readJson(req);
    if (!b.name || !b.deadline) throw bad('name and deadline are required');

    const baseline = num(b.baseline_co2) ?? 0;
    const target = num(b.target_co2) ?? 0;
    const current = num(b.current_co2) ?? baseline;
    if (baseline < target) throw bad('baseline_co2 must be greater than target_co2');

    const { id } = run(
      `INSERT INTO esg_goals
         (name, department_id, baseline_co2, target_co2, current_co2, deadline, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [b.name, num(b.department_id), baseline, target, current, b.deadline]
    );
    audit(b.actor ?? 'Alex Rivera', 'goal_created', 'esg_goal', id, b.name);
    return get(`SELECT * FROM esg_goals WHERE id = ?`, [id]);
  });

  r.get('/api/emission-factors', () =>
    all(`SELECT * FROM emission_factors ORDER BY category, activity`)
  );

  r.get('/api/carbon-transactions', (req) => {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 200);
    const dept = url.searchParams.get('department_id');
    return all(
      `SELECT ct.id, ct.activity_date, ct.quantity, ct.co2e_kg, ct.source,
              ct.status, ct.ai_confidence, ct.document_ref,
              ef.activity, ef.unit, ef.category, ef.scope,
              d.name AS department, u.name AS logged_by
         FROM carbon_transactions ct
         JOIN emission_factors ef ON ef.id = ct.emission_factor_id
         JOIN departments d       ON d.id = ct.department_id
         LEFT JOIN users u        ON u.id = ct.user_id
        WHERE 1=1 ${dept ? 'AND ct.department_id = ?' : ''}
        -- Entry order, not activity date. It's an append-only ledger, so the row
        -- you just posted belongs at the top -- a bill for last month would
        -- otherwise be buried under this month's rows and look like it vanished.
        ORDER BY ct.id DESC
        LIMIT ?`,
      dept ? [Number(dept), limit] : [limit]
    );
  });

  /** Manual entry. The OCR route below does the same thing without the typing. */
  r.post('/api/carbon-transactions', async (req) => {
    const b = await readJson(req);
    const factor = get(`SELECT * FROM emission_factors WHERE id = ?`, [num(b.emission_factor_id)]);
    if (!factor) throw bad('Unknown emission_factor_id');
    const quantity = num(b.quantity);
    if (!quantity || quantity <= 0) throw bad('quantity must be a positive number');

    const co2e = Math.round(quantity * factor.factor_kgco2e * 100) / 100;
    const { id } = run(
      `INSERT INTO carbon_transactions
         (department_id, emission_factor_id, user_id, activity_date, quantity,
          co2e_kg, source, status)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 'verified')`,
      [
        num(b.department_id),
        factor.id,
        num(b.user_id),
        b.activity_date ?? new Date().toISOString().slice(0, 10),
        quantity,
        co2e,
      ]
    );
    audit(b.actor ?? 'Alex Rivera', 'transaction_logged', 'carbon_transaction', id,
      `${quantity} ${factor.unit} ${factor.activity} = ${co2e} kgCO2e`);
    return { id, co2e_kg: co2e, factor: factor.factor_kgco2e, activity: factor.activity };
  });

  // =========================================================================
  // AI PIPELINE
  // =========================================================================

  /**
   * Upload a utility bill / fuel receipt -> OCR -> emission factor -> ledger row.
   * This is the "no manual typing" path: the only human action is choosing a file.
   */
  r.post('/api/ai/scan-bill', async (req) => {
    const { fields, files } = await readMultipart(req);
    const file = files.find((f) => f.field === 'document') ?? files[0];
    if (!file) throw bad('No document uploaded');

    // 1. AI reads the numbers off the page.
    const x = ai.extractBill(file);

    // 2. Match what it read to the emission factor that prices it in CO2e.
    const factor =
      get(`SELECT * FROM emission_factors WHERE activity = ?`, [x.activity]) ??
      get(`SELECT * FROM emission_factors WHERE unit = ? LIMIT 1`, [x.unit]);
    if (!factor) throw bad(`No emission factor configured for "${x.activity}"`);

    // 3. Do the arithmetic the user would otherwise do by hand.
    const co2e = Math.round(x.quantity * factor.factor_kgco2e * 100) / 100;

    // 4. Confident reads post straight to the ledger; shaky ones wait for a human.
    const threshold = Number(
      get(`SELECT value FROM settings WHERE key = 'ocr_auto_post_threshold'`)?.value ?? 0.8
    );
    const status = x.confidence >= threshold ? 'verified' : 'pending';

    const docRef = saveUpload(file);
    const { id } = run(
      `INSERT INTO carbon_transactions
         (department_id, emission_factor_id, user_id, activity_date, quantity,
          co2e_kg, source, document_ref, ai_confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ocr', ?, ?, ?)`,
      [
        num(fields.department_id) ?? 1,
        factor.id,
        num(fields.user_id),
        x.period ? `${x.period}-01` : new Date().toISOString().slice(0, 10),
        x.quantity,
        co2e,
        docRef,
        x.confidence,
        status,
      ]
    );

    audit(fields.actor ?? 'AI Pipeline', 'ocr_transaction', 'carbon_transaction', id,
      `${file.filename}: ${x.quantity} ${factor.unit} ${factor.activity} -> ${co2e} kgCO2e`);

    return {
      id,
      status,
      provider: ai.providerName,
      extracted: {
        activity: x.activity,
        quantity: x.quantity,
        unit: factor.unit,
        vendor: x.vendor,
        period: x.period,
        confidence: x.confidence,
        readFromDocument: x.extracted,
      },
      factor: { value: factor.factor_kgco2e, unit: factor.unit, source: factor.source },
      co2e_kg: co2e,
      message:
        status === 'verified'
          ? `Posted ${co2e} kgCO2e to the ledger automatically.`
          : `Confidence ${(x.confidence * 100).toFixed(0)}% is below the ${(threshold * 100).toFixed(0)}% auto-post bar — held for review.`,
    };
  });

  /** Ask the ESG data a question in plain English. */
  r.post('/api/ai/chat', async (req) => {
    const { question } = await readJson(req);
    if (!question || !question.trim()) throw bad('question is required');
    const res = ai.askChatbot(question);
    return { ...res, provider: ai.providerName, question };
  });

  // =========================================================================
  // SOCIAL + GAMIFICATION
  // =========================================================================

  r.get('/api/social', () => {
    const s = esg.social();
    return {
      score: s.score,
      kpis: s.kpis,
      byCategory: all(
        `SELECT c.category,
                COUNT(p.id) AS submissions,
                SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved
           FROM challenges c LEFT JOIN participations p ON p.challenge_id = c.id
          GROUP BY c.category ORDER BY submissions DESC`
      ),
      pendingReviews: get(
        `SELECT COUNT(*) AS n FROM participations WHERE status = 'pending'`
      ).n,
    };
  });

  r.get('/api/challenges', () =>
    all(
      `SELECT c.*,
              COUNT(p.id) AS submissions,
              SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved
         FROM challenges c LEFT JOIN participations p ON p.challenge_id = c.id
        GROUP BY c.id ORDER BY c.status, c.id`
    )
  );

  r.get('/api/participations', (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status');
    return all(
      `SELECT p.id, p.status, p.ai_confidence, p.ai_reason, p.proof_url,
              p.points_awarded, p.submitted_at,
              u.name AS employee, d.name AS department,
              c.title AS challenge, c.category, c.points, c.icon
         FROM participations p
         JOIN users u      ON u.id = p.user_id
         JOIN challenges c ON c.id = p.challenge_id
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE 1=1 ${status ? 'AND p.status = ?' : ''}
        ORDER BY p.submitted_at DESC LIMIT 50`,
      status ? [status] : []
    );
  });

  /**
   * Employees who have NOT yet submitted proof for this challenge.
   * The submit form is populated from this, so the one-submission-per-person
   * rule is enforced by the UI never offering an impossible choice -- rather
   * than by the user discovering it as an error after they've picked a photo.
   */
  r.get('/api/challenges/:id/eligible', (req) =>
    all(
      `SELECT u.id, u.name, u.xp, d.name AS department
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.id NOT IN (SELECT user_id FROM participations WHERE challenge_id = ?)
        ORDER BY u.xp DESC, u.name
        LIMIT 15`,
      [Number(req.params.id)]
    )
  );

  /**
   * Submit challenge proof. AI vision checks the photo against the challenge
   * category; a confident match auto-approves (points + XP + badges, all in one
   * transaction). Anything less goes to a manager -- the AI never has the last
   * word on a rejection.
   */
  r.post('/api/challenges/:id/submit', async (req) => {
    const challengeId = Number(req.params.id);
    const { fields, files } = await readMultipart(req);
    const file = files.find((f) => f.field === 'proof') ?? files[0];
    if (!file) throw bad('No proof photo uploaded');

    const challenge = get(`SELECT * FROM challenges WHERE id = ?`, [challengeId]);
    if (!challenge) throw bad('Unknown challenge', 404);

    const userId = num(fields.user_id);
    if (!userId) throw bad('user_id is required');
    if (get(`SELECT id FROM participations WHERE challenge_id = ? AND user_id = ?`, [challengeId, userId])) {
      throw bad('You have already submitted proof for this challenge', 409);
    }

    const v = ai.verifyPhoto(file, challenge.category);
    const threshold = gamify.autoApproveThreshold();
    const autoApprove = v.match && v.confidence >= threshold;
    const proofUrl = saveUpload(file);

    // Always land as pending (or rejected outright). If the AI is confident,
    // gamify.approve() promotes it a line later -- so points, XP and badges are
    // only ever minted in that one place, never here.
    const { id } = run(
      `INSERT INTO participations
         (challenge_id, user_id, proof_url, status, ai_confidence, ai_reason, points_awarded)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [challengeId, userId, proofUrl, v.match ? 'pending' : 'rejected', v.confidence, v.reason]
    );

    let award = null;
    if (autoApprove) award = gamify.approve(id, 'AI Vision');

    audit(
      'AI Vision', autoApprove ? 'proof_auto_approved' : v.match ? 'proof_queued' : 'proof_rejected',
      'participation', id,
      `${challenge.title}: ${(v.confidence * 100).toFixed(0)}% — ${v.reason}`
    );

    return {
      id,
      provider: ai.providerName,
      verification: v,
      autoApproved: autoApprove,
      status: get(`SELECT status FROM participations WHERE id = ?`, [id]).status,
      award,
      message: autoApprove
        ? `Verified at ${(v.confidence * 100).toFixed(0)}% confidence. ${award.pointsAwarded} points and ${award.xpAwarded} XP awarded${award.newBadges.length ? `, and you unlocked "${award.newBadges.map((b) => b.name).join('", "')}"!` : '.'}`
        : v.match
          ? `Submitted at ${(v.confidence * 100).toFixed(0)}% confidence — below the ${(threshold * 100).toFixed(0)}% auto-approval bar, so a manager will review it.`
          : `We couldn't match this photo to "${challenge.category}". ${v.reason}`,
    };
  });

  /** Manager override. This is what makes the AI advisory rather than final. */
  r.post('/api/participations/:id/review', async (req) => {
    const id = Number(req.params.id);
    const b = await readJson(req);
    const actor = b.actor ?? 'Alex Rivera';
    if (b.decision === 'approve') return gamify.approve(id, actor);
    if (b.decision === 'reject') return gamify.reject(id, b.reason, actor);
    throw bad("decision must be 'approve' or 'reject'");
  });

  r.get('/api/leaderboard', () => ({
    departments: esg.leaderboard(),
    employees: gamify.topEmployees(10),
  }));

  r.get('/api/badges', () =>
    all(
      `SELECT b.*, COUNT(ub.user_id) AS holders
         FROM badges b LEFT JOIN user_badges ub ON ub.badge_id = b.id
        GROUP BY b.id ORDER BY b.xp_threshold`
    )
  );

  // =========================================================================
  // REWARDS
  // =========================================================================

  /**
   * The catalog, plus what the SIGNED-IN user can actually do with it.
   * `affordable` / `canRedeem` are computed server-side against req.user, so the
   * button state can't be talked into lying by editing the page.
   */
  r.get('/api/rewards', (req) => {
    const me = req.user;
    const rewards = all(
      `SELECT rw.*,
              (SELECT COUNT(*) FROM redemptions rd WHERE rd.reward_id = rw.id) AS redeemed_count
         FROM rewards rw
        ORDER BY rw.status = 'inactive', rw.points_required`
    );
    const balance = me?.points_balance ?? 0;

    return {
      me: { id: me.id, name: me.name, points_balance: balance, xp: me.xp },
      rewards: rewards.map((rw) => ({
        ...rw,
        in_stock: rw.stock > 0,
        affordable: balance >= rw.points_required,
        canRedeem: rw.status === 'active' && rw.stock > 0 && balance >= rw.points_required,
        short_by: Math.max(0, rw.points_required - balance),
      })),
    };
  });

  /** Redeem. The user comes from the session -- never from the request body. */
  r.post('/api/rewards/:id/redeem', (req) => {
    const me = req.user;
    const result = gamify.redeem(Number(req.params.id), me.id, me.name);
    return {
      ...result,
      message: `Redeemed "${result.reward.name}" for ${result.pointsSpent} points. ${result.pointsBalance} points left.`,
    };
  });

  /** Redemption history. `?mine=true` for just the signed-in user. */
  r.get('/api/redemptions', (req) => {
    const url = new URL(req.url, 'http://localhost');
    const mine = url.searchParams.get('mine') === 'true';
    return all(
      `SELECT rd.id, rd.points_spent, rd.status, rd.redeemed_at,
              rw.name AS reward, rw.icon,
              u.name AS employee, d.name AS department
         FROM redemptions rd
         JOIN rewards rw ON rw.id = rd.reward_id
         JOIN users u    ON u.id = rd.user_id
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE 1=1 ${mine ? 'AND rd.user_id = ?' : ''}
        ORDER BY rd.id DESC LIMIT 20`,
      mine ? [req.user.id] : []
    );
  });

  // =========================================================================
  // GOVERNANCE
  // =========================================================================

  r.get('/api/governance', () => {
    const g = esg.governance();
    return {
      score: g.score,
      kpis: g.kpis,
      counts: g.counts,
      bySeverity: all(
        `SELECT severity, COUNT(*) AS n FROM compliance_issues
          WHERE status <> 'resolved' GROUP BY severity`
      ),
      byFramework: all(
        `SELECT framework,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
           FROM compliance_issues GROUP BY framework ORDER BY framework`
      ),
      policies: all(`SELECT * FROM policies ORDER BY framework, name`),
    };
  });

  r.get('/api/compliance-issues', (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status');
    const overdue = url.searchParams.get('overdue') === 'true';
    return all(
      `SELECT ci.*, d.name AS department, u.name AS owner,
              CASE WHEN ci.status <> 'resolved' AND ci.due_date < date('now')
                   THEN 1 ELSE 0 END AS is_overdue
         FROM compliance_issues ci
         LEFT JOIN departments d ON d.id = ci.department_id
         LEFT JOIN users u       ON u.id = ci.owner_id
        WHERE 1=1
          ${status ? 'AND ci.status = ?' : ''}
          ${overdue ? "AND ci.status <> 'resolved' AND ci.due_date < date('now')" : ''}
        ORDER BY is_overdue DESC,
                 CASE ci.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                                  WHEN 'medium' THEN 3 ELSE 4 END,
                 ci.due_date`,
      status ? [status] : []
    );
  });

  r.patch('/api/compliance-issues/:id', async (req) => {
    const id = Number(req.params.id);
    const b = await readJson(req);
    const issue = get(`SELECT * FROM compliance_issues WHERE id = ?`, [id]);
    if (!issue) throw bad('Issue not found', 404);
    if (!['open', 'in_progress', 'resolved'].includes(b.status)) throw bad('Invalid status');

    run(
      `UPDATE compliance_issues
          SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END
        WHERE id = ?`,
      [b.status, b.status, id]
    );
    audit(b.actor ?? 'Alex Rivera', 'issue_status_changed', 'compliance_issue', id,
      `${issue.status} -> ${b.status}: ${issue.title}`);
    return get(`SELECT * FROM compliance_issues WHERE id = ?`, [id]);
  });

  // =========================================================================
  // REPORTS
  // =========================================================================

  r.get('/api/reports', () =>
    all(
      `SELECT r.*, u.name AS author FROM reports r
       LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.generated_at DESC`
    )
  );

  /**
   * Custom report builder. Assembles a real snapshot from live tables rather
   * than a placeholder file, so "Generate" produces something with content in it.
   */
  r.post('/api/reports', async (req) => {
    const b = await readJson(req);
    if (!b.title) throw bad('title is required');
    const type = b.type ?? 'custom';

    const o = esg.overall(num(b.department_id));
    const snapshot = {
      generated: new Date().toISOString(),
      scope: b.department_id
        ? get(`SELECT name FROM departments WHERE id = ?`, [num(b.department_id)])?.name
        : 'Organisation-wide',
      overall: o.score,
      environmental: o.environmental,
      social: o.social,
      governance: o.governance,
      emissions: esg.emissionsTrend(12, num(b.department_id)),
    };

    // Freeze the snapshot onto the row. Re-opening this report next quarter must
    // show what it said today, not today's numbers recomputed.
    const { id } = run(
      `INSERT INTO reports (title, type, framework, period, status, snapshot, created_by)
       VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
      [b.title, type, b.framework ?? 'GRI', b.period ?? 'Custom', JSON.stringify(snapshot), num(b.user_id) ?? 1]
    );
    audit(b.actor ?? 'Alex Rivera', 'report_generated', 'report', id, b.title);
    return { id, title: b.title, snapshot };
  });

  r.get('/api/reports/:id', (req) => {
    const report = get(`SELECT * FROM reports WHERE id = ?`, [Number(req.params.id)]);
    if (!report) throw bad('Report not found', 404);

    // Seeded reports predate the snapshot column; fall back to a live computation
    // for those, but anything generated through the builder replays exactly.
    if (report.snapshot) return { ...report, snapshot: JSON.parse(report.snapshot) };

    const o = esg.overall();
    return {
      ...report,
      snapshot: {
        scope: 'Organisation-wide',
        overall: o.score,
        environmental: o.environmental,
        social: o.social,
        governance: o.governance,
        emissions: esg.emissionsTrend(12),
        live: true, // this one was reconstructed, not replayed
      },
    };
  });

  // =========================================================================
  // SETTINGS
  // =========================================================================

  r.get('/api/settings', () => {
    const rows = all(`SELECT key, value FROM settings ORDER BY key`);
    return {
      settings: Object.fromEntries(rows.map((s) => [s.key, s.value])),
      departments: all(`SELECT id, name, code, head, employee_count FROM departments ORDER BY name`),
      emissionFactors: all(`SELECT * FROM emission_factors ORDER BY category, activity`),
      badges: all(`SELECT * FROM badges ORDER BY xp_threshold`),
    };
  });

  /**
   * Update settings. The pillar weights are validated to sum to 100 -- an ESG
   * score built on weights that don't add up is not a score.
   */
  r.put('/api/settings', async (req) => {
    const b = await readJson(req);
    const entries = Object.entries(b.settings ?? {});
    if (!entries.length) throw bad('No settings supplied');

    const w = ['weight_environmental', 'weight_social', 'weight_governance'];
    if (w.some((k) => k in b.settings)) {
      const current = Object.fromEntries(
        all(`SELECT key, value FROM settings WHERE key LIKE 'weight_%'`).map((s) => [s.key, s.value])
      );
      const merged = w.map((k) => Number(b.settings[k] ?? current[k] ?? 0));
      const total = merged.reduce((a, c) => a + c, 0);
      if (Math.round(total) !== 100) {
        throw bad(`Pillar weights must total 100 (got ${total})`);
      }
    }

    tx(() => {
      for (const [k, v] of entries) {
        run(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [k, String(v)]
        );
      }
    });
    audit(b.actor ?? 'Alex Rivera', 'settings_updated', 'settings', null,
      entries.map(([k, v]) => `${k}=${v}`).join(', '));

    return Object.fromEntries(all(`SELECT key, value FROM settings`).map((s) => [s.key, s.value]));
  });

  r.get('/api/health', () => ({
    ok: true,
    provider: ai.providerName,
    transactions: get(`SELECT COUNT(*) AS n FROM carbon_transactions`).n,
  }));
}
