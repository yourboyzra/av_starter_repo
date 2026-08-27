import type { Fields } from "../lib/airtable.js";
import type { ExternalRecord, ProviderSpecs } from "../connectors/types.js";
import { firstLookup } from "./utils.js";

/**
 * QuickBooks mapping specs — pure functions, payload in -> fields out.
 *
 * PRODUCTION RULE (CLAUDE.md): replace field NAMES below with field IDs
 * before a client deploy. Names are used here only for readability.
 *
 * Entities:
 *   vendor        — QB Vendor <-> AT Warehouse Vendors (inbound-only; Airtable
 *                   is the operational source of truth for vendor info)
 *   purchase_order — AT Orders -> QB PurchaseOrder (outbound create/update);
 *                   QB PO metadata (Id, DocNumber, status) synced back inbound.
 *
 * Pre-requisite AT fields for purchase_order.mapOut:
 *   "QB Vendor ID (from Vendor)"  lookup on the linked Vendor record — resolves
 *                                 to the QB Vendor Id stored on Warehouse Vendors.
 *   "QB AP Account ID"            the Accounts Payable account ref value; look
 *                                 it up once via the QB query API and store in
 *                                 the Sync Config table, then surface it here
 *                                 via a lookup or formula field on Orders.
 *
 * To find your AP Account ID:
 *   GET /v3/company/{realmId}/query?query=SELECT * FROM Account WHERE AccountType='Accounts Payable'
 */


const PO_STATUS: Record<string, string> = {
  Open: "Open",
  Closed: "Closed",
};

export interface QBPurchaseOrder {
  Id: string;
  SyncToken: string;
  MetaData: { LastUpdatedTime: string };
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  POStatus?: string;
  Memo?: string;
  VendorRef?: { value: string; name?: string };
  Line?: unknown[];
}

export const quickbooksSpecs: ProviderSpecs = {
  purchase_order: {
    table: "Shipments",
    idField: "QB PO ID",
    syncedAtField: "QB Synced At",
    statusField: "QB Sync Status",
    errorField: "QB Sync Error",
    noCreate: true,

    // Inbound: QB PO -> AT Shipments — write back PO number and status.
    mapIn(rec: ExternalRecord): Fields {
      const po = rec.raw as QBPurchaseOrder;
      return {
        "QB PO ID": po.Id,
        ...(po.DocNumber ? { "PO Number": po.DocNumber } : {}),
        ...(po.POStatus ? { "QB PO Status": PO_STATUS[po.POStatus] ?? po.POStatus } : {}),
      };
    },

    /**
     * Outbound: AT Shipments -> QB PurchaseOrder creation/update payload.
     * One PO per vendor leg (Vendor to Customer or Vendor to Lux) — Shipments
     * are already grouped by vendor via createVendorShipments.
     *
     * Required lookup fields on Shipments:
     *   "QB Vendor ID (from Vendor)"      — lookup from linked Vendor record
     *   "QB AP Account ID (from Vendor)"  — lookup from linked Vendor record,
     *                                       OR a formula returning the constant
     *                                       (e.g. "33" for sandbox)
     *   "Order Number (from Order)"       — lookup from linked Order record
     *   "PO Amount"                       — rollup: SUM of Line Total from linked Line Items
     */
    mapOut(fields: Fields, airtableRecordId: string): Record<string, unknown> {
      const vendorId = firstLookup(fields["QB Vendor ID (from Vendor)"]);
      if (!vendorId) {
        throw new Error(`Shipment ${airtableRecordId} has no QB Vendor ID — add QB Vendor ID to the linked Vendor record`);
      }

      const apAccountId = String(fields["QB AP Account ID"] ?? "");
      if (!apAccountId) {
        throw new Error(`Shipment ${airtableRecordId} missing QB AP Account ID — add a formula field returning "33" or look it up from Vendor`);
      }

      const poAmount = Number(fields["PO Amount"] ?? 0);
      const orderNumber = firstLookup(fields["Order Number (from Order)"]);
      const shipmentName = String(fields["Shipment Name"] ?? airtableRecordId);

      const shipLine1 = firstLookup(fields["Ship To Address Line 1 (from Order)"]);
      const shipLine2 = firstLookup(fields["Ship To Address Line 2 (from Order)"]);
      const shipCity = firstLookup(fields["Ship To City (from Order)"]);
      const shipState = firstLookup(fields["Ship To State (from Order)"]);
      const shipZip = firstLookup(fields["Ship To Zip (from Order)"]);
      const shipCountry = firstLookup(fields["Ship To Country (from Order)"]);

      return {
        TxnDate: new Date().toISOString().slice(0, 10),
        VendorRef: { value: vendorId },
        APAccountRef: { value: apAccountId },
        Memo: [orderNumber, shipmentName].filter(Boolean).join(" — "),
        ...(shipLine1 ? {
          ShipAddr: {
            Line1: shipLine1,
            ...(shipLine2 ? { Line2: shipLine2 } : {}),
            City: shipCity,
            CountrySubDivisionCode: shipState,
            PostalCode: shipZip,
            Country: shipCountry,
          },
        } : {}),
        // Line array is overridden in createPO with per-line-item detail.
        // This fallback covers the generic pushOutbound path.
        Line: [
          {
            DetailType: "ItemBasedExpenseLineDetail",
            Amount: poAmount,
            Description: shipmentName,
            ItemBasedExpenseLineDetail: {
              ItemRef: { value: "1561", name: "Custom Shades" },
              Qty: 1,
              UnitPrice: poAmount,
            },
          },
        ],
      };
    },
  },
};
