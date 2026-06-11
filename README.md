# Airtable Integration Template

Airvues template for production-grade Airtable <-> third-party integrations. Hono + TypeScript (strict), deploys to **Vercel** or **Railway** unchanged. Stripe ships as the reference connector; new providers are one adapter file + one mapper spec.

Full rationale and patterns: [`docs/airtable-integration-blueprint.md`](docs/airtable-integration-blueprint.md) (chassis) and [`docs/airtable-connector-blueprint.md`](docs/airtable-connector-blueprint.md) (connector layer). House rules: [`CLAUDE.md`](CLAUDE.md).

## Quickstart (30-minute path)

1. Clone, `npm install`, copy `.env.example` -> `.env`.
2. Create/duplicate the Airtable base. Each synced table needs: `{Provider} ID`, `{Provider} Synced At`, `Sync Status`, `Sync Error`. Add an `Events Log` table (`Event ID`, `Provider`, `Processed At`) and a `Sync Config` table (`Key`, `Value`).
3. Create a scoped PAT; fill `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `INTERNAL_JOB_SECRET`.
4. For Stripe: set `STRIPE_API_KEY` (restricted key) + `STRIPE_WEBHOOK_SECRET`. For a new provider: implement `Connector` in `src/connectors/`, write mappers in `src/mappers/`, register in `src/connectors/registry.ts`.
5. `npm test` (mappers, signature verification, sync-engine guards), then `npm run dev` -> `GET /health` should return `{ ok: true }`.
6. Deploy — follow **[`docs/DEPLOY.md`](docs/DEPLOY.md)**: pick Vercel or Railway in 30 seconds, then follow only that path's checklist.
7. Register `https://<app>/webhooks/stripe` with the provider; fire a test event; confirm the record lands.
8. Run reconciliation once manually: `curl -X POST https://<app>/jobs/sync -H "Authorization: Bearer $INTERNAL_JOB_SECRET"`.
9. Walk the security checklist (chassis blueprint §9). Ship.

## Routes

| Route | Purpose |
|---|---|
| `GET /health` | Health check (Railway healthcheck + uptime monitor) |
| `POST /webhooks/:provider` | Inbound events — signature-verified, idempotent |
| `POST /jobs/sync` (or GET with `?token=`) | Reconciliation by watermark |
| `POST /jobs/refresh-webhooks` | Refresh Airtable webhooks (7-day expiry) |
| `POST /jobs/outbound` | Airtable -> provider push (called by Airtable Automation) |
| `GET /oauth/:provider/start` / `/callback` | One-time OAuth dance for OAuth2 providers |

## Layout

```
src/
├── index.ts              # Hono app (serves on Railway/local; exported for Vercel via api/)
├── config.ts             # Zod env validation — crashes loudly on boot if misconfigured
├── lib/
│   ├── airtable.ts       # THE Airtable client: throttled, retrying, batch + upsert
│   ├── verify.ts         # HMAC verification (hex + base64, timingSafeEqual)
│   ├── idempotency.ts    # Events Log dedupe
│   └── oauth.ts          # Token manager: durable store + single-flight refresh
├── connectors/
│   ├── types.ts          # Connector interface — the per-provider contract
│   ├── registry.ts       # provider name -> { connector, specs }
│   └── stripe.ts         # reference implementation
├── mappers/stripe.ts     # pure mapping specs (entity -> table/fields, both directions)
├── sync/
│   ├── engine.ts         # inbound/reconciliation/outbound flows, echo suppression
│   └── watermarks.ts     # Sync Config table watermarks
├── routes/               # health, oauth, webhooks/[provider]
└── jobs/                 # sync, refresh-webhooks
tests/                    # vitest — copy the stripe mapper/connector tests for new providers
```

## Adding a provider (8-step recipe)

See connector blueprint §7.4. In short: answer the five questions, find the quirks (token rotation? sync tokens? merge-on-push?), implement the three `Connector` methods, write the field-direction table with the client, map both ways, backfill, enable real-time, schedule reconciliation.
# av_starter_repo
