// The ESG scoring engine.
//
// Every score in the UI comes out of this file -- nothing is hardcoded in the
// pages. Each pillar is built from named KPIs that are each normalised to
// 0..100, then averaged with the weights below. The API returns the KPI
// breakdown alongside the score so the dashboard can show its working.
import { all, get } from '../db.js';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const pct = (num, den) => (den > 0 ? (num / den) * 100 : 0);
const round1 = (n) => Math.round(n * 10) / 10;

// Weights inside each pillar. Tuned so no single KPI can carry a bad quarter.
const E_WEIGHTS = { goal_attainment: 0.5, emission_trend: 0.3, data_coverage: 0.2 };
const S_WEIGHTS = { participation_rate: 0.5, verification_rate: 0.3, engagement: 0.2 };
const G_WEIGHTS = { resolution_rate: 0.5, timeliness: 0.3, policy_coverage: 0.2 };

/** Pillar weights (40/30/30 by default) live in `settings` so Settings can tune them. */
export function pillarWeights() {
  const rows = all(`SELECT key, value FROM settings WHERE key LIKE 'weight_%'`);
  const w = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  const e = w.weight_environmental ?? 40;
  const s = w.weight_social ?? 30;
  const g = w.weight_governance ?? 30;
  const total = e + s + g || 1;
  return { e: e / total, s: s / total, g: g / total, raw: { e, s, g } };
}

const weighted = (kpis, weights) =>
  clamp(Object.entries(weights).reduce((sum, [k, w]) => sum + (kpis[k] ?? 0) * w, 0));

// deptId === null means "whole organisation".
const scopeSql = (deptId, col = 'department_id') =>
  deptId ? { clause: `AND ${col} = ?`, args: [deptId] } : { clause: '', args: [] };

// --- Environmental -----------------------------------------------------------
// Are we actually bending the emissions curve, and can we trust the data?
export function environmental(deptId = null) {
  const s = scopeSql(deptId);

  // 1. Goal attainment: how far each goal has travelled from baseline -> target.
  const goals = all(
    `SELECT baseline_co2, target_co2, current_co2 FROM esg_goals WHERE 1=1 ${s.clause}`,
    s.args
  );
  const goalScores = goals.map((g) => {
    const span = g.baseline_co2 - g.target_co2; // total distance we must cover
    if (span <= 0) return g.current_co2 <= g.target_co2 ? 100 : 0;
    return clamp(((g.baseline_co2 - g.current_co2) / span) * 100);
  });
  const goal_attainment = goalScores.length
    ? goalScores.reduce((a, b) => a + b, 0) / goalScores.length
    : 0;

  // 2. Emission trend: the last 180 days against the 180 before them. Falling
  //    emissions score above 50; a 20% cut pins the KPI at 100.
  //    Half-year windows, not quarters: the real reduction is a few percent per
  //    quarter, which is smaller than the month-to-month noise in the ledger, so
  //    a 90-day comparison mostly measures luck.
  const sumWindow = (from, to) =>
    get(
      `SELECT COALESCE(SUM(co2e_kg), 0) AS kg FROM carbon_transactions
        WHERE activity_date >= date('now', ?) AND activity_date < date('now', ?)
          AND status = 'verified' ${s.clause}`,
      [from, to, ...s.args]
    ).kg;
  const recent = sumWindow('-180 days', '+1 day');
  const prior = sumWindow('-360 days', '-180 days');
  const delta = prior > 0 ? (prior - recent) / prior : 0; // +ve = we cut emissions
  const emission_trend = clamp(50 + (delta / 0.2) * 50);

  // 3. Data coverage: unverified rows mean the number above is a guess.
  const cov = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS ok
       FROM carbon_transactions WHERE 1=1 ${s.clause}`,
    s.args
  );
  const data_coverage = cov.total ? pct(cov.ok, cov.total) : 0;

  const kpis = { goal_attainment, emission_trend, data_coverage };
  return { score: round1(weighted(kpis, E_WEIGHTS)), kpis, weights: E_WEIGHTS };
}

// --- Social ------------------------------------------------------------------
// Are employees actually showing up, and does the proof hold up?
export function social(deptId = null) {
  const dept = deptId ? `AND u.department_id = ?` : '';
  const args = deptId ? [deptId] : [];

  const headcount =
    get(
      `SELECT COALESCE(SUM(employee_count), 0) AS n FROM departments
        WHERE 1=1 ${deptId ? 'AND id = ?' : ''}`,
      deptId ? [deptId] : []
    ).n || 0;

  // 1. Participation rate: distinct employees with >=1 approved challenge.
  const active = get(
    `SELECT COUNT(DISTINCT p.user_id) AS n FROM participations p
       JOIN users u ON u.id = p.user_id
      WHERE p.status = 'approved' ${dept}`,
    args
  ).n;
  const participation_rate = clamp(pct(active, headcount));

  // 2. Verification rate: of everything submitted, how much survived review.
  const subs = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS ok
       FROM participations p JOIN users u ON u.id = p.user_id
      WHERE p.status <> 'pending' ${dept}`,
    args
  );
  const verification_rate = subs.total ? pct(subs.ok, subs.total) : 0;

  // 3. Engagement: mean XP per head, where 500 XP/employee is a full score.
  const xp = get(
    `SELECT COALESCE(AVG(u.xp), 0) AS avg_xp FROM users u WHERE 1=1 ${dept}`,
    args
  ).avg_xp;
  const engagement = clamp((xp / 500) * 100);

  const kpis = { participation_rate, verification_rate, engagement };
  return { score: round1(weighted(kpis, S_WEIGHTS)), kpis, weights: S_WEIGHTS };
}

// --- Governance --------------------------------------------------------------
// Do we close our compliance issues, and do we close them on time?
export function governance(deptId = null) {
  const s = scopeSql(deptId);

  const issues = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN status <> 'resolved' AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue
       FROM compliance_issues WHERE 1=1 ${s.clause}`,
    s.args
  );

  // 1. Resolution rate.
  const resolution_rate = issues.total ? pct(issues.resolved, issues.total) : 100;

  // 2. Timeliness: every overdue issue is a direct hit. Nothing overdue = 100.
  const open = issues.total - issues.resolved;
  const timeliness = open > 0 ? clamp(100 - pct(issues.overdue, open)) : 100;

  // 3. Policy coverage: an active policy for each framework we claim to report on.
  const frameworks = get(
    `SELECT COUNT(DISTINCT framework) AS n FROM policies`
  ).n;
  const covered = get(
    `SELECT COUNT(DISTINCT framework) AS n FROM policies WHERE status = 'active'`
  ).n;
  const policy_coverage = frameworks ? pct(covered, frameworks) : 0;

  const kpis = { resolution_rate, timeliness, policy_coverage };
  return {
    score: round1(weighted(kpis, G_WEIGHTS)),
    kpis,
    weights: G_WEIGHTS,
    counts: {
      total: issues.total,
      resolved: issues.resolved,
      open,
      overdue: issues.overdue,
    },
  };
}

/** The headline number: 0.4E + 0.3S + 0.3G. */
export function overall(deptId = null) {
  const w = pillarWeights();
  const e = environmental(deptId);
  const s = social(deptId);
  const g = governance(deptId);
  const score = round1(e.score * w.e + s.score * w.s + g.score * w.g);
  return { score, environmental: e, social: s, governance: g, weights: w.raw };
}

/** Every department scored and ranked -- powers the live leaderboard. */
export function leaderboard() {
  const depts = all(`SELECT id, name, code, employee_count FROM departments ORDER BY name`);
  return depts
    .map((d) => {
      const o = overall(d.id);
      return {
        id: d.id,
        name: d.name,
        code: d.code,
        employees: d.employee_count,
        score: o.score,
        environmental: o.environmental.score,
        social: o.social.score,
        governance: o.governance.score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((d, i) => ({ ...d, rank: i + 1 }));
}

/**
 * Monthly verified emissions for the trend chart.
 *
 * COMPLETE months only. Starting the window at "6 months ago today" lands
 * mid-month, so the first bucket held ~18 days of data and the last held
 * however far into the month we are -- both rendered as dips, and the chart
 * appeared to rise when emissions were actually falling.
 */
export function emissionsTrend(months = 6, deptId = null) {
  const s = scopeSql(deptId);
  return all(
    `SELECT strftime('%Y-%m', activity_date) AS month,
            ROUND(SUM(co2e_kg) / 1000.0, 2) AS tco2e
       FROM carbon_transactions
      WHERE status = 'verified'
        AND activity_date >= date('now', 'start of month', '-${Number(months)} months')
        AND activity_date <  date('now', 'start of month') ${s.clause}
      GROUP BY month ORDER BY month`,
    s.args
  );
}
