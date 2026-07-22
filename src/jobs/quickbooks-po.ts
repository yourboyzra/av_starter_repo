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

  // Override Line array with one entry per line item
  if (lineItems.length > 0) {
    basePayload["Line"] = lineItems.map((li) => ({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: Number(li.fields["Line Total"] ?? 0),
      Description: buildLineDescription(li.fields as Record<string, unknown>),
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: "80" },
      },
    }));
  }

  const payload = basePayload;
  const currentId = record.fields[spec.idField];
  const externalId = typeof currentId === "string" && currentId ? currentId : null;
  const isNew = !externalId;

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

    // Attach the PO PDF to the linked Order record — non-fatal if it fails.
    // On create: append alongside any existing POs from other shipments.
    // On update: replace the previous version of this PO (matched by filename)
    //            while preserving PDFs from other shipments.
    if (r2Configured() && orderId && orderRecord) {
      try {
        const pdfRes = await fetchPoPdf(id);
        const buf = await pdfRes.arrayBuffer();
        const key = `po-pdfs/${shipmentRecordId}/${Date.now()}.pdf`;
        const url = await uploadToR2(key, buf, "application/pdf");
        const filename = `PO-${docNumber || id}.pdf`;
        const existing = Array.isArray(orderRecord.fields["PO(s)"])
          ? (orderRecord.fields["PO(s)"] as Array<{ id: string; filename?: string }>)
          : [];
        const kept = isNew
          ? existing.map((a) => ({ id: a.id }))
          : existing.filter((a) => a.filename !== filename).map((a) => ({ id: a.id }));
        await airtable.update("Orders", [{ id: orderId, fields: { "PO(s)": [...kept, { url, filename }] } }]);
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
