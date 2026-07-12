// AI provider seam.
//
// The rest of the app only ever calls extractBill / verifyPhoto / askChatbot.
// It never learns which provider answered. Today that's `rules` (deterministic,
// offline, no key). When the Gemini/OpenAI key lands, implement the same three
// functions in ./providers/gemini.js and flip AI_PROVIDER -- no route, no page,
// and no database code has to change.
//
//   AI_PROVIDER=rules    (default) heuristics + SQL. Works offline.
//   AI_PROVIDER=gemini   -> src/ai/providers/gemini.js   [not wired yet]
//   AI_PROVIDER=openai   -> src/ai/providers/openai.js   [not wired yet]
import * as rules from './providers/rules.js';

const PROVIDERS = { rules };

const name = process.env.AI_PROVIDER || 'rules';
const provider = PROVIDERS[name] ?? rules;

if (!PROVIDERS[name]) {
  console.warn(`[ai] provider "${name}" is not implemented yet -- using "rules"`);
}

export const providerName = PROVIDERS[name] ? name : 'rules';

/**
 * OCR a utility bill / fuel receipt.
 * -> { activity, quantity, unit, vendor, period, confidence }
 * The caller matches `activity` to an emission_factors row and does the maths;
 * the AI's only job is pulling numbers off the page.
 */
export const extractBill = (file) => provider.extractBill(file);

/**
 * Vision-verify challenge proof against the challenge's category.
 * -> { match: boolean, confidence: 0..1, reason: string }
 */
export const verifyPhoto = (file, category) => provider.verifyPhoto(file, category);

/**
 * Natural-language question over the ESG data.
 * -> { answer: string, data?: any[], sql?: string }
 */
export const askChatbot = (question) => provider.askChatbot(question);
