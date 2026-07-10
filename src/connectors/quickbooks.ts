import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env, requireEnv } from "../config.js";
import { getAccessToken } from "../lib/oauth.js";
import {
  InvalidSignatureError,
  NotSupportedError,
  type Connector,
  type ExternalRecord,
  type WebhookEvent,
} from "./types.js";

/**
 * QuickBooks Online adapter — REST v3 API. OAuth2 with rotating refresh
 * tokens (handled by src/lib/oauth.js single-flight refresh).
 *
 * Quirks that kill naive integrations:
 * - Rotating refresh tokens: every refresh issues a NEW refresh token.
 *   src/lib/oauth.ts persists it before use and uses single-flight so two
 *   concurrent refreshes can't race and invalidate each other.
 * - SyncToken on every update: QBO rejects updates that don't include the
 *   object's current SyncToken. We GET the record first, extract SyncToken,
 *   then POST ?operation=update — never skip this step.
 * - sparse: true on updates: without it, QBO nulls any field you omit.
 *   Always include it.
 * - Updates are POST ?operation=update, NOT PUT.
 * - Realm ID in every URL path — this is the QBO company ID returned in the
 *   OAuth callback's ?realmId= param and stored in QUICKBOOKS_REALM_ID.
 * - CDC endpoint is the right reconciliation mechanism — it returns all
 *   changed entities since a timestamp in one call, no per-entity polling.
 */

/** Entity name → REST path segment used in CRUD calls */
const ENTITY_PATH: Record<string, string> = {
  vendor: "vendor",
  purchase_order: "purchaseorder",
};

/** Entity name → CDC entity name (QB uses PascalCase) */
const CDC_ENTITY: Record<string, string> = {
  vendor: "Vendor",
  purchase_order: "PurchaseOrder",
};

function baseUrl(): string {
  const host =
    env.QUICKBOOKS_ENVIRONMENT === "production"
      ? "quickbooks.api.intuit.com"
      : "sandbox-quickbooks.api.intuit.com";
  return `https://${host}/v3/company/${requireEnv("QUICKBOOKS_REALM_ID")}`;
}

async function qbRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const realmId = requireEnv("QUICKBOOKS_REALM_ID");
  const accessToken = await getAccessToken("quickbooks", realmId);
  const res = await fetch(`${baseUrl()}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`QuickBooks ${res.status} ${path}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface QBEntity {
  Id: string;
  SyncToken: string;
  MetaData: { LastUpdatedTime: string };
  [k: string]: unknown;
}

interface CDCResponse {
  CDCResponse: Array<{
    QueryResponse: Array<Record<string, QBEntity[]>>;
  }>;
}

function normalizeEntity(entity: string, obj: QBEntity): ExternalRecord {
  return {
    externalId: obj.Id,
    entity,
    updatedAt: obj.MetaData.LastUpdatedTime,
    raw: obj,
  };
}

/**
 * Create or update a QB PurchaseOrder, returning both the Id and DocNumber
 * so callers can write the human-readable PO number back to Airtable
 * immediately without waiting for the next inbound sync cycle.
 */
export async function createOrUpdatePurchaseOrder(
  externalId: string | null,
  data: unknown
): Promise<{ id: string; docNumber?: string }> {
  if (externalId) {
    const current = await qbRequest<Record<string, QBEntity>>("GET", `purchaseorder/${externalId}`);
    const key = Object.keys(current).find((k) => k !== "time");
    const syncToken = key ? current[key]?.SyncToken : undefined;
    if (!syncToken) throw new Error(`Could not read SyncToken for purchaseorder ${externalId}`);
    const payload = { ...(data as object), Id: externalId, SyncToken: syncToken, sparse: true };
    const result = await qbRequest<Record<string, QBEntity>>("POST", "purchaseorder?operation=update", payload);
    const resultKey = Object.keys(result).find((k) => k !== "time");
    return {
      id: resultKey ? (result[resultKey]!.Id ?? externalId) : externalId,
      docNumber: resultKey ? (result[resultKey]!.DocNumber as string | undefined) : undefined,
    };
  }

  const result = await qbRequest<Record<string, QBEntity>>("POST", "purchaseorder", data);
  const resultKey = Object.keys(result).find((k) => k !== "time");
  if (!resultKey || !result[resultKey]?.Id) throw new Error("QuickBooks purchaseorder create returned no Id");
  return {
    id: result[resultKey]!.Id,
    docNumber: result[resultKey]!.DocNumber as string | undefined,
  };
}

export const quickbooksConnector: Connector = {
  name: "quickbooks",

  /**
   * Reconciliation via the CDC (Change Data Capture) endpoint — QB's
   * purpose-built diff feed. Returns all changed entities since the watermark
   * in one call. Much more efficient than per-entity polling.
   *
   * Note: CDC only retains 365 days of history. Watermarks older than that
   * will return an error; the fallback is to pull all records without a filter.
   */
  async pullChanges(entity, since): Promise<ExternalRecord[]> {
    const cdcName = CDC_ENTITY[entity];
    if (!cdcName) throw new NotSupportedError(`entity ${entity}`);

    const qs = new URLSearchParams({ entities: cdcName, changedSince: since });
    const res = await qbRequest<CDCResponse>("GET", `cdc?${qs}`);

    const records: ExternalRecord[] = [];
    for (const queryResponse of res.CDCResponse[0]?.QueryResponse ?? []) {
      for (const item of queryResponse[cdcName] ?? []) {
        records.push(normalizeEntity(entity, item));
      }
    }
    return records;
  },

  /**
   * Create (externalId null) or update (externalId set) a QB entity.
   *
   * Update flow (non-negotiable):
   *   1. GET current record → extract SyncToken
   *   2. POST ?operation=update with SyncToken + sparse:true + your changes
   *
   * A stale SyncToken returns a 409 Conflict — caller should retry after
   * re-fetching if this becomes a problem (rare with single-writer setup).
   */
  async push(entity, externalId, data): Promise<string> {
    const path = ENTITY_PATH[entity];
    if (!path) throw new NotSupportedError(`entity ${entity}`);

    if (externalId) {
      const current = await qbRequest<Record<string, QBEntity>>("GET", `${path}/${externalId}`);
      const key = Object.keys(current).find((k) => k !== "time");
      const syncToken = key ? current[key]?.SyncToken : undefined;
      if (!syncToken) throw new Error(`Could not read SyncToken for ${entity} ${externalId}`);

      const payload = { ...data, Id: externalId, SyncToken: syncToken, sparse: true };
      const result = await qbRequest<Record<string, QBEntity>>("POST", `${path}?operation=update`, payload);
      const resultKey = Object.keys(result).find((k) => k !== "time");
      return resultKey ? (result[resultKey]!.Id ?? externalId) : externalId;
    }

    const result = await qbRequest<Record<string, QBEntity>>("POST", path, data);
    const resultKey = Object.keys(result).find((k) => k !== "time");
    if (!resultKey || !result[resultKey]?.Id) throw new Error(`QuickBooks ${path} create returned no Id`);
    return result[resultKey]!.Id;
  },

  /**
   * QB webhooks are event notifications, not payloads: the body tells us
   * which entities changed (name + Id), not the new values. We re-fetch
   * each entity individually for authoritative state — same follow-up fetch
   * pattern as the ShipStation connector.
   *
   * Signature: intuit-signature header is base64 HMAC-SHA256 of the raw body
   * using QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN (from QB app > Webhooks page).
   *
   * Idempotency: QB has no delivery ID field — we hash the raw body.
   * This only dedupes byte-identical redeliveries, which is fine for QB's
   * at-least-once delivery model.
   */
  async parseWebhook(rawBody, headers): Promise<WebhookEvent> {
    const sig = headers["intuit-signature"] ?? "";
    const verifierToken = requireEnv("QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN");
    const expected = createHmac("sha256", verifierToken).update(rawBody).digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidSignatureError();

    const body = JSON.parse(rawBody) as {
      eventNotifications: Array<{
        dataChangeEvent: {
          entities: Array<{ name: string; id: string; operation: string; lastUpdated: string }>;
        };
      }>;
    };

    const records: ExternalRecord[] = [];
    for (const notification of body.eventNotifications ?? []) {
      for (const changed of notification.dataChangeEvent?.entities ?? []) {
        const entity = Object.keys(CDC_ENTITY).find((k) => CDC_ENTITY[k] === changed.name);
        if (!entity) continue;
        const path = ENTITY_PATH[entity]!;
        try {
          const current = await qbRequest<Record<string, QBEntity>>("GET", `${path}/${changed.id}`);
          const key = Object.keys(current).find((k) => k !== "time");
          if (key && current[key]) records.push(normalizeEntity(entity, current[key]!));
        } catch (err) {
          console.error(`QB webhook: failed to fetch ${entity} ${changed.id}: ${err}`);
        }
      }
    }

    const eventId = createHash("sha256").update(rawBody).digest("hex");
    return { eventId, records };
  },
};

/**
 * Fetch a Purchase Order as a PDF binary. Returns the raw Response for the
 * caller to buffer — attaching to Airtable requires a separate upload step
 * (Airtable attachment upload endpoint or a public URL).
 */
export async function fetchPoPdf(poId: string): Promise<Response> {
  const realmId = requireEnv("QUICKBOOKS_REALM_ID");
  const accessToken = await getAccessToken("quickbooks", realmId);
  const res = await fetch(`${baseUrl()}/purchaseorder/${poId}/pdf`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/pdf" },
  });
  if (!res.ok) throw new Error(`QuickBooks PDF ${res.status} for PO ${poId}: ${await res.text()}`);
  return res;
}
