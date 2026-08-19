import { airtable } from "../lib/airtable.js";
import { quickbooksSpecs } from "../mappers/quickbooks.js";
import { createOrUpdatePurchaseOrder, fetchPoPdf } from "../connectors/quickbooks.js";
import { r2Configured, uploadToR2 } from "../lib/r2.js";

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
  const qty = fields["Quantity"] != null ? String(fields["Quantity"]) : "";
  const style = String(fields["Style"] ?? "");
  const fitting = String(fields["Fitting"] ?? "");
  const color = String(fields["Color"] ?? "");
  const type = String(fields["Type"] ?? "");
  const files = Array.isArray(fields["Custom Files"])
    ? (fields["Custom Files"] as Array<{ filename?: string }>).map((f) => f.filename).filter(Boolean)
    : [];

  const title = [name, variant].filter(Boolean).join(" — ");
  const details = [
    qty ? `Qty: ${qty}` : "",
    style,
    fitting,
    color,
    type,
  ].filter(Boolean).join(" | ");
  const filesNote = files.length ? `Files: ${files.join(", ")}` : "";

  return [title, details, filesNote].filter(Boolean).join("\n");
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

  // Override Memo to include customer name
  const customerName = orderRecord ? String(orderRecord.fields["Customer Name"] ?? "") : "";
  if (customerName) {
    basePayload["Memo"] = [customerName, basePayload["Memo"]].filter(Boolean).join(" — ");
  }

  // Single line using PO Amount from the Shipment record.
  // Descriptions from all linked line items are combined for detail,
  // but individual line totals are not sent to QB.
  const poAmount = Number(record.fields["PO Amount"] ?? 0);
  if (lineItems.length > 0) {
    const combinedDescription = lineItems
      .map((li) => buildLineDescription(li.fields as Record<string, unknown>))
      .filter(Boolean)
      .join("\n\n");
    basePayload["Line"] = [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: poAmount,
        Description: combinedDescription,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "7" },
        },
      },
    ];
  }

  const payload = basePayload;
  const currentId = record.fields[spec.idField];
  const externalId = typeof currentId === "string" && currentId ? currentId : null;

  try {
    const { id, docNumber } = await createOrUpdatePurchaseOrder(externalId, payload);

    await airtable.update("Shipments", [
      {
        id: shipmentRecordId,
        fields: {
          "QB PO ID": id,
          ...(docNumber ? { "PO Number": docNumber } : {}),
          "QB Synced At": new Date().toISOString(),
          "QB Sync Status": "Synced",
          "QB Sync Error": "",
        },
      },
    ]);

    // Attach the PO PDF to the Shipment record — non-fatal if it fails.
    // Each shipment maps to exactly one PO so we just replace the field.
    if (r2Configured()) {
      try {
        const pdfRes = await fetchPoPdf(id);
        const buf = await pdfRes.arrayBuffer();
        const key = `po-pdfs/${shipmentRecordId}/${Date.now()}.pdf`;
        const url = await uploadToR2(key, buf, "application/pdf");
        const filename = `PO-${docNumber || id}.pdf`;
        await airtable.update("Shipments", [{ id: shipmentRecordId, fields: { "QB PO PDF": [{ url, filename }] } }]);
      } catch (pdfErr) {
        console.error("[createPO] PDF attachment failed (non-fatal):", pdfErr);
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
