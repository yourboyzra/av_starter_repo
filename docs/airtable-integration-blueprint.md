# Airtable Custom Integration Blueprint

**Purpose:** A reusable starting point for connecting any third-party software to Airtable, deployable on **Vercel** or **Railway**. Follow this top to bottom and you'll have a production-grade integration skeleton in under an hour.

**Stack:** TypeScript + Node 20+. Examples use [Hono](https://hono.dev) (runs identically on Vercel and Railway), raw `fetch` against the Airtable REST API (no SDK — full control over rate limiting and retries), and Zod for payload validation.

---

## 1. Pick your integration pattern first (not your platform)

Every Airtable integration is one of three shapes. Identify yours before writing code — it determines everything downstream.

| Pattern | When to use | Direction | Example |
|---|---|---|---|
| **A. Webhook-driven** | Third party pushes events (Stripe, Typeform, Calendly, Twilio) | 3rd party → Airtable | Payment succeeded → update order record |
| **B. Polling / scheduled sync** | Third party has no webhooks, or you need periodic reconciliation | 3rd party ⇄ Airtable | Pull ERP inventory every 15 min |
| **C. Airtable-originated** | Airtable change should trigger an action elsewhere | Airtable → 3rd party | New record → create invoice in Stripe |

Most real projects combine A + C (event in, event out) with B as a nightly reconciliation safety net. **Always plan the reconciliation job** — webhooks get missed; a sync that self-heals is the difference between a demo and a product.

## 2. Vercel vs. Railway decision matrix

The codebase below runs on both. Choose the deployment target by workload:

| Factor | Vercel | Railway |
|---|---|---|
| Webhook receivers (Pattern A) | ✅ Ideal — serverless, scales to zero | ✅ Fine |
| Scheduled jobs (Pattern B) | ⚠️ Cron jobs OK, but **max function duration applies** (check your plan's limit) | ✅ Ideal — persistent process, run anything |
| Long-running syncs, queues, workers | ❌ Functions time out | ✅ Ideal |
| Airtable webhook **refresh job** (see §6) | ✅ Vercel Cron works | ✅ node-cron in-process |
| WebSockets / persistent connections | ❌ | ✅ |
| Cold starts | Yes (usually negligible for webhooks) | No |
| Pricing model | Per-invocation/bandwidth | Per-resource (always-on container) |

**Rule of thumb:**
- Pure webhook relay with light processing → **Vercel**
- Anything with polling loops, large batch syncs (1,000+ records), queues, or jobs longer than ~60s → **Railway**
- Hybrid is legitimate: webhook receiver on Vercel that enqueues work into a Railway worker.

## 3. Airtable API fundamentals (non-negotiable knowledge)

These constraints shape all the code that follows:

1. **Auth:** Use a **Personal Access Token (PAT)** or OAuth — API keys are deprecated. Scope the PAT to *only* the bases and scopes needed (`data.records:read`, `data.records:write`, `schema.bases:read`, plus `webhook:manage` if using Airtable webhooks).
2. **Rate limit: 5 requests/second per base.** Exceeding it returns `429` and a 30-second penalty box. Your client **must** serialize/throttle requests — never `Promise.all()` raw Airtable calls.
3. **Batching: max 10 records per create/update/delete request.** Chunk everything.
4. **Upserts:** `PATCH` with `performUpsert.fieldsToMergeOn` lets you sync by external ID without a lookup-then-write round trip. This is the single most useful feature for integrations — design every synced table with an **external ID field** (e.g., `Stripe ID`, `ERP SKU`).
5. **`typecast: true`** lets Airtable coerce strings into selects/linked records/dates. Convenient, but it silently creates new select options — use deliberately.
6. **Field names vs field IDs:** Use **field IDs** (`returnFieldsByFieldId`, and IDs in writes) in production. Clients rename fields; field IDs never change. This one habit eliminates the most common class of breakage.
7. **Formula injection:** When building `filterByFormula` from user input, escape single quotes. (Helper included below.)

## 4. Repository structure

```
airtable-integration/
├── src/
│   ├── index.ts              # Hono app entry (server for Railway, exported for Vercel)
│   ├── config.ts             # Env validation (Zod) — fail fast on boot
│   ├── lib/
│   │   ├── airtable.ts       # Rate-limited Airtable client (THE core module)
│   │   ├── verify.ts         # Webhook signature verification (HMAC)
│   │   └── idempotency.ts    # Dedupe processed events
│   ├── routes/
│   │   ├── health.ts         # GET /health
│   │   └── webhooks/
│   │       └── provider.ts   # POST /webhooks/:provider — Pattern A
│   ├── jobs/
│   │   ├── sync.ts           # Pattern B reconciliation
│   │   └── refresh-webhooks.ts  # Airtable webhook 7-day refresh (§6)
│   └── mappers/
│       └── provider.ts       # 3rd-party payload → Airtable fields (pure functions)
├── vercel.json               # Vercel: routes + cron
├── railway.toml              # Railway: start command + healthcheck
├── .env.example
├── package.json
└── tsconfig.json
```

**Design rules:**
- **Mappers are pure functions** (payload in → Airtable fields out). They're the only file a colleague edits for a new provider, and the only thing you need to unit test heavily.
- All secrets via env vars, validated on boot. The app should crash loudly at startup if config is missing, not 500 at 2 a.m.

## 5. Core modules

### 5.1 `config.ts` — fail-fast env validation

```ts
import { z } from "zod";

const Env = z.object({
  AIRTABLE_PAT: z.string().startsWith("pat"),
  AIRTABLE_BASE_ID: z.string().startsWith("app"),
  PROVIDER_WEBHOOK_SECRET: z.string().min(16),
  INTERNAL_JOB_SECRET: z.string().min(16), // protects cron/job endpoints
  NODE_ENV: z.enum(["development", "production"]).default("development"),
});

export const env = Env.parse(process.env);
```

### 5.2 `lib/airtable.ts` — rate-limited client with retries

This is the heart of the blueprint. It enforces the 5 rps limit, retries on `429`/`5xx` with backoff, and exposes batch + upsert helpers.

```ts
import { env } from "../config";

const BASE_URL = "https://api.airtable.com/v0";
const MIN_INTERVAL_MS = 220; // ~4.5 rps, safely under the 5 rps cap

let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** Serialize all Airtable calls through one throttled queue. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCall + MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {}); // keep the chain alive on errors
  return run;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  attempt = 0
): Promise<T> {
  const res = await throttled(() =>
    fetch(`${BASE_URL}/${env.AIRTABLE_BASE_ID}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  );

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`Airtable ${res.status} after 5 attempts`);
    const backoff = res.status === 429 ? 31_000 : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, backoff));
    return request(method, path, body, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export type Fields = Record<string, unknown>;
export interface AirtableRecord { id: string; createdTime: string; fields: Fields; }

const chunk = <T>(arr: T[], size = 10): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );

/** Escape user input for filterByFormula. */
export const fEscape = (s: string) => s.replace(/'/g, "\\'");

export const airtable = {
  /** List all records, following pagination. Prefer field IDs in production. */
  async list(table: string, params: Record<string, string> = {}) {
    const out: AirtableRecord[] = [];
    let offset: string | undefined;
    do {
      const qs = new URLSearchParams({ ...params, ...(offset ? { offset } : {}) });
      const page = await request<{ records: AirtableRecord[]; offset?: string }>(
        "GET", `${encodeURIComponent(table)}?${qs}`
      );
      out.push(...page.records);
      offset = page.offset;
    } while (offset);
    return out;
  },

  async create(table: string, records: { fields: Fields }[], typecast = false) {
    const out: AirtableRecord[] = [];
    for (const batch of chunk(records)) {
      const res = await request<{ records: AirtableRecord[] }>(
        "POST", encodeURIComponent(table), { records: batch, typecast }
      );
      out.push(...res.records);
    }
    return out;
  },

  /**
   * Upsert by external ID — the workhorse of every integration.
   * mergeOn: field name(s) or ID(s) holding the external system's ID.
   */
  async upsert(table: string, records: { fields: Fields }[], mergeOn: string[], typecast = false) {
    const out: AirtableRecord[] = [];
    for (const batch of chunk(records)) {
      const res = await request<{ records: AirtableRecord[] }>(
        "PATCH", encodeURIComponent(table),
        { records: batch, performUpsert: { fieldsToMergeOn: mergeOn }, typecast }
      );
      out.push(...res.records);
    }
    return out;
  },

  async update(table: string, records: { id: string; fields: Fields }[]) {
    for (const batch of chunk(records)) {
      await request("PATCH", encodeURIComponent(table), { records: batch });
    }
  },

  async destroy(table: string, ids: string[]) {
    for (const batch of chunk(ids)) {
      const qs = batch.map((id) => `records[]=${id}`).join("&");
      await request("DELETE", `${encodeURIComponent(table)}?${qs}`);
    }
  },
};
```

### 5.3 `lib/verify.ts` — webhook signature verification

**Never skip this.** An unverified webhook endpoint is a public write API into your client's base. Most providers use HMAC-SHA256 over the raw body.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyHmac(rawBody: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

> Provider specifics vary: Stripe signs `{timestamp}.{rawBody}` and prefixes `v1=`; others sign base64. Check the provider's docs and adapt — but the principle (HMAC over the **raw, unparsed body**, compared with `timingSafeEqual`) is universal. This means you must read the raw body **before** JSON parsing.

### 5.4 `lib/idempotency.ts` — process every event exactly once

Providers retry webhooks; networks duplicate them. Dedupe by event ID. Simplest durable option without extra infrastructure: an `Events Log` table in the Airtable base itself (low volume) or Redis/Postgres on Railway (high volume).

```ts
import { airtable, fEscape } from "./airtable";

const LOG_TABLE = "Events Log"; // fields: Event ID (text), Provider, Processed At

export async function alreadyProcessed(eventId: string) {
  const hits = await airtable.list(LOG_TABLE, {
    filterByFormula: `{Event ID} = '${fEscape(eventId)}'`,
    maxRecords: "1",
  });
  return hits.length > 0;
}

export async function markProcessed(eventId: string, provider: string) {
  await airtable.create(LOG_TABLE, [{
    fields: { "Event ID": eventId, Provider: provider, "Processed At": new Date().toISOString() },
  }]);
}
```

### 5.5 `mappers/provider.ts` — the only file per new integration

```ts
import type { Fields } from "../lib/airtable";

/** Example: map a payment event into the Orders table. */
export function mapPaymentToOrder(evt: any): { fields: Fields } {
  return {
    fields: {
      "External ID": evt.data.object.id,          // ← merge key for upsert
      "Status": evt.data.object.status,
      "Amount": evt.data.object.amount / 100,
      "Customer Email": evt.data.object.customer_email ?? "",
      "Last Synced": new Date().toISOString(),
    },
  };
}
```

### 5.6 `routes/webhooks/provider.ts` — Pattern A endpoint

```ts
import { Hono } from "hono";
import { env } from "../../config";
import { verifyHmac } from "../../lib/verify";
import { alreadyProcessed, markProcessed } from "../../lib/idempotency";
import { airtable } from "../../lib/airtable";
import { mapPaymentToOrder } from "../../mappers/provider";

export const providerWebhook = new Hono();

providerWebhook.post("/", async (c) => {
  const raw = await c.req.text(); // raw body BEFORE parsing — needed for HMAC
  const sig = c.req.header("x-provider-signature") ?? "";

  if (!verifyHmac(raw, sig, env.PROVIDER_WEBHOOK_SECRET)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const evt = JSON.parse(raw);

  if (await alreadyProcessed(evt.id)) return c.json({ ok: true, deduped: true });

  // ACK fast, especially on Vercel: do the minimum, return 200.
  // Heavy work (multi-table writes, enrichment) → queue it (see §7).
  await airtable.upsert("Orders", [mapPaymentToOrder(evt)], ["External ID"]);
  await markProcessed(evt.id, "provider");

  return c.json({ ok: true });
});
```

### 5.7 `src/index.ts` — one entry, two platforms

```ts
import { Hono } from "hono";
import { providerWebhook } from "./routes/webhooks/provider";
import { runSync } from "./jobs/sync";
import { env } from "./config";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));
app.route("/webhooks/provider", providerWebhook);

// Job endpoint — triggered by Vercel Cron, or callable manually. Protect it.
app.post("/jobs/sync", async (c) => {
  if (c.req.header("authorization") !== `Bearer ${env.INTERNAL_JOB_SECRET}`)
    return c.json({ error: "unauthorized" }, 401);
  const result = await runSync();
  return c.json(result);
});

export default app; // Vercel picks this up via the hono/vercel adapter

// Railway: run a real server + in-process scheduler
if (process.env.RAILWAY_ENVIRONMENT) {
  const { serve } = await import("@hono/node-server");
  const cron = (await import("node-cron")).default;
  cron.schedule("*/15 * * * *", () => runSync().catch(console.error));
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
  console.log("Server up on Railway");
}
```

### 5.8 `jobs/sync.ts` — Pattern B reconciliation skeleton

```ts
import { airtable } from "../lib/airtable";
import { mapPaymentToOrder } from "../mappers/provider";

export async function runSync() {
  // 1. Pull from the third party (paginate; respect THEIR rate limits too)
  const externalItems = await fetchAllFromProvider(); // implement per provider

  // 2. Upsert into Airtable by external ID — no diffing logic needed
  const records = externalItems.map(mapPaymentToOrder);
  const written = await airtable.upsert("Orders", records, ["External ID"]);

  // 3. Optional: flag Airtable records whose external counterpart vanished
  return { pulled: externalItems.length, written: written.length };
}
```

## 6. Pattern C: reacting to Airtable changes

Two options, in order of preference:

**Option 1 — Airtable Automations → your endpoint (simplest, start here).**
In the base: *Automation → trigger "When record matches conditions" → "Run a script"* that does `fetch("https://your-app.../jobs/handle-change", { method: "POST", headers: { Authorization: "Bearer ..." }, body: JSON.stringify({ recordId, ... }) })`. Zero infrastructure on the Airtable side, easy for clients to see and audit. Limitations: automation run quotas on the client's plan, and scripts have a short execution limit — so the script should only *notify* your service, which does the real work.

**Option 2 — Airtable Webhooks API (robust, more moving parts).**
Programmatic webhooks (`POST /v0/bases/{baseId}/webhooks`) notify your endpoint that *something* changed; you then fetch the actual payloads with a **cursor** (`GET .../webhooks/{webhookId}/payloads`). Critical operational facts:

- Notifications are **pings, not payloads** — always pull via cursor, which also self-heals missed pings.
- Webhooks **expire after 7 days** and must be refreshed (`POST .../webhooks/{id}/refresh`). **Schedule this**: Vercel Cron daily, or node-cron on Railway. An expired webhook is the #1 cause of "the integration silently stopped."
- Notification requests are signed with the webhook's `macSecretBase64` — verify with HMAC-SHA256 (same `verify.ts` pattern, base64 variant).
- Persist your cursor (a one-row config table in the base works fine) so a redeploy doesn't reprocess history.

## 7. Queues and heavy workloads (Railway)

If webhook processing involves multiple slow steps (enrich from another API, write to 3 tables, send email), don't do it inline:

- **Railway:** add **BullMQ + Redis** (Railway has a one-click Redis). Webhook route does verify → dedupe → `queue.add()` → 200. Worker process consumes jobs with retries and backoff.
- **Vercel:** functions can't host workers. Either keep processing under your plan's function duration limit, use a hosted queue (e.g., Upstash QStash, Inngest), or pair with a Railway worker.

This split — *receive on Vercel, work on Railway* — is a clean, cheap architecture for spiky workloads.

## 8. Deployment

### Vercel
1. `npm i hono zod` (+ `vercel` adapter per Hono's Vercel docs).
2. `vercel.json`:
```json
{
  "crons": [
    { "path": "/jobs/sync", "schedule": "*/15 * * * *" }
  ]
}
```
   *(Vercel Cron sends GET without custom headers — protect job routes by checking a `?token=` query param or use Vercel's cron secret env var instead of the Bearer header shown above.)*
3. Set env vars in the Vercel dashboard (Production + Preview separately).
4. `vercel deploy --prod`. Webhook URL: `https://<project>.vercel.app/webhooks/provider`.

### Railway
1. `railway.toml`:
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm run start"
healthcheckPath = "/health"
restartPolicyType = "on_failure"
```
2. `railway up` (or connect the GitHub repo for deploy-on-push).
3. Set env vars with `railway variables set ...` or the dashboard. Railway injects `PORT` — always bind to it.
4. Add Redis from the Railway dashboard if using queues; it injects `REDIS_URL`.

### Both
- Register the public URL with the third-party provider, send a test event, and confirm a record lands in Airtable **before** writing any more code.
- Use a **separate Airtable base (or duplicated base) for staging**, with its own PAT.

## 9. Security & reliability checklist

- [ ] PAT scoped to minimum bases/scopes; never the personal "all access" token
- [ ] Webhook signatures verified with `timingSafeEqual` on the **raw body**
- [ ] Job/cron endpoints require a secret (never publicly triggerable)
- [ ] Idempotency on every inbound event
- [ ] All Airtable writes go through the throttled client (no raw `fetch`, no `Promise.all`)
- [ ] Field IDs (not names) in production mappers
- [ ] `filterByFormula` inputs escaped
- [ ] Airtable webhook refresh scheduled (if using §6 Option 2)
- [ ] Reconciliation sync as a safety net, even for webhook-driven integrations
- [ ] `/health` endpoint + uptime monitor pointed at it
- [ ] Errors logged with event ID + provider; failed events recoverable (re-runnable from the Events Log)
- [ ] Staging base + staging deployment exist and were used before prod

## 10. Quickstart for a new project (the 30-minute path)

1. Clone the skeleton, `npm i`, copy `.env.example` → `.env`.
2. Create the Airtable base (or use the client's), add an **External ID** field to each synced table, plus the `Events Log` table.
3. Create a scoped PAT; fill env vars.
4. Write your mapper(s) in `src/mappers/` — payload in, fields out. This is 80% of the per-project work.
5. Point the webhook route at your mapper; set the provider's secret.
6. Decide Vercel vs Railway with the §2 matrix; deploy.
7. Register the webhook URL with the provider; fire a test event; verify the record.
8. Wire the reconciliation job; run it once manually against staging.
9. Walk the §9 checklist. Ship.

---

*Maintained by David Bracho / Airvues. Patterns reflect production integrations across Stripe, ISP order management, and CRM syncs. Questions or improvements → David.*
