import { describe, expect, it } from "vitest";
import { shipstationSpecs } from "../src/mappers/shipstation.js";
import type { ExternalRecord } from "../src/connectors/types.js";

const rec = (entity: string, raw: unknown): ExternalRecord => ({
  externalId: "x",
  entity,
  updatedAt: new Date().toISOString(),
  raw,
});

describe("shipstation shipment mapIn", () => {
  it("maps shipment id, ship date, and infers carrier from service code", () => {
    const fields = shipstationSpecs["shipment"]!.mapIn(
      rec("shipment", {
        shipment_id: "se-123",
        modified_at: new Date().toISOString(),
        ship_date: "2026-02-01",
        service_code: "usps_priority_mail",
      })
    );
    expect(fields["ShipStation Shipment ID"]).toBe("se-123");
    expect(fields["Ship Date"]).toBe("2026-02-01");
    expect(fields["Carrier"]).toBe("USPS");
  });

  it("falls back to Other for an unrecognized carrier prefix", () => {
    const fields = shipstationSpecs["shipment"]!.mapIn(
      rec("shipment", { shipment_id: "se-1", modified_at: new Date().toISOString(), service_code: "globalpost_x" })
    );
    expect(fields["Carrier"]).toBe("Other");
  });

  it("never sets Tracking Number — that's the label job's responsibility", () => {
    const fields = shipstationSpecs["shipment"]!.mapIn(
      rec("shipment", { shipment_id: "se-1", modified_at: new Date().toISOString() })
    );
    expect(fields["Tracking Number"]).toBeUndefined();
  });
});

describe("shipstation shipment mapOut", () => {
  const baseFields = {
    "Shipment Name": "#1001 — Vendor to Customer (1 item)",
    "Ship To Name (from Order)": ["Ada Lovelace"],
    "Ship To Phone (from Order)": ["+15550001111"],
    "Ship To Address Line 1 (from Order)": ["123 Main St"],
    "Ship To City (from Order)": ["Austin"],
    "Ship To State (from Order)": ["TX"],
    "Ship To Zip (from Order)": ["78701"],
    "Ship To Country (from Order)": ["US"],
    Weight: 4.5,
    "Weight Unit": "pound",
  };

  it("uses the linked vendor's address as ship_from when present", () => {
    const payload = shipstationSpecs["shipment"]!.mapOut!(
      {
        ...baseFields,
        "Name (from Vendor)": ["Allure"],
        "Address Line 1 (from Vendor)": ["456 Vendor Way"],
        "City (from Vendor)": ["Dallas"],
        "State (from Vendor)": ["TX"],
        "Zip (from Vendor)": ["75201"],
        "Country (from Vendor)": ["US"],
        "Phone (from Vendor)": ["+15559998888"],
      },
      "recABC123"
    );

    expect(payload["external_shipment_id"]).toBe("#1001 — Vendor to Customer (1 item)");
    expect(payload["warehouse_id"]).toBeUndefined();
    const shipFrom = payload["ship_from"] as Record<string, unknown>;
    expect(shipFrom["name"]).toBe("Allure");
    expect(shipFrom["address_line1"]).toBe("456 Vendor Way");
    const shipTo = payload["ship_to"] as Record<string, unknown>;
    expect(shipTo["name"]).toBe("Ada Lovelace");
    expect(shipTo["address_line1"]).toBe("123 Main St");
    expect((payload["packages"] as Record<string, unknown>[])[0]).toEqual({
      weight: { value: 4.5, unit: "pound" },
    });
  });

  it("falls back to the default warehouse_id when there's no vendor address", () => {
    const payload = shipstationSpecs["shipment"]!.mapOut!(baseFields, "recABC123");
    expect(payload["ship_from"]).toBeUndefined();
    expect(payload["warehouse_id"]).toBe("se-test-warehouse"); // from tests/setup.ts
  });

  it("defaults Weight Unit to pound when missing", () => {
    const { Weight, "Weight Unit": _unit, ...rest } = baseFields;
    const payload = shipstationSpecs["shipment"]!.mapOut!({ ...rest, Weight }, "recABC123");
    expect((payload["packages"] as Record<string, unknown>[])[0]).toEqual({
      weight: { value: 4.5, unit: "pound" },
    });
  });
});
