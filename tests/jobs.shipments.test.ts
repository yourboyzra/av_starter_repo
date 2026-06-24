import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AirtableRecord } from "../src/lib/airtable.js";

/**
 * Shipment-grouping job tests. Airtable client and the ShipStation
 * connector are both mocked — these tests verify the grouping/idempotency
 * logic, not network behavior (that's covered by connectors.shipstation
 * and mappers.shipstation tests).
 */

vi.mock("../src/lib/airtable.js", () => ({
  fEscape: (s: string) => s.replace(/'/g, "\\'"),
  airtable: {
    find: vi.fn(),
    findByField: vi.fn(),
    findByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(async () => undefined),
  },
}));

vi.mock("../src/connectors/shipstation.js", () => ({
  shipstationConnector: {
    name: "shipstation",
    push: vi.fn(async () => "se-pushed"),
    pullChanges: vi.fn(),
    parseWebhook: vi.fn(),
  },
  WEBHOOK_SECRET_HEADER: "x-webhook-secret",
}));

const { airtable } = await import("../src/lib/airtable.js");
const { shipstationConnector } = await import("../src/connectors/shipstation.js");
const { createVendorShipments, createLuxToCustomerShipment } = await import("../src/jobs/shipments.js");

const mocked = vi.mocked(airtable);
const mockedConnector = vi.mocked(shipstationConnector);

const record = (id: string, fields: Record<string, unknown>): AirtableRecord => ({
  id,
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});

let createCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  createCounter = 0;
  // create() returns one fresh fake record per call, in order.
  mocked.create.mockImplementation(async (_table, records) =>
    records.map(() => record(`recNEW${++createCounter}`, {}))
  );
  // pushOutbound (the real, unmocked engine function) re-fetches the just-created
  // Shipments record by ID — give it just enough fields to map without crashing.
  mocked.find.mockImplementation(async (table: string, id: string) => {
    if (table === "Shipments") {
      return record(id, { "Shipment Name": "test", Weight: 1, "Weight Unit": "pound" });
    }
    throw new Error(`unexpected find(${table})`);
  });
});

const orderRecord = (overrides: Partial<{ shipTo: string; lineItemIds: string[]; shipmentIds: string[] }> = {}) =>
  record("recORDER1", {
    "Order Number": "#1001",
    "Ship To": overrides.shipTo ?? "Customer",
    "Line Items": overrides.lineItemIds ?? ["recLI1", "recLI2"],
    Shipments: overrides.shipmentIds ?? [],
  });

describe("createVendorShipments", () => {
  it("groups Shipping From Vendor line items by Production Vendor, one Shipments record per vendor", async () => {
    mocked.find.mockImplementationOnce(async () => orderRecord());
    mocked.find.mockImplementation(async (table: string, id: string) => {
      if (table === "Orders") return orderRecord();
      return record(id, { "Shipment Name": "test", Weight: 1, "Weight Unit": "pound" });
    });
    mocked.findByIds.mockImplementation(async (table: string) => {
      if (table === "Line Items") {
        return [
          record("recLI1", { "Shipping Source": "Shipping From Vendor", "Production Vendor": ["recVendorA"] }),
          record("recLI2", { "Shipping Source": "Shipping From Vendor", "Production Vendor": ["recVendorB"] }),
        ];
      }
      return []; // no existing Shipments for this order yet
    });

    const result = await createVendorShipments("recORDER1");

    expect(result.created).toHaveLength(2);
    expect(mocked.create).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mocked.create.mock.calls;
    expect(firstCall![1][0]!.fields["Leg"]).toBe("Vendor to Customer"); // Ship To = Customer
    expect(firstCall![1][0]!.fields["Vendor"]).toEqual(["recVendorA"]);
    expect(firstCall![1][0]!.fields["Notify Customer"]).toBe(false); // opt-in only, never defaults on
    expect(secondCall![1][0]!.fields["Vendor"]).toEqual(["recVendorB"]);
    expect(mockedConnector.push).toHaveBeenCalledTimes(2);
  });

  it("uses Vendor to Lux leg when the order's Ship To is Lux Lampshade", async () => {
    mocked.find.mockImplementation(async (table: string, id: string) => {
      if (table === "Orders") return orderRecord({ shipTo: "Lux Lampshade", lineItemIds: ["recLI1"] });
      return record(id, { "Shipment Name": "test", Weight: 1, "Weight Unit": "pound" });
    });
    mocked.findByIds.mockImplementation(async (table: string) =>
      table === "Line Items"
        ? [record("recLI1", { "Shipping Source": "Shipping From Vendor", "Production Vendor": ["recVendorA"] })]
        : []
    );

    const result = await createVendorShipments("recORDER1");

    expect(result.created).toHaveLength(1);
    expect(mocked.create.mock.calls[0]![1][0]!.fields["Leg"]).toBe("Vendor to Lux");
    expect(mocked.create.mock.calls[0]![1][0]!.fields["Notify Customer"]).toBe(false);
  });

  it("skips line items already covered by an existing vendor-leg shipment (idempotency)", async () => {
    mocked.find.mockImplementation(async (table: string, id: string) => {
      if (table === "Orders") return orderRecord({ lineItemIds: ["recLI1", "recLI2"], shipmentIds: ["recSHIP_EXISTING"] });
      return record(id, {});
    });
    mocked.findByIds.mockImplementation(async (table: string) => {
      if (table === "Line Items") {
        return [
          record("recLI1", { "Shipping Source": "Shipping From Vendor", "Production Vendor": ["recVendorA"] }),
          record("recLI2", { "Shipping Source": "Shipping From Vendor", "Production Vendor": ["recVendorA"] }),
        ];
      }
      // recLI1 already grouped into an existing Vendor to Customer shipment
      return [record("recSHIP_EXISTING", { Leg: "Vendor to Customer", "Line Items": ["recLI1"] })];
    });

    const result = await createVendorShipments("recORDER1");

    expect(result.created).toHaveLength(1);
    expect(mocked.create.mock.calls[0]![1][0]!.fields["Line Items"]).toEqual(["recLI2"]);
  });

  it("returns no created shipments when there are no eligible line items", async () => {
    mocked.find.mockImplementation(async (table: string) =>
      table === "Orders" ? orderRecord({ lineItemIds: ["recLI1"] }) : record("x", {})
    );
    mocked.findByIds.mockImplementation(async (table: string) =>
      table === "Line Items" ? [record("recLI1", { "Shipping Source": "Shipping From Me" })] : []
    );

    const result = await createVendorShipments("recORDER1");

    expect(result.created).toEqual([]);
    expect(mocked.create).not.toHaveBeenCalled();
  });
});

describe("createLuxToCustomerShipment", () => {
  it("bundles Shipping From Me items unconditionally", async () => {
    mocked.find.mockImplementation(async (table: string, id: string) => {
      if (table === "Orders") return orderRecord({ lineItemIds: ["recLI1"] });
      return record(id, { "Shipment Name": "test", Weight: 1, "Weight Unit": "pound" });
    });
    mocked.findByIds.mockImplementation(async (table: string) =>
      table === "Line Items" ? [record("recLI1", { "Shipping Source": "Shipping From Me" })] : []
    );
    mocked.findByField.mockResolvedValue(record("recLuxVendor", { Name: "Lux Lampshades" }));

    const result = await createLuxToCustomerShipment("recORDER1");

    expect(result.created).toEqual({ shipmentRecordId: "recNEW1", lineItemCount: 1 });
    expect(mocked.create.mock.calls[0]![1][0]!.fields["Vendor"]).toEqual(["recLuxVendor"]);
    expect(mocked.create.mock.calls[0]![1][0]!.fields["Notify Customer"]).toBe(false); // opt-in only, never defaults on
    expect(mocked.create.mock.calls[0]![1][0]!.fields["Leg"]).toBe("Lux to Customer");
  });

  it("includes Shipping From Vendor items only once their Vendor to Lux shipment is marked Received at Lux", async () => {
    mocked.find.mockImplementation(async (table: string, id: string) => {
      if (table === "Orders") return orderRecord({ lineItemIds: ["recLI1", "recLI2"], shipmentIds: ["recSHIP_V2L"] });
      return record(id, { "Shipment Name": "test", Weight: 1, "Weight Unit": "pound" });
    });
    mocked.findByIds.mockImplementation(async (table: string) => {
      if (table === "Line Items") {
        return [
          record("recLI1", { "Shipping Source": "Shipping From Vendor" }), // received
          record("recLI2", { "Shipping Source": "Shipping From Vendor" }), // NOT received
        ];
      }
      return [
        record("recSHIP_V2L", { Leg: "Vendor to Lux", "Received at Lux": true, "Line Items": ["recLI1"] }),
      ];
    });
    mocked.findByField.mockResolvedValue(record("recLuxVendor", { Name: "Lux Lampshades" }));

    const result = await createLuxToCustomerShipment("recORDER1");

    expect(result.created).toEqual({ shipmentRecordId: "recNEW1", lineItemCount: 1 });
    expect(mocked.create.mock.calls[0]![1][0]!.fields["Line Items"]).toEqual(["recLI1"]);
  });

  it("throws if the Lux Lampshades vendor record can't be found", async () => {
    mocked.find.mockImplementation(async (table: string) =>
      table === "Orders" ? orderRecord({ lineItemIds: ["recLI1"] }) : record("x", {})
    );
    mocked.findByIds.mockImplementation(async (table: string) =>
      table === "Line Items" ? [record("recLI1", { "Shipping Source": "Shipping From Me" })] : []
    );
    mocked.findByField.mockResolvedValue(null);

    await expect(createLuxToCustomerShipment("recORDER1")).rejects.toThrow(/Lux Lampshades/);
  });

  it("returns null when nothing is ready to ship", async () => {
    mocked.find.mockImplementation(async (table: string) =>
      table === "Orders" ? orderRecord({ lineItemIds: ["recLI1"] }) : record("x", {})
    );
    mocked.findByIds.mockImplementation(async (table: string) =>
      table === "Line Items" ? [record("recLI1", { "Shipping Source": "Shipping From Vendor" })] : []
    );

    const result = await createLuxToCustomerShipment("recORDER1");

    expect(result.created).toBeNull();
    expect(mocked.create).not.toHaveBeenCalled();
  });
});
