// The ESG scoring engine — fully async for Postgres compatibility.
//
// Every score in the UI comes out of this file -- nothing is hardcoded in the
// pages. Each pillar is built from named KPIs that are each normalised to
// 0..100, then averaged with the weights below. The API returns the KPI
// breakdown alongside the score so the dashboard can show its working.
import { all, get, IS_PG } from '../db.js';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const pct = (num, den) => (den > 0 ? (num / den) * 100 : 0);
const round1 = (n) => Math.round(n * 10) / 10;

const E_WEIGHTS = { goal_attainment: 0.5, emission_trend: 0.3, data_coverage: 0.2 };
const S_WEIGHTS = { participation_rate: 0.5, verification_rate: 0.3, engagement: 0.2 };
const G_WEIGHTS = { resolution_rate: 0.5, timeliness: 0.3, policy_coverage: 0.2 };

// Postgres-compatible date arithmetic (interval syntax instead of SQLite modifier strings)
const pgDateSub = (days) => IS_PG ? `NOW() - INTERVAL '${days} days'` : `date('now', '-${days} days')`;

export async function pillarWeights() {
  const rows = await all(`SELECT key, value FROM settings WHERE key LIKE 'weight_%'`);
  const w = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  const e = w.weight_environmental ?? 40;
  const s = w.weight_social ?? 30;
  const g = w.weight_governance ?? 30;
  const total = e + s + g || 1;
  return { e: e / total, s: s / total, g: g / total, raw: { e, s, g } };
}

const weighted = (kpis, weights) =>
  clamp(Object.entries(weights).reduce((sum, [k, w]) => sum + (kpis[k] ?? 0) * w, 0));

const scopeSql = (deptId, col = 'department_id') =>
  deptId ? { clause: `AND ${col} = ?`, args: [deptId] } : { clause: '', args: [] };

export async function environmental(deptId = null) {
  const s = scopeSql(deptId);

  const goals = await all(
    `SELECT baseline_co2, target_co2, current_co2 FROM esg_goals WHERE 1=1 ${s.clause}`,
    s.args
  );
  const goalScores = goals.map((g) => {
    const span = g.baseline_co2 - g.target_co2;
    if (span <= 0) return g.current_co2 <= g.target_co2 ? 100 : 0;
    return clamp(((g.baseline_co2 - g.current_co2) / span) * 100);
  });
  const goal_attainment = goalScores.length
    ? goalScores.reduce((a, b) => a + b, 0) / goalScores.length
    : 0;

  // Emission trend: last 180 days vs. the 180 before them.
  const sumWindow = async (daysFrom, daysTo) => {
    const row = await get(
      `SELECT COALESCE(SUM(co2e_kg), 0) AS kg FROM carbon_transactions
        WHERE activity_date >= ${pgDateSub(daysFrom)} AND activity_date < ${pgDateSub(daysTo)}
          AND status = 'verified' ${s.clause}`,
      s.args
    );
    return Number(row?.kg ?? 0);
  };
  const recent = await sumWindow(180, 0);
  const prior  = await sumWindow(360, 180);
  const delta = prior > 0 ? (prior - recent) / prior : 0;
  const emission_trend = clamp(50 + (delta / 0.2) * 50);

  const cov = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS ok
       FROM carbon_transactions WHERE 1=1 ${s.clause}`,
    s.args
  );
  const data_coverage = cov?.total ? pct(Number(cov.ok), Number(cov.total)) : 0;

  const kpis = { goal_attainment, emission_trend, data_coverage };
  return { score: round1(weighted(kpis, E_WEIGHTS)), kpis, weights: E_WEIGHTS };
}

export async function social(deptId = null) {
  const dept = deptId ? `AND u.department_id = ?` : '';
  const args = deptId ? [deptId] : [];

  const headRow = await get(
    `SELECT COALESCE(SUM(employee_count), 0) AS n FROM departments
      WHERE 1=1 ${deptId ? 'AND id = ?' : ''}`,
    deptId ? [deptId] : []
  );
  const headcount = Number(headRow?.n ?? 0) || 0;

  const activeRow = await get(
    `SELECT COUNT(DISTINCT p.user_id) AS n FROM participations p
       JOIN users u ON u.id = p.user_id
      WHERE p.status = 'approved' ${dept}`,
    args
  );
  const active = Number(activeRow?.n ?? 0);
  const participation_rate = clamp(pct(active, headcount));

  const subs = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS ok
       FROM participations p JOIN users u ON u.id = p.user_id
      WHERE p.status <> 'pending' ${dept}`,
    args
  );
  const verification_rate = Number(subs?.total) ? pct(Number(subs.ok), Number(subs.total)) : 0;

  const xpRow = await get(
    `SELECT COALESCE(AVG(u.xp), 0) AS avg_xp FROM users u WHERE 1=1 ${dept}`,
    args
  );
  const engagement = clamp((Number(xpRow?.avg_xp ?? 0) / 500) * 100);

  const kpis = { participation_rate, verification_rate, engagement };
  return { score: round1(weighted(kpis, S_WEIGHTS)), kpis, weights: S_WEIGHTS };
}

export async function governance(deptId = null) {
  const s = scopeSql(deptId);

  const issues = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN status <> 'resolved' AND due_date < CURRENT_DATE THEN 1 ELSE 0 END) AS overdue
       FROM compliance_issues WHERE 1=1 ${s.clause}`,
    s.args
  );

  const total    = Number(issues?.total    ?? 0);
  const resolved = Number(issues?.resolved ?? 0);
  const overdue  = Number(issues?.overdue  ?? 0);

  const resolution_rate = total ? pct(resolved, total) : 100;
  const open = total - resolved;
  const timeliness = open > 0 ? clamp(100 - pct(overdue, open)) : 100;

  const fwRow = await get(`SELECT COUNT(DISTINCT framework) AS n FROM policies`);
  const covRow = await get(`SELECT COUNT(DISTINCT framework) AS n FROM policies WHERE status = 'active'`);
  const frameworks = Number(fwRow?.n ?? 0);
  const covered    = Number(covRow?.n ?? 0);
  const policy_coverage = frameworks ? pct(covered, frameworks) : 0;

  const kpis = { resolution_rate, timeliness, policy_coverage };
  return {
    score: round1(weighted(kpis, G_WEIGHTS)),
    kpis,
    weights: G_WEIGHTS,
    counts: { total, resolved, open, overdue },
  };
}

export async function overall(deptId = null) {
  const w = await pillarWeights();
  const e = await environmental(deptId);
  const s = await social(deptId);
  const g = await governance(deptId);
  const score = round1(e.score * w.e + s.score * w.s + g.score * w.g);
  return { score, environmental: e, social: s, governance: g, weights: w.raw };
}

export async function leaderboard() {
  const depts = await all(`SELECT id, name, code, employee_count FROM departments ORDER BY name`);
  const scored = await Promise.all(depts.map(async (d) => {
    const o = await overall(d.id);
    return {
      id: d.id, name: d.name, code: d.code, employees: d.employee_count,
      score: o.score,
      environmental: o.environmental.score,
      social: o.social.score,
      governance: o.governance.score,
    };
  }));
  return scored.sort((a, b) => b.score - a.score).map((d, i) => ({ ...d, rank: i + 1 }));
}

export async function emissionsTrend(months = 6, deptId = null) {
  const s = scopeSql(deptId);
  if (IS_PG) {
    return all(
      `SELECT TO_CHAR(activity_date, 'YYYY-MM') AS month,
              ROUND(CAST(SUM(co2e_kg) / 1000.0 AS NUMERIC), 2) AS tco2e
         FROM carbon_transactions
        WHERE status = 'verified'
          AND activity_date >= DATE_TRUNC('month', NOW()) - INTERVAL '${Number(months)} months'
          AND activity_date <  DATE_TRUNC('month', NOW()) ${s.clause}
        GROUP BY month ORDER BY month`,
      s.args
    );
  } else {
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
}
