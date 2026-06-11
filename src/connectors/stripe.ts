import { requireEnv } from "../config.js";
import { verifyStripeSignature } from "../lib/verify.js";
import {
  InvalidSignatureError,
  NotSupportedError,
  type Connector,
  type ExternalRecord,
  type WebhookEvent,
} from "./types.js";

/**
 * Stripe adapter — the reference Connector implementation (API-key auth,
 * webhooks-first). No SDK: raw fetch, full control.
 *
 * Quirks: amounts are in CENTS; objects reference each other by ID (an
 * invoice event may need a follow-up fetch of the customer); use RESTRICTED
 * keys; test mode and live mode are entirely separate datasets — use separate
 * bases or a Mode field.
 */

const API = "https://api.stripe.com/v1";

/** entity -> Stripe REST collection */
const COLLECTIONS: Record<string, string> = {
  customer: "customers",
  invoice: "invoices",
  payment_intent: "payment_intents",
};

/** Flatten {a: {b: 1}} -> a[b]=1 for Stripe's form encoding. */
function formEncode(data: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      formEncode(v as Record<string, unknown>, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

async function stripeRequest<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv("STRIPE_API_KEY")}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? formEncode(body) : undefined,
  });
  if (!res.ok) throw new Error(`Stripe ${res.status} ${path}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface StripeEvent {
  id: string;
  type: string; // e.g. "customer.updated"
  created: number; // unix seconds
  data: { object: { id: string; [k: string]: unknown } };
}

function normalizeEvent(evt: StripeEvent): ExternalRecord {
  return {
    externalId: evt.data.object.id,
    entity: evt.type.split(".")[0] ?? evt.type, // "customer.updated" -> "customer"
    updatedAt: new Date(evt.created * 1000).toISOString(),
    raw: evt.data.object,
  };
}

export const stripeConnector: Connector = {
  name: "stripe",

  /**
   * Reconciliation via the Events API: one endpoint covers creates AND
   * updates for any entity (plain list endpoints only filter by `created`).
   * Note: Stripe retains events for 30 days — run reconciliation well within
   * that window.
   */
  async pullChanges(entity, since) {
    if (!COLLECTIONS[entity]) throw new NotSupportedError(`entity ${entity}`);
    const sinceUnix = Math.floor(new Date(since).getTime() / 1000);

    const out: ExternalRecord[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({
        limit: "100",
        "created[gte]": String(sinceUnix),
        "types[]": `${entity}.*`,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const page = await stripeRequest<{ data: StripeEvent[]; has_more: boolean }>("GET", `events?${qs}`);
      out.push(...page.data.map(normalizeEvent));
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1]!.id;
    }
    return out;
  },

  /**
   * Create or update. Always sets metadata.airtable_id (passed in `data` by
   * the mapper) so the reverse lookup is free — it's the recovery path if
   * someone deletes the linking field in the base.
   */
  async push(entity, externalId, data) {
    const collection = COLLECTIONS[entity];
    if (!collection) throw new NotSupportedError(`entity ${entity}`);
    const path = externalId ? `${collection}/${externalId}` : collection;
    const result = await stripeRequest<{ id: string }>("POST", path, data);
    return result.id;
  },

  /** Verify Stripe-Signature (HMAC over `${t}.${rawBody}`, replay-protected). */
  async parseWebhook(rawBody, headers): Promise<WebhookEvent> {
    const sig = headers["stripe-signature"] ?? "";
    if (!verifyStripeSignature(rawBody, sig, requireEnv("STRIPE_WEBHOOK_SECRET"))) {
      throw new InvalidSignatureError();
    }
    const evt = JSON.parse(rawBody) as StripeEvent;
    return { eventId: evt.id, records: [normalizeEvent(evt)] };
  },
};
