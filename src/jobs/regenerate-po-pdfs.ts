import { airtable } from "../lib/airtable.js";
import { r2Configured, uploadToR2 } from "../lib/r2.js";
import { generatePoPdf } from "../lib/po-pdf.js";
import { firstLookup } from "../mappers/utils.js";

function buildLineDescription(fields: Record<string, unknown>): string {
  const name    = String(fields["Line Item"]            ?? "");
  const variant = String(fields["Variant / Description"] ?? "");
  const style   = String(fields["Style"]               ?? "");
  const fitting = String(fields["Fitting"]             ?? "");
  const color   = String(fields["Color"]               ?? "");
  const type    = String(fields["Type"]                ?? "");
  const title   = [name, variant].filter(Boolean).join(" — ");
  const details = [style, fitting, color, type].filter(Boolean).join(" | ");
  return [title, details].filter(Boolean).join("\n");
}

async function regenerateOnePoPdf(shipmentId: string): Promise<"ok" | "skipped"> {
  const record   = await airtable.find("Shipments", shipmentId);
  const poNumber = String(record.fields["PO Number"] ?? "").trim();
  if (!poNumber) return "skipped";

  const orderIds    = Array.isArray(record.fields["Order"])      ? (record.fields["Order"]      as string[]) : [];
  const lineItemIds = Array.isArray(record.fields["Line Items"]) ? (record.fields["Line Items"] as string[]) : [];

  const [orderRecord, lineItems] = await Promise.all([
    orderIds[0] ? airtable.find("Orders", orderIds[0]) : Promise.resolve(null),
    lineItemIds.length ? airtable.findByIds("Line Items", lineItemIds) : Promise.resolve([]),
  ]);

  const customerName = orderRecord
    ? String(orderRecord.fields["Customer Name"] ?? "")
    : String(record.fields["Ship To Name"]       ?? "");

  const vendorName = firstLookup(record.fields["Name (from Vendor)"]) ?? "";

  // Use QB Synced At as the PO date; fall back to today
  const txnDate = String(record.fields["QB Synced At"] ?? new Date().toISOString()).slice(0, 10);

  // Ship-to address from Order lookup fields already on the Shipment
  const rawLine1  = firstLookup(record.fields["Ship To Address Line 1 (from Order)"]);
  const rawLine2  = firstLookup(record.fields["Ship To Address Line 2 (from Order)"]);
  const shipCity  = firstLookup(record.fields["Ship To City (from Order)"]);
  const shipState = firstLookup(record.fields["Ship To State (from Order)"]);
  const shipZip   = firstLookup(record.fields["Ship To Zip (from Order)"]);
  const shipCountry = firstLookup(record.fields["Ship To Country (from Order)"]);

  // Replicate createPO's customer-name-prepend: name goes in Line1, address shifts down
  const shipTo = rawLine1 ? {
    line1:   customerName || rawLine1,
    line2:   customerName ? rawLine1 : (rawLine2 ?? undefined),
    line3:   customerName && rawLine2 ? rawLine2 : undefined,
    city:    shipCity    ?? undefined,
    state:   shipState   ?? undefined,
    zip:     shipZip     ?? undefined,
    country: shipCountry ?? undefined,
  } : undefined;

  const poAmount = Number(record.fields["PO Amount"] ?? 0);

  const pdfLineItems = lineItems.length > 0
    ? lineItems.map((li) => {
        const f    = li.fields as Record<string, unknown>;
        const qty  = Number(f["Quantity"] ?? 1);
        const rate = Number(f["PO Price"] ?? 0);
        return { productService: "Custom Shades", description: buildLineDescription(f), qty, rate, amount: qty * rate };
      })
    : [{ productService: "Custom Shades", description: "", qty: 1, rate: poAmount, amount: poAmount }];

  const totalAmt = lineItems.length > 0
    ? lineItems.reduce((sum, li) => {
        const f = li.fields as Record<string, unknown>;
        return sum + Number(f["Quantity"] ?? 1) * Number(f["PO Price"] ?? 0);
      }, 0)
    : poAmount;

  const pdfBuf = await generatePoPdf({
    docNumber: poNumber,
    txnDate,
    vendor: {
      name: vendorName || "Vendor",
      addr: {
        line1: firstLookup(record.fields["Address Line 1 (from Vendor)"]) ?? undefined,
        city:  firstLookup(record.fields["City (from Vendor)"])            ?? undefined,
        state: firstLookup(record.fields["State (from Vendor)"])           ?? undefined,
        zip:   firstLookup(record.fields["Zip (from Vendor)"])             ?? undefined,
      },
    },
    shipTo,
    customerName: customerName || undefined,
    lineItems: pdfLineItems,
    totalAmt,
  });

  const key      = `po-pdfs/${shipmentId}/${Date.now()}.pdf`;
  const ab       = pdfBuf.buffer.slice(pdfBuf.byteOffset, pdfBuf.byteOffset + pdfBuf.byteLength) as ArrayBuffer;
  const url      = await uploadToR2(key, ab, "application/pdf");
  const filename = `PO-${poNumber}.pdf`;
  await airtable.update("Shipments", [{ id: shipmentId, fields: { "QB PO PDF": [{ url, filename }] } }]);
  return "ok";
}

export interface RegeneratePoPdfsResult {
  processed: number;
  skipped:   number;
  errors:    { id: string; error: string }[];
}

export async function regeneratePoPdfs(): Promise<RegeneratePoPdfsResult> {
  if (!r2Configured()) throw new Error("R2 is not configured — cannot upload PDFs");

  const records = await airtable.list("Shipments", {
    filterByFormula: "AND({PO Number} != '', {QB PO ID} != '')",
  });

  const result: RegeneratePoPdfsResult = { processed: 0, skipped: 0, errors: [] };

  for (const record of records) {
    try {
      const status = await regenerateOnePoPdf(record.id);
      if (status === "ok") result.processed++;
      else result.skipped++;
    } catch (err) {
      result.errors.push({ id: record.id, error: String(err) });
    }
  }

  return result;
}
