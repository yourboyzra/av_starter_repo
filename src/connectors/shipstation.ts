import { createHash } from "node:crypto";
import { requireEnv } from "../config.js";
import { verifySharedSecret } from "../lib/verify.js";
import {
  InvalidSignatureError,
  NotSupportedError,
  type Connector,
  type ExternalRecord,
  type WebhookEvent,
} from "./types.js";

/**
 * ShipStation adapter — V2 API. API key auth (`api-key` header). Label
 * purchase (which spends real postage money) is deliberately NOT part of
 * this connector — `tracking_number` only exists on the *label* resource,
 * created via a separate, explicit job (not the generic push/pullChanges
 * flow), so a sync/reconciliation pass can never accidentally buy postage.
 *
 * Quirks:
 * - No body HMAC for webhooks. "Verification" is a custom header (key+value)
 *   you configure when creating the webhook subscription (POST
 *   /v2/environment/webhooks, `headers: [{key, value}]`) — ShipStation just
 *   echoes it back on every delivery. See WEBHOOK_SECRET_HEADER below.
 * - The exact webhook payload shape isn't documented publicly; parseWebhook
 *   extracts a shipment_id defensively from a few plausible locations, then
 *   re-fetches the authoritative shipment via GET — same "follow-up fetch"
 *   pattern the Stripe connector uses for related data. VERIFY THIS against
 *   a real test webhook delivery before relying on it in production.
 * - There's also no documented webhook delivery-id field, so eventId falls
 *   back to a content hash of the raw body for idempotency dedup — this
 *   only catches byte-identical redeliveries, not logically-duplicate ones.
 */

const BASE = "https://api.shipstation.com";

/** Header name we register as the custom webhook header at subscription time. */
export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

async function shipstationRequest<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "api-key": requireEnv("SHIPSTATION_API_KEY"),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`ShipStation ${res.status} ${path}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface ShipStationShipment {
  shipment_id: string;
  external_shipment_id?: string | null;
  modified_at: string;
  ship_date?: string | null;
  shipment_status?: string | null;
  requested_shipment_service?: string | null;
  service_code?: string | null;
  [k: string]: unknown;
}

function normalizeShipment(s: ShipStationShipment): ExternalRecord {
  return {
    externalId: s.shipment_id,
    entity: "shipment",
    updatedAt: s.modified_at,
    raw: s,
  };
}

/** Defensive extraction — the real webhook payload shape is unconfirmed; see header comment. */
function extractShipmentId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const candidate = p["shipment_id"] ?? (p["shipment"] as Record<string, unknown> | undefined)?.["shipment_id"];
  return typeof candidate === "string" ? candidate : undefined;
}

export interface ShipStationRate {
  rate_id: string;
  service_code: string;
  service_type: string;
  carrier_friendly_name: string;
  shipping_amount: { amount: number; currency: string };
  carrier_delivery_days?: string | null;
  error_messages?: string[];
}

/** Fetch available rates for a shipment spec built by mapOut. */
export async function getShipmentRates(shipmentSpec: Record<string, unknown>): Promise<ShipStationRate[]> {
  const carriersRes = await shipstationRequest<{ carriers: { carrier_id: string }[] }>("GET", "/v2/carriers");
  const carrierIds = (carriersRes.carriers ?? []).map((c) => c.carrier_id);
  if (carrierIds.length === 0) throw new Error("No carriers configured in ShipStation account");

  const result = await shipstationRequest<{ rates: ShipStationRate[]; invalid_rates?: unknown[] }>("POST", "/v2/rates", {
    rate_options: { carrier_ids: carrierIds },
    shipment: shipmentSpec,
  });
  console.log("[rates] valid:", result.rates?.length ?? 0, "invalid:", result.invalid_rates?.length ?? 0);
  if (result.invalid_rates?.length) console.log("[rates] invalid_rates sample:", JSON.stringify(result.invalid_rates[0]));
  return result.rates ?? [];
}

/**
 * Purchase a label using a previously-quoted ShipStation rate_id.
 * This is the one place in the codebase that spends real postage money —
 * it is intentionally NOT wired into the generic push/pullChanges flow.
 */
export async function createLabelFromRate(rateId: string): Promise<{ trackingNumber: string; labelId: string; shipmentId: string }> {
  const result = await shipstationRequest<{
    label_id: string;
    shipment_id: string;
    tracking_number: string;
  }>("POST", `/v2/labels/rates/${rateId}`, {
    label_format: "pdf",
    label_layout: "4x6",
    display_scheme: "label",
  });
  return {
    trackingNumber: result.tracking_number,
    labelId: result.label_id,
    shipmentId: result.shipment_id,
  };
}

export const shipstationConnector: Connector = {
  name: "shipstation",

  async pullChanges(entity) {
    throw new NotSupportedError(`pullChanges for ${entity} — ShipStation shipments are Airtable-initiated; tracking comes back via createLabelFromRate, not reconciliation`);
  },

  /** Creates (externalId null) or updates (externalId set) a shipment — never buys a label. */
  async push(entity, externalId, data) {
    if (entity !== "shipment") throw new NotSupportedError(`entity ${entity}`);

    if (!externalId) {
      const result: { has_errors: boolean; shipments: (ShipStationShipment & { errors?: string[] })[] } =
        await shipstationRequest("POST", "/v2/shipments", { shipments: [data] });
      const created = result.shipments[0];
      if (!created) throw new Error("ShipStation returned no shipment");
      if (created.errors && created.errors.length > 0) {
        throw new Error(`ShipStation shipment errors: ${created.errors.join("; ")}`);
      }
      return created.shipment_id;
    }

    const updated: ShipStationShipment = await shipstationRequest("PUT", `/v2/shipments/${externalId}`, data);
    return updated.shipment_id;
  },

  /**
   * Verify the shared-secret custom header, dedupe by a content hash of the
   * raw body (no documented delivery-id field — see header comment), then
   * re-fetch the shipment by ID for authoritative current state.
   */
  async parseWebhook(rawBody, headers): Promise<WebhookEvent> {
    if (!verifySharedSecret(headers[WEBHOOK_SECRET_HEADER], requireEnv("SHIPSTATION_WEBHOOK_SECRET"))) {
      throw new InvalidSignatureError();
    }

    const payload = JSON.parse(rawBody) as unknown;
    const shipmentId = extractShipmentId(payload);
    if (!shipmentId) throw new Error("Could not find shipment_id in ShipStation webhook payload");

    const shipment = await shipstationRequest<ShipStationShipment>("GET", `/v2/shipments/${shipmentId}`);
    const eventId = createHash("sha256").update(rawBody).digest("hex");

    // Ignore shipments not created from Airtable — external_shipment_id is set
    // to the Airtable record ID on push; externally-created shipments have it
    // null/empty and must not create new Airtable records.
    if (!shipment.external_shipment_id) return { eventId, records: [] };

    return { eventId, records: [normalizeShipment(shipment)] };
  },
};
