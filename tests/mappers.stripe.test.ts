import { describe, expect, it } from "vitest";
import { stripeSpecs } from "../src/mappers/stripe.js";
import type { ExternalRecord } from "../src/connectors/types.js";

/**
 * Mappers are pure functions — the per-provider code to test heavily.
 * When a colleague adds a provider, this file is the example to copy.
 */

const rec = (entity: string, raw: unknown): ExternalRecord => ({
  externalId: "x",
  entity,
  updatedAt: new Date().toISOString(),
  raw,
});

describe("stripe customer mapIn", () => {
  it("maps id, name, email, phone", () => {
    const fields = stripeSpecs["customer"]!.mapIn(
      rec("customer", { id: "cus_1", name: "Ada", email: "ada@example.com", phone: "+1555" })
    );
    expect(fields).toEqual({
      "Stripe ID": "cus_1",
      Name: "Ada",
      Email: "ada@example.com",
      Phone: "+1555",
    });
  });

  it("normalizes null/missing optionals to empty strings", () => {
    const fields = stripeSpecs["customer"]!.mapIn(rec("customer", { id: "cus_2", name: null }));
    expect(fields["Name"]).toBe("");
    expect(fields["Email"]).toBe("");
    expect(fields["Phone"]).toBe("");
  });
});

describe("stripe customer mapOut", () => {
  it("includes metadata.airtable_id for reverse linking", () => {
    const payload = stripeSpecs["customer"]!.mapOut!(
      { Name: "Ada", Email: "ada@example.com", Phone: "" },
      "recABC123"
    );
    expect(payload["metadata"]).toEqual({ airtable_id: "recABC123" });
    expect(payload["name"]).toBe("Ada");
  });
});

describe("stripe invoice mapIn", () => {
  it("converts amounts from cents to dollars", () => {
    const fields = stripeSpecs["invoice"]!.mapIn(
      rec("invoice", { id: "in_1", amount_due: 12345, amount_paid: 10000, status: "open" })
    );
    expect(fields["Amount Due"]).toBe(123.45);
    expect(fields["Amount Paid"]).toBe(100);
    expect(fields["Status"]).toBe("open");
  });

  it("is inbound-only — money state is Stripe's truth, never pushed back", () => {
    expect(stripeSpecs["invoice"]!.mapOut).toBeUndefined();
  });
});
