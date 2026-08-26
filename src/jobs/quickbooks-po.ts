import { airtable } from "../lib/airtable.js";
import { quickbooksSpecs } from "../mappers/quickbooks.js";
import { createOrUpdatePurchaseOrder, getNextPoDocNumber } from "../connectors/quickbooks.js";
import { r2Configured, uploadToR2 } from "../lib/r2.js";
import { firstLookup } from "../mappers/utils.js";
import { generatePoPdf } from "../lib/po-pdf.js";

/**
 * Create or update a QuickBooks PurchaseOrder from a Shipments record, writing
 * QB PO ID, PO Number (DocNumber), and QB Sync Status back to Airtable
 * immediately — no waiting for the next sync cycle.
 *
 * Replaces the generic /jobs/outbound call for purchase orders so that
 * DocNumber is captured from the create response and written back at once.
 *
 * Triggered by an Airtable automation button on the Shipments record:
 *   POST /jobs/quickbooks/create-po  { "recordId": "recXXXXXXXXXXXXXX" }
 */
function buildLineDescription(fields: Record<string, unknown>): string {
  const name = String(fields["Line Item"] ?? "");
  const variant = String(fields["Variant / Description"] ?? "");
  const style = String(fields["Style"] ?? "");
  const fitting = String(fields["Fitting"] ?? "");
  const color = String(fields["Color"] ?? "");
  const type = String(fields["Type"] ?? "");

  // Qty omitted — QB shows it in the Quantity column for ItemBasedExpenseLineDetail.
  // File names omitted — not meaningful on a printed PO.
  const title = [name, variant].filter(Boolean).join(" — ");
  const details = [style, fitting, color, type].filter(Boolean).join(" | ");

  return [title, details].filter(Boolean).join("\n");
}

export async function createPO(shipmentRecordId: string): Promise<{ id: string; docNumber?: string }> {
  const spec = quickbooksSpecs.purchase_order;
  if (!spec?.mapOut) throw new Error("quickbooksSpecs.purchase_order.mapOut is not defined");

  const record = await airtable.find("Shipments", shipmentRecordId);

  // Fetch Order and Line Items before building payload so we can include
  // customer name and per-item detail on the PO.
  const orderIds = Array.isArray(record.fields["Order"]) ? (record.fields["Order"] as string[]) : [];
  const orderId = orderIds[0];
  const lineItemIds = Array.isArray(record.fields["Line Items"]) ? (record.fields["Line Items"] as string[]) : [];

  const [orderRecord, lineItems] = await Promise.all([
    orderId ? airtable.find("Orders", orderId) : Promise.resolve(null),
    lineItemIds.length ? airtable.findByIds("Line Items", lineItemIds) : Promise.resolve([]),
  ]);

  const basePayload = spec.mapOut(record.fields, record.id) as Record<string, unknown>;

  const customerName = orderRecord
    ? String(orderRecord.fields["Customer Name"] ?? "")
    : String(record.fields["Ship To Name"] ?? "");

  const vendorName = firstLookup(record.fields["Name (from Vendor)"]) ?? "";

  // Override Memo to include customer name
  if (customerName) {
    basePayload["Memo"] = [customerName, basePayload["Memo"]].filter(Boolean).join(" — ");
  }

  // Prepend customer/ship-to name to ShipAddr so it appears on the printed PO.
  // QB ShipAddr has no separate name field — name goes in Line1, address shifts down.
  if (customerName && basePayload["ShipAddr"]) {
    const addr = basePayload["ShipAddr"] as Record<string, unknown>;
    basePayload["ShipAddr"] = {
      ...addr,
      Line1: customerName,
      Line2: addr["Line1"] ?? "",
      Line3: addr["Line2"] ?? "",
    };
  }

  // One QB line per Airtable line item using ItemBasedExpenseLineDetail so the
  // PO shows Product/Service, Description, Quantity, and Rate columns.
  // Falls back to a single placeholder line when no line items are linked
  // (manual shipments) so the client can fill in detail directly in QB.
  const poAmount = Number(record.fields["PO Amount"] ?? 0);
  if (lineItems.length > 0) {
    basePayload["Line"] = lineItems.map((li) => {
      const f = li.fields as Record<string, unknown>;
      const qty = Number(f["Quantity"] ?? 1);
      const unitPrice = Number(f["PO Price"] ?? 0);
      const amount = qty * unitPrice;
      return {
        DetailType: "ItemBasedExpenseLineDetail",
        Amount: amount,
        Description: buildLineDescription(f),
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: "1561", name: "Custom Shades" },
          Qty: qty,
          UnitPrice: unitPrice,
        },
      };
    });
  } else {
    basePayload["Line"] = [
      {
        DetailType: "ItemBasedExpenseLineDetail",
        Amount: poAmount,
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: "1561", name: "Custom Shades" },
          Qty: 1,
          UnitPrice: poAmount,
        },
      },
    ];
  }

  const payload = basePayload;
  const currentId = record.fields[spec.idField];
  const externalId = typeof currentId === "string" && currentId ? currentId : null;

  try {
    const nextDocNumber = externalId ? undefined : await getNextPoDocNumber();
    const { id, docNumber } = await createOrUpdatePurchaseOrder(externalId, payload, nextDocNumber);

    await airtable.update("Shipments", [
      {
        id: shipmentRecordId,
        fields: {
          "QB PO ID": id,
          "PO Number": docNumber || String(basePayload["DocNumber"] ?? "") || id,
          "QB Synced At": new Date().toISOString(),
          "QB Sync Status": "Synced",
          "QB Sync Error": "",
        },
      },
    ]);

    // Generate and attach our own PDF — QB's /pdf API endpoint ignores custom
    // form styles, so we render it ourselves with the correct column layout.
    if (r2Configured()) {
      try {
        const shipAddr = basePayload["ShipAddr"] as Record<string, unknown> | undefined;
        const poDocNumber = docNumber || String(basePayload["DocNumber"] ?? "") || id;
        const pdfBuf = await generatePoPdf({
          docNumber: poDocNumber,
          txnDate: String(basePayload["TxnDate"] ?? new Date().toISOString().slice(0, 10)),
          vendor: {
            name: vendorName || "Vendor",
            addr: {
              line1: firstLookup(record.fields["Address Line 1 (from Vendor)"]) ?? undefined,
              city: firstLookup(record.fields["City (from Vendor)"]) ?? undefined,
              state: firstLookup(record.fields["State (from Vendor)"]) ?? undefined,
              zip: firstLookup(record.fields["Zip (from Vendor)"]) ?? undefined,
            },
          },
          shipTo: shipAddr ? {
            line1: String(shipAddr["Line1"] ?? ""),
            line2: String(shipAddr["Line2"] ?? "") || undefined,
            line3: String(shipAddr["Line3"] ?? "") || undefined,
            city: String(shipAddr["City"] ?? ""),
            state: String(shipAddr["CountrySubDivisionCode"] ?? ""),
            zip: String(shipAddr["PostalCode"] ?? ""),
            country: String(shipAddr["Country"] ?? ""),
          } : undefined,
          customerName: customerName || undefined,
          lineItems: lineItems.length > 0
            ? lineItems.map((li) => {
                const f = li.fields as Record<string, unknown>;
                const qty = Number(f["Quantity"] ?? 1);
                const rate = Number(f["PO Price"] ?? 0);
                return {
                  productService: "Custom Shades",
                  description: buildLineDescription(f),
                  qty,
                  rate,
                  amount: qty * rate,
                };
              })
            : [{
                productService: "Custom Shades",
                description: "",
                qty: 1,
                rate: poAmount,
                amount: poAmount,
              }],
          totalAmt: lineItems.length > 0
            ? lineItems.reduce((sum, li) => {
                const f = li.fields as Record<string, unknown>;
                return sum + Number(f["Quantity"] ?? 1) * Number(f["PO Price"] ?? 0);
              }, 0)
            : poAmount,
        });
        const key = `po-pdfs/${shipmentRecordId}/${Date.now()}.pdf`;
        const ab = pdfBuf.buffer.slice(pdfBuf.byteOffset, pdfBuf.byteOffset + pdfBuf.byteLength) as ArrayBuffer;
        const url = await uploadToR2(key, ab, "application/pdf");
        const filename = `PO-${poDocNumber}.pdf`;
        await airtable.update("Shipments", [{ id: shipmentRecordId, fields: { "QB PO PDF": [{ url, filename }] } }]);
      } catch (pdfErr) {
        console.error("[createPO] PDF generation/upload failed (non-fatal):", pdfErr);
      }
    }

    return { id, docNumber };
  } catch (err) {
    await airtable.update("Shipments", [
      {
        id: shipmentRecordId,
        fields: {
          "QB Sync Status": "Error",
          "QB Sync Error": String(err),
        },
      },
    ]);
    throw err;
  }
}
