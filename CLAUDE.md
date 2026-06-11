# House rules — Airtable integration template (Airvues)

This repo is the template for all Airtable <-> third-party integrations. Blueprints live in `docs/` — read them before changing architecture.

## Non-negotiables

1. **All Airtable reads/writes go through `src/lib/airtable.ts`.** Never call the Airtable API with raw `fetch`, never `Promise.all()` Airtable requests. The client enforces the 5 rps/base limit, 10-record batching, and 429/5xx retries.
2. **Field IDs in production.** Mappers ship with field *names* for readability during development; before a client deploy, switch every mapper and merge key to field IDs (`returnFieldsByFieldId: true`, IDs in writes). Clients rename fields; field IDs never change.
3. **New providers implement the `Connector` interface** (`src/connectors/types.ts`): `pullChanges`, `push`, `parseWebhook`. One adapter file in `src/connectors/`, one mapper spec in `src/mappers/`, one entry in the registry (`src/connectors/registry.ts`). Do not touch the sync engine for a new provider.

## Other rules

- Webhook signatures verified on the **raw body** with `timingSafeEqual` — before JSON parsing. No unverified webhook routes, ever.
- Every inbound event passes the idempotency check (`src/lib/idempotency.ts`).
- Job/cron endpoints require `INTERNAL_JOB_SECRET` (Bearer header, or `?token=` for Vercel Cron).
- Escape user input in `filterByFormula` with `fEscape`.
- OAuth tokens never live in env vars — use the token manager (`src/lib/oauth.ts`); its refresh is single-flight because providers like QBO rotate refresh tokens.
- Always build the reconciliation path (`pullChanges` + watermark), even for webhook-driven providers.
- Mappers are pure functions: payload in, fields out. They are the only per-provider files besides the adapter.
- `npm run build` (tsc strict) and `npm test` (vitest) must pass before any commit.
- New providers get tests: mapper tests (pure functions — copy `tests/mappers.stripe.test.ts`) and a `parseWebhook` signature accept/reject test (copy `tests/connectors.stripe.test.ts`). The engine tests are shared and don't change per provider.
