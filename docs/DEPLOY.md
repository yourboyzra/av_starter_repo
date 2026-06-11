# Deploying: Vercel or Railway

One codebase, two targets — **pick one platform per project and follow only that column's path**. Both files (`vercel.json`, `railway.toml`) live in the repo; each platform ignores the other's. Don't delete either.

## Step 0 — Which platform? (30-second decision)

| Your workload | Choose |
|---|---|
| Pure webhook relay, light processing | **Vercel** — serverless, scales to zero |
| Polling loops, batch syncs (1,000+ records), jobs longer than ~60 s, queues, WebSockets | **Railway** — persistent process, no function timeouts |
| Spiky/heavy hybrid | Webhooks on Vercel + worker on Railway (advanced; see chassis blueprint §7) |

Rule of thumb: if any single sync pass could exceed your Vercel plan's function duration limit, use Railway.

## Step 1 — Shared setup (both platforms)

1. Airtable base ready: `{Provider} ID` / `{Provider} Synced At` / `Sync Status` / `Sync Error` on each synced table, plus `Events Log` and `Sync Config` tables (see README quickstart).
2. Scoped PAT created (not the personal all-access token).
3. Env vars from `.env.example` in hand. **Required everywhere:** `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `INTERNAL_JOB_SECRET`. Provider vars as needed (`STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, OAuth client IDs, `OAUTH_REDIRECT_BASE_URL` = your public deploy URL).
4. Use a **staging base with its own PAT** for the first deploy. Never test against the client's production base.

## Step 2 — Platform path

### Path A: Vercel

1. `npm i -g vercel && vercel link` (or import the repo in the dashboard).
2. Set env vars in **Project → Settings → Environment Variables** — Production and Preview separately.
3. Entry point is already wired: `api/index.ts` + the rewrite in `vercel.json` route everything to the Hono app. Don't add other files under `api/`.
4. Cron is already declared in `vercel.json` (`/jobs/sync` every 15 min, `/jobs/refresh-webhooks` daily). **Vercel Cron sends GET without headers** — the job routes accept `?token=`, so after deploy, edit the cron paths to include it: `/jobs/sync?token=<INTERNAL_JOB_SECRET>`. Adjust schedules per project.
5. `vercel deploy --prod`.
6. Webhook URL for providers: `https://<project>.vercel.app/webhooks/<provider>`.

**Vercel gotchas**
- Function duration limit applies to `/jobs/sync` — if reconciliation can run long, lower the entity count per pass or move to Railway.
- No in-process cron or workers; only `vercel.json` crons run. `node-cron` never starts here (guarded by `RAILWAY_ENVIRONMENT`).
- Cold starts are normal and fine for webhooks.

### Path B: Railway

1. `railway init` + `railway up` (or connect the GitHub repo for deploy-on-push). `railway.toml` already sets build (`npm run build`), start (`npm run start`), healthcheck (`/health`), and restart-on-failure.
2. Set env vars: `railway variables set KEY=value ...` or the dashboard.
3. **Do not set `PORT`** — Railway injects it; the app binds to it automatically.
4. Cron runs in-process via node-cron (sync every 15 min, webhook refresh daily) — enabled automatically because Railway sets `RAILWAY_ENVIRONMENT`. Change schedules in `src/index.ts`. The `vercel.json` crons are ignored here.
5. Webhook URL for providers: `https://<service>.up.railway.app/webhooks/<provider>` (or your custom domain).

**Railway gotchas**
- One always-on container = per-resource billing; it never scales to zero.
- For heavy webhook processing, add Redis from the dashboard (injects `REDIS_URL`) and a BullMQ worker — receive, enqueue, return 200.
- Healthcheck failures block deploys: if a deploy hangs, check that the app boots (missing env vars crash on purpose — read the logs).

## Step 3 — Post-deploy verification (both)

1. `GET https://<app>/health` → `{ ok: true }`.
2. Register the webhook URL with the provider, send a **test event**, confirm the record lands in Airtable.
3. Run reconciliation once manually:
   `curl -X POST https://<app>/jobs/sync -H "Authorization: Bearer $INTERNAL_JOB_SECRET"`.
4. Point an uptime monitor at `/health`.
5. Walk the security checklist (chassis blueprint §9) before touching production data.
