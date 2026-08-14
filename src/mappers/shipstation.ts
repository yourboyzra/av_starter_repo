import type { Fields } from "../lib/airtable.js";
import { requireEnv } from "../config.js";
import type { ExternalRecord, ProviderSpecs } from "../connectors/types.js";
import type { ShipStationShipment } from "../connectors/shipstation.js";
import { firstLookup } from "./utils.js";

/**
 * ShipStation mapping specs — pure functions, payload in -> fields out.
 *
 * Targets the `Shipments` table (one record per physical ShipStation
 * shipment) — NOT Orders. An order can have multiple shipments: one per
 * vendor for the outbound vendor leg, plus a consolidated Lux-to-customer
 * leg. See src/jobs/shipments.ts for how Shipments records get grouped and
 * created; this file only maps one already-created Shipments record
 * to/from a ShipStation payload.
 *
 * Field-direction policy: ship-to comes from the linked Order's
 * Shopify-populated fields (Airtable is truth, outbound). Ship-from comes
 * from the linked Vendor's lookup fields, falling back to a default
 * warehouse_id (env var) if somehow empty. Weight is entered manually by
 * whoever is shipping (vendor or Lux staff) directly on the Shipments
 * record, not computed from line items.
 */

const CARRIER_PREFIXES: [prefix: string, label: string][] = [
  ["usps", "USPS"],
  ["fedex", "FedEx"],
  ["ups", "UPS"],
  ["dhl", "DHL"],
];

function carrierFromServiceCode(code?: string | null): string {
  if (!code) return "";
  const lower = code.toLowerCase();
  for (const [prefix, label] of CARRIER_PREFIXES) {
    if (lower.startsWith(prefix)) return label;
  }
  return "Other";
}


const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "united states": "US", "united states of america": "US", "canada": "CA",
  "united kingdom": "GB", "australia": "AU", "germany": "DE", "france": "FR",
  "mexico": "MX", "japan": "JP", "china": "CN", "italy": "IT", "spain": "ES",
};

/** Normalize country values to ISO 2-letter codes ("US").
 * Handles: bare codes ("US"), "Name - XX" single-select format, full names. */
function toCountryCode(value: string): string {
  if (value.length === 2) return value.toUpperCase();
  const match = value.match(/-\s*([A-Za-z]{2})$/);
  if (match?.[1]) return match[1].toUpperCase();
  return COUNTRY_NAME_TO_CODE[value.toLowerCase()] ?? value;
}

function vendorShipFrom(fields: Fields): Record<string, unknown> | null {
  const addressLine1 = firstLookup(fields["Address Line 1 (from Vendor)"]);
  if (!addressLine1) return null; // no vendor linked, or vendor has no address on file

  return {
    name: firstLookup(fields["Name (from Vendor)"]),
    phone: firstLookup(fields["Phone (from Vendor)"]),
    address_line1: addressLine1,
    address_line2: firstLookup(fields["Address Line 2 (from Vendor)"]),
    city_locality: firstLookup(fields["City (from Vendor)"]),
    state_province: firstLookup(fields["State (from Vendor)"]),
    postal_code: firstLookup(fields["Zip (from Vendor)"]),
    country_code: toCountryCode(firstLookup(fields["Country (from Vendor)"])),
    address_residential_indicator: "unknown",
  };
}

function shipTo(fields: Fields): Record<string, unknown> {
  // Prefer lookup values from a linked Order; fall back to directly editable
  // fields on the Shipment for vendor-entered shipments with no linked Order.
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = firstLookup(fields["Ship To Name (from Order)"]) || str(fields["Ship To Name"]);
  const phone = firstLookup(fields["Ship To Phone (from Order)"]) || str(fields["Ship To Phone"]);
  const line1 = firstLookup(fields["Ship To Address Line 1 (from Order)"]) || str(fields["Ship To Address Line 1"]);
  const line2 = firstLookup(fields["Ship To Address Line 2 (from Order)"]) || str(fields["Ship To Address Line 2"]);
  const city = firstLookup(fields["Ship To City (from Order)"]) || str(fields["Ship To City"]);
  const state = firstLookup(fields["Ship To State (from Order)"]) || str(fields["Ship To State"]);
  const zip = firstLookup(fields["Ship To Zip (from Order)"]) || str(fields["Ship To Zip"]);
  const country = firstLookup(fields["Ship To Country (from Order)"]) || str(fields["Ship To Country"]);
  return {
    name,
    phone,
    address_line1: line1,
    address_line2: line2,
    city_locality: city,
    state_province: state,
    postal_code: zip,
    country_code: toCountryCode(country),
    address_residential_indicator: "unknown",
  };
}

export const shipstationSpecs: ProviderSpecs = {
  shipment: {
    table: "Shipments",
    idField: "ShipStation Shipment ID",
    syncedAtField: "Synced At",
    statusField: "Sync Status",
    errorField: "Sync Error",

    // Inbound: shipment-level status/date only — tracking_number isn't here.
    mapIn(rec: ExternalRecord): Fields {
      const s = rec.raw as ShipStationShipment;
      return {
        "ShipStation Shipment ID": s.shipment_id,
        ...(s.ship_date ? { "Ship Date": s.ship_date } : {}),
        Carrier: carrierFromServiceCode(s.service_code ?? s.requested_shipment_service),
      };
    },

    // Outbound: AT owns operational shipping data (ship-to, ship-from, weight).
    mapOut(fields: Fields, airtableRecordId: string): Record<string, unknown> {
      const vendorAddr = vendorShipFrom(fields);
      const weightValue = Number(fields["Weight"] ?? 0);
      const weightUnit = typeof fields["Weight Unit"] === "string" ? (fields["Weight Unit"] as string) : "pound";

      const length = Number(fields["Length"] ?? 0);
      const width = Number(fields["Width"] ?? 0);
      const height = Number(fields["Height"] ?? 0);
      const sizeUnit = typeof fields["Size Unit"] === "string" ? (fields["Size Unit"] as string) : "inch";
      const hasDimensions = length > 0 && width > 0 && height > 0;

      return {
        external_shipment_id: String(fields["Shipment Name"] ?? airtableRecordId),
        ship_to: shipTo(fields),
        ...(vendorAddr ? { ship_from: vendorAddr } : { warehouse_id: requireEnv("SHIPSTATION_WAREHOUSE_ID") }),
        packages: [
          {
            weight: { value: weightValue, unit: weightUnit },
            ...(hasDimensions ? { dimensions: { length, width, height, unit: sizeUnit } } : {}),
          },
        ],
      };
    },
  },
};
