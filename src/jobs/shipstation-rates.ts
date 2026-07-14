import { airtable } from "../lib/airtable.js";
import { shipstationSpecs } from "../mappers/shipstation.js";
import { getShipmentRates, createLabelFromRate } from "../connectors/shipstation.js";
import { r2Configured, uploadToR2 } from "../lib/r2.js";
import { requireEnv } from "../config.js";

/**
 * Fetch available shipping rates from ShipStation for a Shipments record and
 * create one Rate record per option. Deletes stale Rate records for this
 * Shipment first so staff always sees a fresh list.
 *
 * Triggered by an Airtable automation button on the Shipments record:
 *   POST /jobs/shipstation/rates  { "shipmentRecordId": "recXXXXXXXXXXXXXX" }
 */
export async function fetchAndWriteRates(shipmentRecordId: string): Promise<{ count: number }> {
  const record = await airtable.find("Shipments", shipmentRecordId);
  const spec = shipstationSpecs.shipment;
  if (!spec?.mapOut) throw new Error("shipstationSpecs.shipment.mapOut is not defined");
  const shipmentSpec = spec.mapOut(record.fields, shipmentRecordId) as Record<string, unknown>;

  const rates = await getShipmentRates(shipmentSpec);

  // Clear stale rates for this shipment before writing fresh ones
  const stale = await airtable.list("Rates", {
    filterByFormula: `{Shipment Record ID} = '${shipmentRecordId}'`,
  });
  if (stale.length) await airtable.destroy("Rates", stale.map((r) => r.id));

  if (!rates.length) return { count: 0 };

  const toCreate = rates
    .filter((r) => !r.error_messages?.length)
    .map((r) => ({
      fields: {
        Rate: `${r.carrier_friendly_name} — ${r.service_type}`,
        Shipment: [shipmentRecordId],
        "Shipment Record ID": shipmentRecordId,
        Carrier: r.carrier_friendly_name,
        "Service Name": r.service_type,
        "Service Code": r.service_code,
        Price: r.shipping_amount.amount,
        "Est. Delivery Days": r.carrier_delivery_days ? Number(r.carrier_delivery_days) : null,
        "Rate ID": r.rate_id,
      },
    }));

  if (!toCreate.length) return { count: 0 };

  await airtable.create("Rates", toCreate);
  return { count: toCreate.length };
}

/**
 * Purchase a shipping label using a Rate record the staff selected.
 * Reads the ShipStation rate_id from the Rate record, buys the label via
 * /v2/labels/rates/{rate_id}, and writes the tracking number back to the
 * linked Shipment.
 *
 * Triggered by an Airtable automation button on the Rate record:
 *   POST /jobs/shipstation/create-label  { "rateRecordId": "recXXXXXXXXXXXXXX" }
 */
export async function purchaseLabel(rateRecordId: string): Promise<{ trackingNumber: string }> {
  const rateRecord = await airtable.find("Rates", rateRecordId);
  const rateId = rateRecord.fields["Rate ID"] as string | undefined;
  if (!rateId) throw new Error("Rate record has no Rate ID — re-fetch rates and try again");

  const linkedShipments = rateRecord.fields["Shipment"] as string[] | undefined;
  const shipmentRecordId = linkedShipments?.[0];
  if (!shipmentRecordId) throw new Error("Rate record has no linked Shipment");

  const { trackingNumber, shipmentId, labelId, labelPdfUrl } = await createLabelFromRate(rateId);

  // Download label PDF and upload to R2 so it can be attached in Airtable
  let labelAttachment: { url: string; filename: string } | undefined;
  if (r2Configured() && labelPdfUrl) {
    try {
      const pdfRes = await fetch(labelPdfUrl, {
        headers: { "api-key": requireEnv("SHIPSTATION_API_KEY") },
      });
      if (pdfRes.ok) {
        const buf = await pdfRes.arrayBuffer();
        const r2Key = `labels/${shipmentRecordId}/${labelId}.pdf`;
        const url = await uploadToR2(r2Key, buf, "application/pdf");
        labelAttachment = { url, filename: `label-${shipmentId}.pdf` };
      }
    } catch (err) {
      console.error("[purchaseLabel] Label PDF upload failed (non-fatal):", err);
    }
  }

  await airtable.update("Shipments", [
    {
      id: shipmentRecordId,
      fields: {
        "Tracking Number": trackingNumber,
        "ShipStation Shipment ID": shipmentId,
        ...(labelAttachment ? { Label: [labelAttachment] } : {}),
      },
    },
  ]);

  // Delete all other (unpurchased) Rate records for this Shipment
  const allRates = await airtable.list("Rates", {
    filterByFormula: `{Shipment Record ID} = '${shipmentRecordId}'`,
  });
  const toDelete = allRates.filter((r) => r.id !== rateRecordId);
  if (toDelete.length) await airtable.destroy("Rates", toDelete.map((r) => r.id));

  return { trackingNumber };
}
