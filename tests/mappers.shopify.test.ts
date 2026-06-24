import { describe, expect, it } from "vitest";
import { shopifySpecs } from "../src/mappers/shopify.js";
import type { ExternalRecord } from "../src/connectors/types.js";

const rec = (entity: string, raw: unknown): ExternalRecord => ({
  externalId: "x",
  entity,
  updatedAt: new Date().toISOString(),
  raw,
});

describe("shopify order mapIn", () => {
  it("maps core order fields, ship-to address, and statuses", () => {
    const fields = shopifySpecs["order"]!.mapIn(
      rec("order", {
        id: 5734924009656,
        name: "#1001",
        created_at: "2026-01-01T00:00:00Z",
        email: "buyer@example.com",
        phone: "+15550001111",
        total_price: "199.99",
        currency: "USD",
        note: "Gift wrap please",
        financial_status: "partially_paid",
        fulfillment_status: "partial",
        customer: { first_name: "Ada", last_name: "Lovelace" },
        shipping_address: {
          name: "Ada Lovelace",
          phone: "+15550002222",
          address1: "123 Main St",
          address2: "Apt 4",
          city: "Austin",
          province_code: "TX",
          zip: "78701",
          country_code: "US",
        },
      })
    );

    expect(fields["Order Number"]).toBe("#1001");
    expect(fields["Shopify Order ID"]).toBe(5734924009656);
    expect(fields["Order Notes"]).toBe("Gift wrap please");
    expect(fields["Customer Name"]).toBe("Ada Lovelace");
    expect(fields["Customer Email"]).toBe("buyer@example.com");
    expect(fields["Order Value"]).toBe(199.99);
    expect(fields["Financial Status"]).toBe("Partially Paid");
    expect(fields["Fulfillment Status"]).toBe("Partial");
    expect(fields["Ship To Name"]).toBe("Ada Lovelace");
    expect(fields["Ship To Address Line 1"]).toBe("123 Main St");
    expect(fields["Ship To City"]).toBe("Austin");
    expect(fields["Ship To State"]).toBe("TX");
    expect(fields["Ship To Zip"]).toBe("78701");
    expect(fields["Ship To Country"]).toBe("US");
  });

  it("defaults fulfillment status to Unfulfilled when null", () => {
    const fields = shopifySpecs["order"]!.mapIn(
      rec("order", { id: 1, created_at: "2026-01-01T00:00:00Z", fulfillment_status: null })
    );
    expect(fields["Fulfillment Status"]).toBe("Unfulfilled");
  });

  it("falls back through customer -> shipping address for the customer name", () => {
    const fields = shopifySpecs["order"]!.mapIn(
      rec("order", {
        id: 2,
        created_at: "2026-01-01T00:00:00Z",
        shipping_address: { first_name: "Grace", last_name: "Hopper" },
      })
    );
    expect(fields["Customer Name"]).toBe("Grace Hopper");
  });

  it("is inbound-only — Shopify orders are never pushed back", () => {
    expect(shopifySpecs["order"]!.mapOut).toBeUndefined();
  });
});

describe("shopify line_item mapIn", () => {
  it("computes line total and formats custom properties", () => {
    const fields = shopifySpecs["line_item"]!.mapIn(
      rec("line_item", {
        id: 999,
        order_id: 5734924009656,
        title: "12in Drum Shade",
        variant_title: "Linen / White",
        quantity: 2,
        price: "49.99",
        properties: [
          { name: "Style", value: "Softback - Box Pleat" },
          { name: "Top Diameter", value: "12in" },
        ],
      })
    );

    expect(fields["Line Item"]).toBe("12in Drum Shade");
    expect(fields["Variant / Description"]).toBe("Linen / White");
    expect(fields["Quantity"]).toBe(2);
    expect(fields["Unit Price"]).toBe(49.99);
    expect(fields["Line Total"]).toBe(99.98);
    expect(fields["Custom Order Details"]).toBe("Style: Softback - Box Pleat\nTop Diameter: 12in");
    expect(fields["Shopify Line Item ID"]).toBe("999");
    expect(fields["Shopify Order ID"]).toBe("5734924009656");
  });

  it("is inbound-only and never resolves the Order linked-record field", () => {
    const fields = shopifySpecs["line_item"]!.mapIn(rec("line_item", { id: 1, order_id: 1, quantity: 1 }));
    expect(fields["Order"]).toBeUndefined();
    expect(shopifySpecs["line_item"]!.mapOut).toBeUndefined();
  });
});
