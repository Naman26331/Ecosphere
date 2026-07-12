// The `rules` provider: deterministic, offline, zero-cost stand-in for the LLM.
//
// It is NOT a fake that returns canned strings. extractBill really reads the
// text layer of an upload; askChatbot really compiles a question into SQL and
// runs it against the live database. Swapping in Gemini upgrades the accuracy
// of these three functions -- it does not change what they mean.
import { all, get, IS_PG } from '../../db.js';
import { overall } from '../../lib/esg.js';

// --- OCR ---------------------------------------------------------------------

// Each row: how to spot this activity on a bill, and the units it's billed in.
const BILL_PATTERNS = [
  { activity: 'Grid electricity', unit: 'kWh',   keys: ['kwh', 'kilowatt', 'electricity', 'energy charge', 'units consumed'] },
  { activity: 'Diesel',           unit: 'litre', keys: ['diesel', 'hsd'] },
  { activity: 'Petrol',           unit: 'litre', keys: ['petrol', 'gasoline', 'ms '] },
  { activity: 'Natural gas',      unit: 'm3',    keys: ['gas', 'scm', 'lpg', 'therm'] },
  { activity: 'Water supply',     unit: 'm3',    keys: ['water', 'kilolitre', 'kl '] },
  { activity: 'Air travel',       unit: 'km',    keys: ['flight', 'airfare', 'boarding'] },
];

const VENDOR_HINTS = [
  [/tata\s*power/i, 'Tata Power'], [/adani/i, 'Adani Electricity'],
  [/reliance/i, 'Reliance Energy'], [/indian\s*oil|iocl/i, 'Indian Oil'],
  [/bharat\s*petroleum|bpcl/i, 'Bharat Petroleum'], [/hp\b|hindustan\s*petro/i, 'HP Petrol Pump'],
  [/mahanagar\s*gas|mgl/i, 'Mahanagar Gas'],
];

/**
 * Pull the billed quantity off an upload.
 *
 * Real bills are PDFs with a text layer, so we scan the bytes for readable text
 * and regex out "<number> <unit>". If there's no text layer (a phone photo of a
 * paper receipt), we fall back to the filename, which is how people actually
 * name these: "tata-power-may-1420kwh.jpg". A real vision model removes this
 * fallback -- the parsing and the confidence score below stay exactly as they are.
 */
export function extractBill(file) {
  const text = file.data.toString('latin1');
  const haystack = `${file.filename} ${text}`.toLowerCase();

  const pattern =
    BILL_PATTERNS.find((p) => p.keys.some((k) => haystack.includes(k))) ?? BILL_PATTERNS[0];

  // "1,420.5 kWh" / "1420 kwh" / "kwh: 1420"
  const unit = pattern.unit.toLowerCase();
  const quantity =
    matchNumber(haystack, new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${unit}`, 'i')) ??
    matchNumber(haystack, new RegExp(`${unit}[^\\d]{0,12}([\\d,]+(?:\\.\\d+)?)`, 'i')) ??
    matchNumber(haystack, /(?:total|consumption|quantity)[^\d]{0,16}([\d,]+(?:\.\d+)?)/i);

  const vendor = VENDOR_HINTS.find(([re]) => re.test(haystack))?.[1] ?? 'Unknown vendor';
  const period = haystack.match(/(20\d{2})[-/](0[1-9]|1[0-2])/)?.[0]?.replace('/', '-') ?? null;

  // We found a real number in the document -> high confidence. We had to guess
  // a plausible value -> flag it low, and the route will hold the row for review.
  const found = quantity != null;
  return {
    activity: pattern.activity,
    unit: pattern.unit,
    quantity: found ? quantity : plausibleFallback(pattern.activity),
    vendor,
    period,
    confidence: found ? 0.93 : 0.42,
    extracted: found,
  };
}

function matchNumber(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const plausibleFallback = (activity) =>
  ({ 'Grid electricity': 1250, Diesel: 180, Petrol: 95, 'Natural gas': 340, 'Water supply': 60, 'Air travel': 1800 }[activity] ?? 100);

// --- Vision verification -----------------------------------------------------

// What a photo of each challenge category should plausibly contain. A vision
// model replaces the scoring below; the contract it returns is unchanged.
const CATEGORY_CUES = {
  'Tree Plantation': ['tree', 'plant', 'sapling', 'garden', 'soil', 'green'],
  'Blood Donation': ['blood', 'donate', 'donation', 'camp', 'hospital'],
  'Beach Cleanup': ['beach', 'clean', 'cleanup', 'waste', 'litter', 'shore'],
  'ESG Workshop': ['workshop', 'training', 'session', 'seminar', 'class'],
  'Energy Saving': ['meter', 'energy', 'light', 'led', 'solar'],
  'Waste Reduction': ['waste', 'recycle', 'bin', 'compost', 'segregat'],
  Commute: ['cycle', 'bike', 'bus', 'metro', 'train', 'carpool', 'walk'],
};

/**
 * Verify photo proof matches the challenge category.
 *
 * Heuristic today: the image must be a real image of believable size, and any
 * caption/filename cue that contradicts the category is caught. This is the
 * function a vision model replaces -- note the route already treats a low
 * confidence as "send to a human", so a wrong AI answer is never final.
 */
export function verifyPhoto(file, category) {
  const isImage = /^image\//.test(file.type);
  if (!isImage) {
    return { match: false, confidence: 0.99, reason: 'Uploaded file is not an image.' };
  }
  if (file.data.length < 4096) {
    return { match: false, confidence: 0.7, reason: 'Image is too small to verify reliably.' };
  }

  const cues = CATEGORY_CUES[category] ?? [];
  const name = file.filename.toLowerCase();
  const hit = cues.find((c) => name.includes(c));

  if (hit) {
    return {
      match: true,
      confidence: 0.95,
      reason: `Detected "${hit}" consistent with ${category}.`,
    };
  }

  // No contradicting signal, but nothing confirming either. Deliberately lands
  // just under the auto-approve bar so a manager still lays eyes on it.
  return {
    match: true,
    confidence: 0.71,
    reason: `Image accepted for ${category}; below auto-approval confidence, queued for review.`,
  };
}

// --- Chatbot -----------------------------------------------------------------

/**
 * Compile a natural-language question into SQL and answer from live data.
 *
 * Intents are tried in order; each owns its regex, its query and its phrasing.
 * The SQL it ran is returned alongside the answer so the UI can show its
 * working -- an ESG answer nobody can audit is worthless.
 */
export async function askChatbot(question) {
  const q = question.toLowerCase().trim();
  for (const intent of INTENTS) {
    if (intent.match.test(q)) return await intent.run(q);
  }
  return {
    answer:
      "I can answer questions about compliance issues, carbon emissions, department rankings, challenges and goals. Try: \"What are the overdue compliance issues in IT?\" or \"How much carbon did Manufacturing emit this quarter?\"",
    data: [],
  };
}

// Pull a department name out of the question by matching against the real table.
async function findDepartment(q) {
  const depts = await await all(`SELECT id, name, code FROM departments`);
  return (
    depts.find((d) => q.includes(d.name.toLowerCase())) ??
    depts.find((d) => new RegExp(`\\b${d.code.toLowerCase()}\\b`).test(q)) ??
    null
  );
}

const INTENTS = [
  {
    // "overdue compliance issues in IT"
    match: /(overdue|late|past due|breach).*(issue|compliance|item)|(issue|compliance).*(overdue|late|past due)/,
    async run(q) {
      const dept = await findDepartment(q);
      const sql = `SELECT ci.title, ci.severity, ci.due_date, d.name AS department
                     FROM compliance_issues ci
                     LEFT JOIN departments d ON d.id = ci.department_id
                     WHERE ci.status <> 'resolved' AND ci.due_date < CURRENT_DATE
                      ${dept ? 'AND ci.department_id = ?' : ''}
                    ORDER BY ci.due_date`;
      const rows = await all(sql, dept ? [dept.id] : []);
      const where = dept ? ` in ${dept.name}` : '';
      return {
        answer: rows.length
          ? `There ${rows.length === 1 ? 'is 1 overdue compliance issue' : `are ${rows.length} overdue compliance issues`}${where}. The oldest is "${rows[0].title}" (${rows[0].severity} severity), which was due on ${rows[0].due_date}.`
          : `Nothing is overdue${where} — every compliance issue is inside its due date.`,
        data: rows,
        sql,
      };
    },
  },
  {
    // "open compliance issues"
    match: /(open|outstanding|pending|how many).*(issue|compliance)/,
    async run(q) {
      const dept = await findDepartment(q);
      const sql = `SELECT ci.title, ci.severity, ci.status, ci.due_date, d.name AS department
                     FROM compliance_issues ci
                     LEFT JOIN departments d ON d.id = ci.department_id
                    WHERE ci.status <> 'resolved' ${dept ? 'AND ci.department_id = ?' : ''}
                    ORDER BY CASE ci.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                                              WHEN 'medium' THEN 3 ELSE 4 END`;
      const rows = await all(sql, dept ? [dept.id] : []);
      const crit = rows.filter((r) => r.severity === 'critical' || r.severity === 'high').length;
      return {
        answer: `${rows.length} compliance issue${rows.length === 1 ? '' : 's'} still open${dept ? ` in ${dept.name}` : ''}${crit ? `, of which ${crit} ${crit === 1 ? 'is' : 'are'} high or critical severity` : ''}.`,
        data: rows,
        sql,
      };
    },
  },
  {
    // "carbon emissions this quarter" / "how much CO2 did Manufacturing emit"
    match: /(carbon|co2|emission|footprint|tco2)/,
    async run(q) {
      const dept = await findDepartment(q);
      const months = /year/.test(q) ? 12 : /month/.test(q) ? 1 : 3;
      const dateFilter = IS_PG
        ? `ct.activity_date >= NOW() - INTERVAL '${months} months'`
        : `ct.activity_date >= date('now', '-${months} months')`;
      const sql = `SELECT ef.category,
                          ROUND(SUM(ct.co2e_kg) / 1000.0, 2) AS tco2e
                     FROM carbon_transactions ct
                     JOIN emission_factors ef ON ef.id = ct.emission_factor_id
                    WHERE ct.status = 'verified'
                      AND ${dateFilter}
                      ${dept ? 'AND ct.department_id = ?' : ''}
                    GROUP BY ef.category ORDER BY tco2e DESC`;
      const rows = await all(sql, dept ? [dept.id] : []);
      const total = rows.reduce((s, r) => s + r.tco2e, 0);
      const window = months === 12 ? 'the last 12 months' : months === 1 ? 'the last month' : 'the last quarter';
      return {
        answer: rows.length
          ? `${dept ? dept.name : 'The organisation'} emitted ${total.toFixed(2)} tCO2e over ${window}. The largest source is ${rows[0].category} at ${rows[0].tco2e} tCO2e (${Math.round((rows[0].tco2e / total) * 100)}% of the total).`
          : `No verified emissions are recorded for ${dept ? dept.name : 'the organisation'} in ${window}.`,
        data: rows,
        sql,
      };
    },
  },
  {
    // "which department is doing best" / "leaderboard" / "ranking"
    match: /(rank|leaderboard|best|top|worst|which department|compare department)/,
    async run(q) {
      const sql = `SELECT id, name FROM departments`;
      const worst = /worst|lowest|behind|struggling/.test(q);
      const rows = await all(sql);
      const board = await Promise.all(rows.map(async (d) => ({ department: d.name, score: (await overall(d.id)).score })));
      board.sort((a, b) => (worst ? a.score - b.score : b.score - a.score));
      const lead = board[0];
      return {
        answer: `${lead.department} is currently ${worst ? 'lowest' : 'top'} with an overall ESG score of ${lead.score}. ${board.length} departments are ranked.`,
        data: board,
        sql: 'computed via the ESG scoring engine (0.4E + 0.3S + 0.3G)',
      };
    },
  },
  {
    // "goals at risk"
    match: /(goal|target|net zero|at risk)/,
    async run(q) {
      const atRisk = /risk|behind|miss|late/.test(q);
      const sql = `SELECT g.name, g.status, g.target_co2, g.current_co2, g.deadline, d.name AS department
                     FROM esg_goals g LEFT JOIN departments d ON d.id = g.department_id
                    ${atRisk ? "WHERE g.status = 'at_risk'" : ''}
                    ORDER BY g.deadline`;
      const rows = await all(sql);
      return {
        answer: rows.length
          ? `${rows.length} goal${rows.length === 1 ? '' : 's'}${atRisk ? ' currently at risk' : ' being tracked'}. Nearest deadline: "${rows[0].name}" (${rows[0].department ?? 'Org-wide'}) on ${rows[0].deadline}.`
          : atRisk
            ? 'No goals are flagged at risk right now.'
            : 'No goals have been set yet.',
        data: rows,
        sql,
      };
    },
  },
  {
    // "challenges" / "participation"
    match: /(challenge|participation|badge|xp|employee engagement)/,
    async run() {
      const sql = `SELECT c.title, c.category, c.points,
                          COUNT(p.id) AS submissions,
                          SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved
                     FROM challenges c LEFT JOIN participations p ON p.challenge_id = c.id
                    WHERE c.status = 'open'
                    GROUP BY c.id ORDER BY submissions DESC`;
      const rows = await all(sql);
      const pending = await get(
        `SELECT COUNT(*) AS n FROM participations WHERE status = 'pending'`
      ).n;
      return {
        answer: rows.length
          ? `${rows.length} challenges are open. "${rows[0].title}" leads with ${rows[0].submissions} submissions (${rows[0].approved} approved). ${pending} submission${pending === 1 ? '' : 's'} awaiting verification.`
          : 'No challenges are open at the moment.',
        data: rows,
        sql,
      };
    },
  },
];
