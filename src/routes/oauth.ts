import { Hono } from "hono";
import { env } from "../config.js";
import {
  exchangeCode,
  makeState,
  oauthProviders,
  tokenStore,
  verifyState,
} from "../lib/oauth.js";

/**
 * One-time OAuth dance, identical across providers except URLs/scopes
 * (configured in lib/oauth.ts):
 *   GET /oauth/:provider/start    -> redirect to consent screen
 *   GET /oauth/:provider/callback -> exchange code, persist tokens
 *
 * `state` is HMAC-signed and stateless, so it survives serverless instances.
 */
export const oauth = new Hono();

oauth.get("/:provider/start", (c) => {
  const provider = c.req.param("provider");
  const cfg = oauthProviders[provider];
  if (!cfg) return c.json({ error: `unknown OAuth provider: ${provider}` }, 404);

  const redirectUri = `${env.OAUTH_REDIRECT_BASE_URL}/oauth/${provider}/callback`;
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", makeState());

  return c.redirect(url.toString());
});

oauth.get("/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  const cfg = oauthProviders[provider];
  if (!cfg) return c.json({ error: `unknown OAuth provider: ${provider}` }, 404);

  const query = c.req.query();
  const { code, state } = query;
  if (!state || !verifyState(state)) return c.json({ error: "invalid state" }, 401);
  if (!code) return c.json({ error: "missing code" }, 400);

  const redirectUri = `${env.OAUTH_REDIRECT_BASE_URL}/oauth/${provider}/callback`;
  const { tokens, tokenResponse } = await exchangeCode(provider, code, redirectUri);

  // Multi-tenant: key by realm/location, not just provider (QBO realmId, GHL locationId).
  const tenant = cfg.tenantFromCallback?.(query, tokenResponse) ?? "default";
  await tokenStore.save(`${provider}:${tenant}`, tokens);

  return c.json({ ok: true, provider, connection: tenant });
});
