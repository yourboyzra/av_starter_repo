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
export async function createPO(shipmentRecordId: string): Promise<{ id: string; docNumber?: string }> {
  const spec = quickbooksSpecs.purchase_order;
  if (!spec?.mapOut) throw new Error("quickbooksSpecs.purchase_order.mapOut is not defined");

  const record = await airtable.find("Shipments", shipmentRecordId);
  const payload = spec.mapOut(record.fields, record.id);

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
    if (r2Configured()) {
      try {
        const orderIds = Array.isArray(record.fields["Order"]) ? (record.fields["Order"] as string[]) : [];
        const orderId = orderIds[0];
        if (orderId) {
          const pdfRes = await fetchPoPdf(id);
          const buf = await pdfRes.arrayBuffer();
          const key = `po-pdfs/${shipmentRecordId}/${Date.now()}.pdf`;
          const url = await uploadToR2(key, buf, "application/pdf");
          const filename = `PO-${docNumber || id}.pdf`;
          const orderRecord = await airtable.find("Orders", orderId);
          const existing = Array.isArray(orderRecord.fields["PO(s)"])
            ? (orderRecord.fields["PO(s)"] as Array<{ id: string; filename?: string }>)
            : [];
          // Keep all other POs; on update, drop the old version of this one
          const kept = isNew
            ? existing.map((a) => ({ id: a.id }))
            : existing.filter((a) => a.filename !== filename).map((a) => ({ id: a.id }));
          await airtable.update("Orders", [{ id: orderId, fields: { "PO(s)": [...kept, { url, filename }] } }]);
        }
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
