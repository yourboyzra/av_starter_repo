import { airtable } from "../lib/airtable.js";
import { shipstationSpecs } from "../mappers/shipstation.js";
import { getShipmentRates, createLabelFromRate } from "../connectors/shipstation.js";

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

  const { trackingNumber, shipmentId } = await createLabelFromRate(rateId);

  await airtable.update("Shipments", [
    {
      id: shipmentRecordId,
      fields: {
        "Tracking Number": trackingNumber,
        "ShipStation Shipment ID": shipmentId,
      },
    },
  ]);

  return { trackingNumber };
}
