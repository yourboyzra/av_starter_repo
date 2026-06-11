import type { Fields } from "../lib/airtable.js";

/**
 * The per-provider contract. A new integration = one adapter implementing
 * this interface + one mapper spec + one registry entry. The sync engine
 * only ever talks to this interface.
 */

/** A normalized record from the third party, ready for mapping. */
export interface ExternalRecord {
  externalId: string; // their primary key (e.g. "cus_123", QBO "45")
  entity: string; // "customer" | "invoice" | "contact" | ...
  updatedAt: string; // ISO — their last-modified timestamp
  raw: unknown; // full original payload (kept for debugging/mapping)
}

/** A verified, parsed inbound webhook. eventId drives idempotency. */
export interface WebhookEvent {
  eventId: string;
  records: ExternalRecord[];
}

export interface Connector {
  name: string; // "stripe" | "quickbooks" | "ghl"

  /** Pull records changed since a watermark (Pattern B / reconciliation). */
  pullChanges(entity: string, since: string): Promise<ExternalRecord[]>;

  /** Push a create/update to the provider. Returns their ID (for linking). */
  push(entity: string, externalId: string | null, data: Record<string, unknown>): Promise<string>;

  /**
   * Verify + parse an inbound webhook. MUST verify the signature on the raw
   * body first and throw InvalidSignatureError on failure.
   */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<WebhookEvent>;
}

/** Thrown by adapters for capabilities the provider lacks; the engine degrades gracefully. */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported: ${what}`);
    this.name = "NotSupportedError";
  }
}

export class InvalidSignatureError extends Error {
  constructor() {
    super("Invalid webhook signature");
    this.name = "InvalidSignatureError";
  }
}

/**
 * Mapping spec for one entity of one provider. Mappers are pure functions:
 * payload in -> fields out. PRODUCTION RULE: switch field names to field IDs
 * before a client deploy (see CLAUDE.md).
 */
export interface EntitySpec {
  table: string; // Airtable table (name in dev, ID in prod)
  idField: string; // "{Provider} ID" — the merge key for upserts
  syncedAtField: string; // "{Provider} Synced At"
  statusField?: string; // "Sync Status": Synced / Pending / Error / Conflict
  errorField?: string; // "Sync Error" — failures visible in the base
  /** Inbound: normalized external record -> Airtable fields (must include idField). */
  mapIn(rec: ExternalRecord): Fields;
  /** Outbound: Airtable fields -> provider payload. Omit if entity is inbound-only. */
  mapOut?(fields: Fields, airtableRecordId: string): Record<string, unknown>;
}

export type ProviderSpecs = Record<string, EntitySpec>;

export interface ProviderRegistration {
  connector: Connector;
  specs: ProviderSpecs;
}
