// NVIDIA NIM provider — drop-in for the `rules` provider.
//
// Uses the NVIDIA NIM API (OpenAI-compatible endpoint) with the model
// `meta/llama-3.1-70b-instruct` for chat / OCR reasoning, and
// `nvidia/neva-22b` for vision verification.
//
// Environment variables required:
//   AI_PROVIDER=nvidia
//   NVIDIA_API_KEY=nvapi-...
//
// All three functions keep the same return contract as rules.js so no route or
// page has to change.
import { createRequire } from 'node:module';
import { all, get, IS_PG } from '../../db.js';
import { overall } from '../../lib/esg.js';
import * as rules from './rules.js';

const BASE = 'https://integrate.api.nvidia.com/v1';
const KEY  = process.env.NVIDIA_API_KEY;

// For the chatbot we need the DB schema as context so the model can write SQL.
const SCHEMA_SUMMARY = `
PostgreSQL database tables:
- departments(id, name, code, head, employee_count)
- users(id, name, email, role, department_id, xp, points_balance)
- emission_factors(id, category, activity, unit, factor_kgco2e, scope)
- carbon_transactions(id, department_id, emission_factor_id, user_id, activity_date, quantity, co2e_kg, source, status)
- esg_goals(id, name, department_id, baseline_co2, target_co2, current_co2, deadline, status)
- challenges(id, title, category, description, points, xp, start_date, end_date, status)
- participations(id, challenge_id, user_id, proof_url, status, ai_confidence, points_awarded, submitted_at)
- badges(id, name, description, tier, xp_threshold)
- user_badges(user_id, badge_id, awarded_at)
- compliance_issues(id, title, department_id, owner_id, framework, severity, status, due_date, created_at, resolved_at)
- rewards(id, name, description, points_required, stock, status)
- audit_log(id, actor, action, entity, entity_id, detail, created_at)
`.trim();

/** Call the NVIDIA NIM chat completions endpoint. */
async function nimChat(messages, { model = 'meta/llama-3.1-70b-instruct', maxTokens = 512 } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NVIDIA NIM error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// extractBill — OCR / document understanding
// ---------------------------------------------------------------------------

export async function extractBill(file) {
  // First run the rules extractor. If it got a high-confidence number, no
  // need to burn an API call — the document had a text layer.
  const rulesResult = rules.extractBill(file);
  if (rulesResult.confidence >= 0.9) return rulesResult;

  // Low confidence: describe the file to the LLM and ask it to reason about
  // what the quantity is. We send the raw text if available, or the filename.
  const text = file.data.toString('latin1').replace(/[^\x20-\x7E\n]/g, ' ').slice(0, 2000);
  const prompt = `You are an OCR assistant that extracts energy/fuel/utility consumption from bills.

Given this document excerpt (or filename if no text):
"""
${text || file.filename}
"""

Extract the following and respond in strict JSON only (no extra text):
{
  "activity": "one of: Grid electricity | Diesel | Petrol | Natural gas | Water supply | Air travel",
  "quantity": <number>,
  "unit": "kWh | litre | m3 | km",
  "vendor": "<vendor name or Unknown>",
  "period": "<YYYY-MM or null>",
  "confidence": <0.0-1.0>
}`;

  try {
    const raw = await nimChat([
      { role: 'system', content: 'You extract structured data from utility bills. Always respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ]);

    // Parse out the JSON block even if the model wraps it.
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      activity: parsed.activity ?? rulesResult.activity,
      unit: parsed.unit ?? rulesResult.unit,
      quantity: Number(parsed.quantity) || rulesResult.quantity,
      vendor: parsed.vendor ?? rulesResult.vendor,
      period: parsed.period ?? rulesResult.period,
      confidence: Number(parsed.confidence) || 0.75,
      extracted: true,
    };
  } catch (e) {
    console.warn('[nvidia] extractBill fallback to rules:', e.message);
    return rulesResult;
  }
}

// ---------------------------------------------------------------------------
// verifyPhoto — vision challenge verification
// ---------------------------------------------------------------------------

export async function verifyPhoto(file, category) {
  // Non-images or empty files: let the rules provider handle (fast rejection).
  if (!/^image\//.test(file.type) || file.data.length < 4096) {
    return rules.verifyPhoto(file, category);
  }

  try {
    // Convert image to base64 for the NIM vision model.
    const b64 = file.data.toString('base64');
    const mime = file.type;

    const prompt = `You are a sustainability challenge verifier. The challenge category is: "${category}".
Look at this image and determine if it matches the challenge category.

Respond in strict JSON only:
{
  "match": true|false,
  "confidence": <0.0-1.0>,
  "reason": "<one sentence explanation>"
}`;

    const raw = await nimChat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
      { model: 'nvidia/llama-3.2-90b-vision-instruct', maxTokens: 200 }
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      match: Boolean(parsed.match),
      confidence: Number(parsed.confidence) || 0.7,
      reason: parsed.reason ?? `AI reviewed the image for ${category}.`,
    };
  } catch (e) {
    console.warn('[nvidia] verifyPhoto fallback to rules:', e.message);
    return rules.verifyPhoto(file, category);
  }
}

// ---------------------------------------------------------------------------
// askChatbot — natural language over ESG data
// ---------------------------------------------------------------------------

export async function askChatbot(question) {
  try {
    const sqlDialectText = IS_PG ? 'PostgreSQL SELECT query' : 'SQLite SELECT query';
    const nowFnText = IS_PG ? 'use NOW().' : "use date('now').";
    const systemRoleText = IS_PG ? 'You write PostgreSQL SELECT queries.' : 'You write SQLite SELECT queries.';

    // Step 1: ask the LLM to generate SQL from the question.
    const sqlPrompt = `You are an ESG data analyst assistant. Given the database schema below, write a single ${sqlDialectText} that answers the user's question. Only output the SQL, nothing else.

Schema:
${SCHEMA_SUMMARY}

Question: ${question}

Rules:
- Use only SELECT statements.
- Limit to 20 rows.
- If the question is about "now" or "current", ${nowFnText}
- For emissions, SUM(co2e_kg)/1000 gives tCO2e.`;

    const sql = (await nimChat([
      { role: 'system', content: `${systemRoleText} Output SQL only, no markdown, no explanation.` },
      { role: 'user', content: sqlPrompt },
    ])).replace(/```sql?|```/gi, '').trim();

    // Step 2: run the SQL against the live database.
    let rows = [];
    try {
      rows = await all(sql);
    } catch (dbErr) {
      // Bad SQL from the model — fall back to the rules chatbot.
      console.warn('[nvidia] chatbot SQL error, falling back:', dbErr.message, '\nSQL:', sql);
      return await rules.askChatbot(question);
    }

    // Step 3: ask the LLM to phrase a natural-language answer from the rows.
    const answerPrompt = `The user asked: "${question}"

The query ran and returned these rows:
${JSON.stringify(rows.slice(0, 10), null, 2)}

Write a clear, concise 1-2 sentence answer in plain English. Do not mention SQL.`;

    const answer = await nimChat([
      { role: 'system', content: 'You summarise database query results as clear English sentences for ESG managers.' },
      { role: 'user', content: answerPrompt },
    ]);

    return { answer, data: rows, sql };
  } catch (e) {
    console.warn('[nvidia] askChatbot fallback to rules:', e.message);
    return await rules.askChatbot(question);
  }
}
