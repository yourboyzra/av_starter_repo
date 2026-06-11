import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { airtable } from "./airtable.js";
import { env, requireEnv } from "../config.js";

/**
 * OAuth2 token management. Tokens can NOT live in env vars: access tokens
 * expire in minutes-to-hours and refresh tokens often ROTATE (QBO issues a
 * new refresh token on every refresh, invalidating the old one — losing one
 * write means re-authorizing by hand). Hence:
 *
 *   1. A durable token store (default: a locked `Connections` table in the
 *      base — pragmatic for SMB volume; swap for Postgres/Redis/KV by
 *      implementing TokenStore).
 *   2. Single-flight refresh: concurrent callers await the SAME refresh, and
 *      the new refresh token is persisted before anyone uses it.
 *
 * Multi-tenant: key everything by `provider:realmOrLocationId`, never just
 * provider — QBO tokens are per realm, GHL per location.
 */

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface TokenStore {
  load(key: string): Promise<TokenSet | null>;
  save(key: string, tokens: TokenSet): Promise<void>;
}

/** Default store: `Connections` table (Key, Access Token, Refresh Token, Expires At). */
export class AirtableTokenStore implements TokenStore {
  constructor(private table = "Connections") {}

  async load(key: string): Promise<TokenSet | null> {
    const rec = await airtable.findByField(this.table, "Key", key);
    if (!rec) return null;
    return {
      accessToken: String(rec.fields["Access Token"] ?? ""),
      refreshToken: String(rec.fields["Refresh Token"] ?? ""),
      expiresAt: Number(rec.fields["Expires At"] ?? 0),
    };
  }

  async save(key: string, tokens: TokenSet): Promise<void> {
    const fields = {
      Key: key,
      "Access Token": tokens.accessToken,
      "Refresh Token": tokens.refreshToken,
      "Expires At": tokens.expiresAt,
    };
    const existing = await airtable.findByField(this.table, "Key", key);
    if (existing) await airtable.update(this.table, [{ id: existing.id, fields }]);
    else await airtable.create(this.table, [{ fields }]);
  }
}

export const tokenStore: TokenStore = new AirtableTokenStore();

// ---------------------------------------------------------------------------
// Provider OAuth configuration
// ---------------------------------------------------------------------------

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: () => string;
  clientSecret: () => string;
  scopes: string[];
  /** Extract the tenant key (QBO realmId, GHL locationId) from the callback. */
  tenantFromCallback?: (query: Record<string, string | undefined>, tokenResponse: Record<string, unknown>) => string;
}

export const oauthProviders: Record<string, OAuthProviderConfig> = {
  quickbooks: {
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    clientId: () => requireEnv("QUICKBOOKS_CLIENT_ID"),
    clientSecret: () => requireEnv("QUICKBOOKS_CLIENT_SECRET"),
    scopes: ["com.intuit.quickbooks.accounting"],
    tenantFromCallback: (query) => query["realmId"] ?? "default",
  },
  ghl: {
    authorizeUrl: "https://marketplace.gohighlevel.com/oauth/chooselocation",
    tokenUrl: "https://services.leadconnectorhq.com/oauth/token",
    clientId: () => requireEnv("GHL_CLIENT_ID"),
    clientSecret: () => requireEnv("GHL_CLIENT_SECRET"),
    scopes: ["contacts.readonly", "contacts.write"],
    tenantFromCallback: (_query, tokenResponse) => String(tokenResponse["locationId"] ?? "default"),
  },
};

// ---------------------------------------------------------------------------
// Single-flight refresh
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<TokenSet>>();

async function refreshWithProvider(provider: string, refreshToken: string): Promise<TokenSet> {
  const cfg = oauthProviders[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${cfg.clientId()}:${cfg.clientSecret()}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`${provider} token refresh failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: String(json["access_token"]),
    refreshToken: String(json["refresh_token"] ?? refreshToken), // some providers don't rotate
    expiresAt: Date.now() + Number(json["expires_in"] ?? 3600) * 1000,
  };
}

/**
 * Get a valid access token for `provider:connectionId`, refreshing if it
 * expires within 60 s. Concurrent callers share one refresh (single-flight) —
 * with rotating refresh tokens, a second parallel refresh would invalidate
 * the first.
 */
export async function getAccessToken(provider: string, connectionId: string): Promise<string> {
  const key = `${provider}:${connectionId}`;
  const tokens = await tokenStore.load(key);
  if (!tokens) throw new Error(`No stored connection for ${key} — run /oauth/${provider}/start first`);

  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;

  let refresh = inflight.get(key);
  if (!refresh) {
    refresh = (async () => {
      const fresh = await refreshWithProvider(provider, tokens.refreshToken);
      await tokenStore.save(key, fresh); // MUST persist the NEW refresh token before use
      return fresh;
    })().finally(() => inflight.delete(key));
    inflight.set(key, refresh);
  }
  return (await refresh).accessToken;
}

/** Exchange the authorization code from the callback for the first token set. */
export async function exchangeCode(provider: string, code: string, redirectUri: string): Promise<{ tokens: TokenSet; tokenResponse: Record<string, unknown> }> {
  const cfg = oauthProviders[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${cfg.clientId()}:${cfg.clientSecret()}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`${provider} code exchange failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as Record<string, unknown>;
  return {
    tokens: {
      accessToken: String(json["access_token"]),
      refreshToken: String(json["refresh_token"] ?? ""),
      expiresAt: Date.now() + Number(json["expires_in"] ?? 3600) * 1000,
    },
    tokenResponse: json,
  };
}

// ---------------------------------------------------------------------------
// Stateless, HMAC-signed OAuth `state` (works across serverless instances)
// ---------------------------------------------------------------------------

export function makeState(): string {
  const payload = `${Date.now()}.${randomBytes(8).toString("hex")}`;
  const sig = createHmac("sha256", env.INTERNAL_JOB_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyState(state: string, maxAgeMs = 10 * 60_000): boolean {
  const i = state.lastIndexOf(".");
  if (i < 0) return false;
  const payload = state.slice(0, i);
  const sig = state.slice(i + 1);
  const expected = createHmac("sha256", env.INTERNAL_JOB_SECRET).update(payload).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const ts = Number(payload.split(".")[0]);
  return Number.isFinite(ts) && Date.now() - ts < maxAgeMs;
}
