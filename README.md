# EcoSphere Auto-Pilot

An AI-driven, gamified ESG operations platform. Employees stop typing data in:
bills are read automatically, challenge proof is verified by vision, and the ESG
score recomputes off the ledger every time either one lands.

## Run it

```bash
npm run seed     # build data/ecosphere.db (a year of history)
npm start        # http://localhost:3000
```

There is no `npm install` step, and no `node_modules`. **The project has zero
dependencies** — the server is `node:http`, the database is `node:sqlite`, and the
router, the multipart parser and the charts are all hand-written in `src/` and
`public/assets/`. Requires Node 22.5+ (for the built-in SQLite module).

`npm run reset` rebuilds the database from scratch. The seed is deterministic, so
the numbers you rehearse against are the numbers on screen.

## What it does

**1. OCR → carbon ledger** (`/environment`)
Upload a utility bill or fuel receipt. The pipeline reads the usage off the
document, matches it to an **emission factor**, multiplies, and posts a **carbon
transaction** — no manual entry. A confident read posts straight to the ledger; a
shaky one is held for review. The extraction panel shows its working
(`1,842.5 kWh × 0.716 = 1,319.2 kgCO₂e`), because a carbon number nobody can audit
is worthless.

**2. Vision-verified gamification** (`/social`, `/gamification`)
An employee submits a photo as proof of a challenge. Vision checks it against the
challenge **category**. Above the auto-approval threshold it approves itself —
points banked, XP added, and any **badge** whose threshold was crossed awarded, all
in one transaction. Below it, a manager decides. The AI is never the last word on a
rejection.

**3. ESG chatbot** (the "Ask AI" button, on every page)
Ask *"What are the overdue compliance issues in IT?"* and it compiles the question
into SQL, runs it against live data, answers — then shows you the rows it used.

**4. Live department leaderboard** (`/`, `/gamification`)
Recomputed on every verified transaction. No cached scores anywhere.

**5. Reward Redemption & Gamification Inbox**
Earned XP automatically unlocks badges. Spent points on rewards instantly deduct from your balance. The new in-app notification system alerts you immediately when a challenge is approved, a badge is unlocked, or an automated ERP transaction is logged.

**6. Automated ERP Webhook**
A secure endpoint (`POST /api/erp/webhook`) allows external systems (Odoo, SAP, etc.) to push raw data (e.g. 500 liters of diesel purchased). EcoSphere auto-calculates the CO₂e using configured emission factors and posts it directly to the ledger, notifying managers automatically.

**7. Custom Report Export**
Generate CSV exports of the entire carbon ledger filtered by department, date, emission category, and Scope, ready for auditors.

## How the ESG score is built

`src/lib/esg.js` is the only place a score is produced. Each pillar is built from
named KPIs, each normalised to 0–100, then combined:

```
Overall = 0.40 × Environmental + 0.30 × Social + 0.30 × Governance
```

| Pillar | KPIs |
| --- | --- |
| **Environmental** | goal attainment (50%), emission trend (30%), data coverage (20%) |
| **Social** | participation rate (50%), verification rate (30%), engagement (20%) |
| **Governance** | resolution rate (50%), timeliness (30%), policy coverage (20%) |

Nothing is hardcoded in the pages. The API returns the KPI breakdown alongside
every score and the dashboard renders it, so any number on screen traces back to
rows in the database. The 40/30/30 weights live in the `settings` table and are
editable at `/settings`; the server rejects any split that doesn't total 100,
because a score built on weights that don't add up is not a score.

## Layout

```
server.js              entry point: static files + the /api router
src/
  schema.sql           master data + transactional data
  db.js                the ONLY file that knows the SQL engine
  seed.js              a deterministic year of history
  lib/esg.js           the scoring engine
  lib/gamify.js        points, XP, badge auto-award (one transaction)
  lib/http.js          router, multipart parser, static server
  routes/index.js      every API endpoint
  ai/index.js          the provider seam  <-- read this before adding a key
  ai/providers/rules.js
public/                the seven pages + one shared shell (assets/app.js)
```

## Adding a real model

The app only ever calls three functions — `extractBill`, `verifyPhoto`,
`askChatbot` (`src/ai/index.js`). It never learns which provider answered.

Today those are served by `rules`: deterministic, offline, no key, no cost. It is
not a stub that returns canned strings — `extractBill` really parses the uploaded
document, and `askChatbot` really compiles the question to SQL and runs it against
the live database. Swapping in Gemini or OpenAI **upgrades the accuracy of those
three functions; it does not change what they mean.**

To add one:

1. Write `src/ai/providers/gemini.js` exporting the same three functions.
2. Register it in the `PROVIDERS` map in `src/ai/index.js`.
3. `AI_PROVIDER=gemini GEMINI_API_KEY=... npm start`

No route, no page, and no database code has to change.

## Moving to PostgreSQL

`src/db.js` is the only file that knows the engine — everything above it speaks
`all()`, `get()`, `run()`, `tx()`. Reimplement those four against `pg` and the rest
of the codebase is untouched. The schema in `src/schema.sql` is standard SQL.

## Deployment & Hosting

Because this project uses a local file-based SQLite database (`data/ecosphere.db`) and saves uploaded documents directly to disk (`data/uploads`), it requires a **persistent filesystem**.

**Where to host:**
- **VPS (Virtual Private Server):** DigitalOcean Droplets, AWS EC2, or Linode.
- **PaaS with persistent storage:** Render (using a persistent disk) or Fly.io (using volumes).

**Where NOT to host:**
- Serverless platforms like Vercel, Netlify, or AWS Lambda (the filesystem is ephemeral and your database/uploads would be wiped on every request).

**Publishing Steps:**
1. Clone your repo onto your server.
2. Run `npm run seed` to bootstrap the initial database.
3. Keep the server running using a process manager like `pm2` (`pm2 start server.js --name ecosphere`).
4. (Optional) Set up Nginx as a reverse proxy to route traffic from port 80/443 to port 3000.
5. (Security) The `.gitignore` file already prevents your `data/` folder from being committed, ensuring you don't accidentally leak production data or overwrite it when pulling updates.
