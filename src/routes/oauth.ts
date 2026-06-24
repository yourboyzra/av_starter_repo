import { Hono } from "hono";
import { env } from "../config.js";
import {
  exchangeCode,
  makeState,
  oauthProviders,
  tokenStore,
  verifyState,
} from "../lib/oauth.js";
import { buildAuthorizeUrl, exchangeOAuthCode, isValidShopDomain, verifyOAuthHmac } from "../connectors/shopify.js";

/**
 * One-time OAuth dance, identical across providers except URLs/scopes
 * (configured in lib/oauth.ts):
 *   GET /oauth/:provider/start    -> redirect to consent screen
 *   GET /oauth/:provider/callback -> exchange code, persist tokens
 *
 * `state` is HMAC-signed and stateless, so it survives serverless instances.
 */
export const oauth = new Hono();

/**
 * Shopify gets its own routes, not the generic :provider scaffold above —
 * Shopify signs both the install ping AND the callback with its own
 * query-string HMAC (verifyOAuthHmac), which the generic flow has no concept
 * of, and Shopify itself initiates the install ping (not a user clicking a
 * "Connect" link in our UI). Set this app's "App URL" to
 * {OAUTH_REDIRECT_BASE_URL}/oauth/shopify/start and "Redirect URLs" to
 * {OAUTH_REDIRECT_BASE_URL}/oauth/shopify/callback in the Partner Dashboard.
 */
oauth.get("/shopify/start", (c) => {
  const query = c.req.query();
  const shop = query["shop"];
  if (!isValidShopDomain(shop)) return c.json({ error: "missing or invalid shop param" }, 400);
  if (!verifyOAuthHmac(query)) return c.json({ error: "invalid hmac" }, 401);

  const redirectUri = `${env.OAUTH_REDIRECT_BASE_URL}/oauth/shopify/callback`;
  return c.redirect(buildAuthorizeUrl(shop, redirectUri, makeState()));
});

oauth.get("/shopify/callback", async (c) => {
  const query = c.req.query();
  const { code, state, shop } = query;
  if (!isValidShopDomain(shop)) return c.json({ error: "missing or invalid shop param" }, 400);
  if (!verifyOAuthHmac(query)) return c.json({ error: "invalid hmac" }, 401);
  if (!state || !verifyState(state)) return c.json({ error: "invalid state" }, 401);
  if (!code) return c.json({ error: "missing code" }, 400);

  const accessToken = await exchangeOAuthCode(shop, code);
  // Shopify's offline token (no expiring=1 requested) never expires — a
  // far-future expiresAt means getAccessToken never attempts to refresh it
  // (there is no refresh_token to refresh with anyway).
  await tokenStore.save(`shopify:${shop}`, { accessToken, refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER });

  return c.text("Lux Lampshade <-> Shopify connection installed. You can close this tab.");
});

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
