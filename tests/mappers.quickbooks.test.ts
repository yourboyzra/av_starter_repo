import { describe, expect, it } from "vitest";
import { quickbooksSpecs } from "../src/mappers/quickbooks.js";
import type { ExternalRecord } from "../src/connectors/types.js";

const rec = (entity: string, raw: unknown): ExternalRecord => ({
  externalId: "x",
  entity,
  updatedAt: new Date().toISOString(),
  raw,
});

describe("quickbooks vendor mapIn", () => {
  it("maps all QB Vendor fields to AT Warehouse Vendors fields", () => {
    const fields = quickbooksSpecs["vendor"]!.mapIn(
      rec("vendor", {
        Id: "56",
        SyncToken: "0",
        MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" },
        DisplayName: "Allure Lampshades",
        PrimaryPhone: { FreeFormNumber: "555-1234" },
        PrimaryEmailAddr: { Address: "allure@example.com" },
        BillAddr: {
          Line1: "123 Main St",
          City: "Los Angeles",
          CountrySubDivisionCode: "CA",
          PostalCode: "90001",
          Country: "US",
        },
      })
    );

    expect(fields["QB Vendor ID"]).toBe("56");
    expect(fields["Name"]).toBe("Allure Lampshades");
    expect(fields["Phone"]).toBe("555-1234");
    expect(fields["Email"]).toBe("allure@example.com");
    expect(fields["Address Line 1"]).toBe("123 Main St");
    expect(fields["City"]).toBe("Los Angeles");
    expect(fields["State"]).toBe("CA");
    expect(fields["Zip"]).toBe("90001");
    expect(fields["Country"]).toBe("US");
  });

  it("omits optional address/contact fields when missing in the QB payload", () => {
    const fields = quickbooksSpecs["vendor"]!.mapIn(
      rec("vendor", {
        Id: "57",
        SyncToken: "0",
        MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" },
        DisplayName: "Other Vendor",
      })
    );

    expect(fields["QB Vendor ID"]).toBe("57");
    expect(fields["Name"]).toBe("Other Vendor");
    expect(fields["Phone"]).toBeUndefined();
    expect(fields["Email"]).toBeUndefined();
    expect(fields["Address Line 1"]).toBeUndefined();
  });

  it("is inbound-only — no mapOut", () => {
    expect(quickbooksSpecs["vendor"]!.mapOut).toBeUndefined();
  });
});

describe("quickbooks purchase_order mapIn", () => {
  it("maps QB PO fields back to AT Shipments", () => {
    const fields = quickbooksSpecs["purchase_order"]!.mapIn(
      rec("purchase_order", {
        Id: "100",
        SyncToken: "0",
        MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" },
        DocNumber: "PO-0042",
        POStatus: "Open",
        TotalAmt: 850.0,
      })
    );

    expect(fields["QB PO ID"]).toBe("100");
    expect(fields["PO Number"]).toBe("PO-0042");
    expect(fields["QB PO Status"]).toBe("Open");
  });

  it("omits optional fields when missing", () => {
    const fields = quickbooksSpecs["purchase_order"]!.mapIn(
      rec("purchase_order", {
        Id: "101",
        SyncToken: "0",
        MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" },
      })
    );

    expect(fields["QB PO ID"]).toBe("101");
    expect(fields["PO Number"]).toBeUndefined();
    expect(fields["QB PO Status"]).toBeUndefined();
  });
});

describe("quickbooks purchase_order mapOut", () => {
  it("builds a valid QB PO payload from a Shipments record", () => {
    const payload = quickbooksSpecs["purchase_order"]!.mapOut!(
      {
        "Shipment Name": "#1001 — Vendor to Customer (2 items)",
        "PO Amount": 500,
        "PO Number": "PO-1001",
        "Order Number (from Order)": ["#1001"],
        "QB Vendor ID (from Vendor)": ["58"],
        "QB AP Account ID": "33",
      },
      "rec_test_123"
    );

    expect(payload["VendorRef"]).toEqual({ value: "58" });
    expect(payload["DocNumber"]).toBe("PO-1001");
    expect(payload["Memo"]).toContain("#1001");

    const lines = payload["Line"] as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!["Amount"]).toBe(500);
    expect(lines[0]!["DetailType"]).toBe("AccountBasedExpenseLineDetail");
    expect(
      (lines[0]!["AccountBasedExpenseLineDetail"] as { AccountRef: { value: string } }).AccountRef.value
    ).toBe("80"); // Cost of Goods Sold
  });

  it("omits DocNumber when PO Number is empty", () => {
    const payload = quickbooksSpecs["purchase_order"]!.mapOut!(
      {
        "Shipment Name": "#1002 — Vendor to Customer (1 item)",
        "PO Amount": 100,
        "Order Number (from Order)": ["#1002"],
        "QB Vendor ID (from Vendor)": ["58"],
        "QB AP Account ID": "33",
      },
      "rec_test_789"
    );
    expect(payload["DocNumber"]).toBeUndefined();
  });

  it("throws if no QB Vendor ID is linked", () => {
    expect(() =>
      quickbooksSpecs["purchase_order"]!.mapOut!(
        { "Shipment Name": "test", "PO Amount": 100, "QB AP Account ID": "33" },
        "rec_test_no_vendor"
      )
    ).toThrow(/QB Vendor ID/);
  });

  it("throws if QB AP Account ID is missing", () => {
    expect(() =>
      quickbooksSpecs["purchase_order"]!.mapOut!(
        { "Shipment Name": "test", "PO Amount": 100, "QB Vendor ID (from Vendor)": ["58"] },
        "rec_test_no_account"
      )
    ).toThrow(/QB AP Account ID/);
  });
});
