import { airtable, fEscape } from "./airtable.js";

/**
 * Process every event exactly once. Providers retry webhooks; networks
 * duplicate them. Dedupe by event ID against an `Events Log` table in the
 * base itself (low volume). High volume on Railway: swap for Redis/Postgres —
 * keep the same two functions.
 *
 * Table fields: Event ID (text), Provider (text), Processed At (date/time).
 */
const LOG_TABLE = "Events Log";

export async function alreadyProcessed(eventId: string): Promise<boolean> {
  const hits = await airtable.list(LOG_TABLE, {
    filterByFormula: `{Event ID} = '${fEscape(eventId)}'`,
    maxRecords: "1",
  });
  return hits.length > 0;
}

export async function markProcessed(eventId: string, provider: string): Promise<void> {
  await airtable.create(LOG_TABLE, [
    {
      fields: {
        "Event ID": eventId,
        Provider: provider,
        "Processed At": new Date().toISOString(),
      },
    },
  ]);
}
