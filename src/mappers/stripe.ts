import type { Fields } from "../lib/airtable.js";
import type { ExternalRecord, ProviderSpecs } from "../connectors/types.js";

/**
 * Stripe mapping specs — pure functions, payload in -> fields out. This file
 * (plus the adapter) is the only per-provider code; it's also the file to
 * unit test heavily.
 *
 * PRODUCTION RULE (CLAUDE.md): replace field NAMES below with field IDs
 * before a client deploy. Names are used here only for template readability.
 *
 * Field-direction policy (decide per FIELD with the client, §6 of the
 * connector blueprint): money/payment state — Stripe is truth (inbound only);
 * operational fields — Airtable is truth (outbound).
 */

type StripeCustomer = {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  [k: string]: unknown;
};

type StripeInvoice = {
  id: string;
  customer?: string | null;
  status?: string | null;
  amount_due?: number;
  amount_paid?: number;
  customer_email?: string | null;
  [k: string]: unknown;
};

export const stripeSpecs: ProviderSpecs = {
  customer: {
    table: "Customers",
    idField: "Stripe ID",
    syncedAtField: "Stripe Synced At",
    statusField: "Sync Status",
    errorField: "Sync Error",

    mapIn(rec: ExternalRecord): Fields {
      const c = rec.raw as StripeCustomer;
      return {
        "Stripe ID": c.id,
        Name: c.name ?? "",
        Email: c.email ?? "",
        Phone: c.phone ?? "",
      };
    },

    // AT -> Stripe (AT owns operational customer data).
    mapOut(fields: Fields, airtableRecordId: string) {
      return {
        name: fields["Name"] ?? "",
        email: fields["Email"] ?? "",
        phone: fields["Phone"] ?? "",
        // Reverse linking: recovery path if the AT linking field is deleted.
        metadata: { airtable_id: airtableRecordId },
      };
    },
  },

  invoice: {
    table: "Invoices",
    idField: "Stripe ID",
    syncedAtField: "Stripe Synced At",
    statusField: "Sync Status",
    errorField: "Sync Error",

    // Inbound only — money state: Stripe is always truth, never push back.
    mapIn(rec: ExternalRecord): Fields {
      const inv = rec.raw as StripeInvoice;
      return {
        "Stripe ID": inv.id,
        "Stripe Customer ID": inv.customer ?? "",
        Status: inv.status ?? "",
        "Amount Due": (inv.amount_due ?? 0) / 100, // Stripe amounts are in cents
        "Amount Paid": (inv.amount_paid ?? 0) / 100,
        "Customer Email": inv.customer_email ?? "",
      };
    },
  },
};
