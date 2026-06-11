# Airtable ↔ Third-Party Connector Blueprint

**Purpose:** A repeatable framework for building code-based integrations between Airtable and *any* third-party SaaS — Stripe, QuickBooks, GoHighLevel (GHL), or anything with an API. Where the [Integration Blueprint](./airtable-integration-blueprint.md) covers the **chassis** (hosting on Vercel/Railway, webhook receivers, rate-limited Airtable client, idempotency), this document covers the **connector**: auth lifecycles, entity mapping, sync engines, and conflict resolution.

**The promise:** after internalizing this, connecting Airtable to a new provider means filling in one adapter file and one mapping spec — not redesigning anything.

---

## 1. The mental model: every connector is the same five questions

Before touching code, answer these for the provider. The answers fully determine the build:

| # | Question | Options | Drives |
|---|---|---|---|
| 1 | **How do we authenticate?** | API key · OAuth2 (+ refresh tokens) | Token storage & refresh job |
| 2 | **How do we learn about their changes?** | Webhooks · polling (`updated_since`) · change endpoints | Pattern A vs B from the chassis doc |
| 3 | **How do we push our changes?** | REST writes · they have no write API | Whether two-way is even possible |
| 4 | **What links a record here to a record there?** | Their ID stored in AT · our ID stored in them · a join table | The ID-linking strategy (§4) |
| 5 | **Who wins on conflict?** | One system is source of truth per field · last-write-wins · manual review | Sync direction & conflict rules (§6) |

Worked examples:

| | **Stripe** | **QuickBooks Online** | **GoHighLevel** |
|---|---|---|---|
| Auth | API key (restricted key) | OAuth2, refresh tokens that **rotate on every refresh** and expire if unused ~100 days | OAuth2 (marketplace app), access token ~1 day, refresh on schedule |
| Their changes → us | Webhooks (excellent, signed) | Webhooks + **Change Data Capture (CDC) endpoint** for reconciliation | Webhooks (per-event subscriptions) |
| Our changes → them | Full REST API | Full REST API — but updates require the current `SyncToken` per object | Full REST API |
| Linking ID | `cus_…`, `in_…`, `pi_…` stored in AT | QBO `Id` (per realm!) stored in AT | Contact/Opportunity ID stored in AT |
| Typical truth | Stripe owns payment state; AT owns ops state | QBO owns accounting truth; AT owns operational truth | Depends — usually GHL owns contact comms state, AT owns pipeline ops |

> The provider-specific quirks in **bold** above are exactly the things that kill naive integrations. Every provider has 1–3 of them; finding them is the first hour of any new connector. Always check: token rotation rules, per-object version/sync tokens, rate limits, and whether webhooks are reliable or "best effort."

## 2. The Connector interface — one shape for every provider

Define a single TypeScript interface; each provider gets one adapter file implementing it. The sync engine (§5) only ever talks to this interface, so it's provider-agnostic forever.

```ts
// src/connectors/types.ts
import type { Fields } from "../lib/airtable";

/** A normalized record from the third party, ready for mapping. */
export interface ExternalRecord {
  externalId: string;          // their primary key (e.g. "cus_123", QBO "45")
  entity: string;              // "customer" | "invoice" | "contact" | ...
  updatedAt: string;           // ISO — their last-modified timestamp
  raw: unknown;                // full original payload (kept for debugging/mapping)
}

export interface Connector {
  name: string;                                        // "stripe" | "quickbooks" | "ghl"

  /** Pull records changed since a watermark (Pattern B / reconciliation). */
  pullChanges(entity: string, since: string): Promise<ExternalRecord[]>;

  /** Push a create/update to the provider. Returns their ID (for linking). */
  push(entity: string, externalId: string | null, data: Record<string, unknown>): Promise<string>;

  /** Verify + parse an inbound webhook into normalized events. */
  parseWebhook(rawBody: string, headers: Record<string, string>): Promise<ExternalRecord[]>;
}
```

Three methods. That's the whole contract. `pullChanges` powers reconciliation, `parseWebhook` powers real-time, `push` powers Airtable→provider. A provider that lacks one capability throws `NotSupported` and the sync engine degrades gracefully (e.g., no webhooks → polling only).

## 3. Auth lifecycles (where most connectors actually die)

### 3.1 API-key providers (Stripe-style) — trivial
Store the key in env. Use **restricted keys** scoped to only the resources you touch. Done.

### 3.2 OAuth2 providers (QuickBooks, GHL) — needs durable token storage

You cannot keep OAuth tokens in env vars: access tokens expire in minutes-to-hours and refresh tokens often **rotate** (QBO gives you a *new* refresh token on every refresh, invalidating the old one — losing one write means re-authorizing by hand). You need:

1. **A token store** — durable, atomic. Options by deployment:
   - Railway: Postgres/Redis (one-click).
   - Vercel-only: Vercel KV / Upstash.
   - Low volume & pragmatic: a locked `Connections` table in the Airtable base itself (fields: Provider, Realm/Location ID, Access Token, Refresh Token, Expires At). Encrypt-at-rest is on Airtable; acceptable for many SMB projects, your call per client's compliance posture.

2. **A token manager** with single-flight refresh (two concurrent requests must not both refresh — with rotating tokens, the second refresh invalidates the first):

```ts
// src/lib/oauth.ts
interface TokenSet { accessToken: string; refreshToken: string; expiresAt: number; }

const inflight = new Map<string, Promise<TokenSet>>();

export async function getAccessToken(provider: string, connectionId: string): Promise<string> {
  const key = `${provider}:${connectionId}`;
  let tokens = await tokenStore.load(key);

  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;

  // Single-flight: concurrent callers await the same refresh
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const fresh = await refreshWithProvider(provider, tokens.refreshToken); // POST to their token URL
      await tokenStore.save(key, fresh);   // MUST persist the NEW refresh token immediately
      return fresh;
    })().finally(() => inflight.delete(key)));
  }
  return (await inflight.get(key)!).accessToken;
}
```

3. **The initial OAuth dance** (one-time per client): a `/oauth/:provider/start` route that redirects to the provider's consent screen, and a `/oauth/:provider/callback` route that exchanges the `code` for tokens and saves them. Build these once in the skeleton; they're identical across providers except for URLs and scopes.

4. **Multi-tenant note:** QBO tokens are per **realm** (company), GHL per **location**. Key the token store by `provider:realmOrLocationId`, not just provider — even if today there's only one client, tomorrow there are three.

## 4. ID linking — the actual heart of any sync

**Rule: Airtable holds the foreign key.** Every synced table gets:

| Field | Type | Purpose |
|---|---|---|
| `{Provider} ID` | Single line text | Their primary key (`cus_…`, QBO Id, GHL contact ID) |
| `{Provider} Synced At` | Date/time | Last successful sync of this record |
| `Sync Status` | Single select | `Synced / Pending / Error / Conflict` — make failures *visible in the base* |
| `Sync Error` | Long text | Last error message, for the client/ops to see |

Why AT-side and not provider-side? (a) Airtable upsert-by-field (`performUpsert.fieldsToMergeOn` on `{Provider} ID`) makes inbound sync a single call with zero lookups; (b) provider custom fields are inconsistent (Stripe metadata is great, QBO custom fields are limited, GHL custom fields need setup per location); (c) the client can *see* the linkage in their base.

**Also store the AT record ID in the provider when possible** (Stripe `metadata.airtable_id`, GHL custom field) — it makes the reverse lookup free and is your recovery path if someone deletes the AT field.

**The unlinked-record problem:** records created in the provider before the integration existed, or created in AT without an external ID yet. Every connector needs a one-time **backfill** (pull all, upsert by a natural key like email — *with a dedupe review pass*, never blind-merge by email in accounting systems) and a defined behavior for AT records with empty `{Provider} ID` (usually: `push` creates, then writes the returned ID back).

## 5. The sync engine — provider-agnostic core

With the Connector interface and ID linking in place, the engine is the same for every provider. Three flows:

### 5.1 Inbound, real-time (their webhook → AT)
```
webhook hits /webhooks/:provider
→ connector.parseWebhook() (verify signature, normalize)
→ idempotency check (event ID)
→ mapper: ExternalRecord → AT fields
→ airtable.upsert(table, [record], ["{Provider} ID"])
→ set Synced At / Sync Status
```

### 5.2 Inbound, reconciliation (poll → AT) — **always build this**
```
cron (15 min – nightly)
→ watermark = load last successful sync time (config table)
→ connector.pullChanges(entity, watermark)
→ same mapper + upsert path as 5.1
→ save new watermark ONLY after full success
```
Webhooks miss events (provider outages, your downtime, expired subscriptions). Reconciliation by `updated_since` watermark self-heals everything. QBO's CDC endpoint exists precisely for this; Stripe has `created`/list filters; GHL has updated-date filters on list endpoints.

### 5.3 Outbound (AT change → provider)
Trigger via Airtable Automation → your endpoint, or the Airtable Webhooks API (chassis doc §6). Then:
```
→ load AT record
→ reverse-mapper: AT fields → provider payload
→ if {Provider} ID empty → connector.push(entity, null, data) → write returned ID back to AT
   else → connector.push(entity, externalId, data)
→ update Synced At / Sync Status (or Sync Error on failure — visible in base)
```

**Echo suppression (critical for two-way):** your outbound push triggers the provider's webhook back at you, which updates AT, which triggers outbound again — an infinite loop. Two defenses, use both:
- **Timestamp guard:** on inbound, skip the write if the AT record's `{Provider} Synced At` is ≥ the event's `updatedAt` (you already have this state).
- **Content guard:** before any write (either direction), diff mapped fields against current values; if nothing changes, don't write. No write → no echo.

## 6. Sync direction & conflict policy — decide per FIELD, not per table

Write this table down with the client before building. It *is* the spec:

| AT field | Provider field | Direction | Truth |
|---|---|---|---|
| Customer Name | QBO DisplayName | AT → QBO | Airtable |
| Invoice Status | QBO Invoice status | QBO → AT | QuickBooks |
| Amount Paid | Stripe amount_received | Stripe → AT | Stripe |
| Pipeline Stage | GHL opportunity stage | AT ⇄ GHL | Last-write-wins |

Rules of thumb:
- **Money and accounting state**: the financial system is always truth (Stripe/QBO → AT, never the reverse for paid amounts, balances, tax).
- **Operational/pipeline state**: usually AT is truth.
- True two-way per field is expensive (needs last-write-wins with reliable timestamps, or conflict flagging). Avoid it unless the client genuinely edits the same field in both systems — most "we need two-way sync" requests dissolve into a per-field direction table like the above.
- When a conflict is detected and policy is "manual": set `Sync Status = Conflict`, write both values into `Sync Error`, and *stop syncing that record* until a human clears it. Never silently overwrite in accounting contexts.

## 7. Provider adapter examples

### 7.1 Stripe (API key, webhooks-first)
```ts
// src/connectors/stripe.ts — sketch
export const stripeConnector: Connector = {
  name: "stripe",

  async pullChanges(entity, since) {
    // List endpoints with created/updated filters; paginate with starting_after
    // e.g. GET /v1/customers?created[gte]=...  (use the official SDK if preferred)
  },

  async push(entity, externalId, data) {
    // POST /v1/customers or POST /v1/customers/{id}
    // Always set metadata.airtable_id for reverse linking
  },

  async parseWebhook(rawBody, headers) {
    // Verify Stripe-Signature: scheme is HMAC over `${timestamp}.${rawBody}`,
    // tolerance-check the timestamp (replay protection). Use stripe.webhooks.constructEvent
    // if using the SDK. Normalize event.data.object → ExternalRecord.
  },
};
```
Quirks: amounts in **cents**; objects reference each other by ID (an invoice event may require a follow-up fetch of the customer); use restricted keys; test mode vs live mode are entirely separate datasets — separate AT bases or a Mode field.

### 7.2 QuickBooks Online (OAuth2, the spiky one)
Quirks that must be handled, in order of pain:
1. **Rotating refresh tokens** — single-flight refresh + persist-before-use (§3.2). This is non-negotiable.
2. **SyncToken on every update** — QBO rejects updates without the object's current `SyncToken`. Flow: GET object → take `SyncToken` → include in update. If you get a stale-object error, re-fetch and retry once.
3. **Sparse updates** — pass `sparse: true` or QBO nulls the fields you omitted. Forgetting this *erases client accounting data*.
4. **Realm ID** — every API path includes the company realm; multi-tenant from day one.
5. **CDC endpoint** (`/cdc?entities=Invoice,Customer&changedSince=...`) — purpose-built for your reconciliation job; prefer it over per-entity polling.
6. Rate limits are modest (throttle like you do Airtable) and the sandbox company is free — develop there.

### 7.3 GoHighLevel (OAuth2 marketplace app)
1. Create a **marketplace app** to get OAuth credentials; tokens are **per location** (sub-account) — key the token store accordingly (§3.2.4).
2. Use the **v2 API (services.leadconnectorhq.com)** — the old v1 API-key surface is legacy; don't build new work on it.
3. Webhooks are subscription-based per event type (ContactCreate, OpportunityStageUpdate, …) — subscribe explicitly to everything you need; an unsubscribed event type fails silently.
4. Custom fields are per-location with their own IDs — resolve custom-field IDs at setup time and cache them in config, never hardcode.
5. Contacts dedupe by email/phone on their side — pushing a contact may *merge* into an existing one and return a different ID than you expected; always trust the returned ID and write it back to AT.

### 7.4 Any new provider — the 8-step recipe
1. Answer the five questions (§1); find the 1–3 quirks (token rotation? version tokens? merge behavior?).
2. Get sandbox/test credentials.
3. Implement the auth piece (API key env var, or OAuth routes + token manager).
4. Implement `parseWebhook` (signature verification first, always).
5. Implement `pullChanges` against their list/changes endpoint with a `since` filter.
6. Implement `push`, writing the returned ID back to AT.
7. Write the field-direction table (§6) with the client; implement mappers both ways.
8. Backfill, then enable real-time, then schedule reconciliation. Walk the chassis doc's §9 checklist.

## 8. Repository layout (extends the chassis repo)

```
src/
├── connectors/
│   ├── types.ts          # Connector interface (§2)
│   ├── stripe.ts
│   ├── quickbooks.ts
│   └── ghl.ts
├── lib/
│   ├── airtable.ts       # from chassis blueprint
│   ├── oauth.ts          # token manager (§3.2)
│   └── ...
├── mappers/
│   ├── stripe.ts         # inbound + outbound mappers, pure functions
│   └── ...
├── sync/
│   ├── engine.ts         # flows 5.1–5.3, provider-agnostic
│   └── watermarks.ts
└── routes/
    ├── oauth.ts          # /oauth/:provider/start + /callback
    └── webhooks/[provider].ts
```

A new integration = one file in `connectors/`, one in `mappers/`, one row of OAuth config, one field-direction table. Everything else is shared.

---

*Companion to the Airtable Custom Integration Blueprint (chassis). Maintained by David Bracho / Airvues.*
