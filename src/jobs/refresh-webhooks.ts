import { env } from "../config.js";
import { airtable } from "../lib/airtable.js";

/**
 * Airtable webhooks expire after 7 days — an expired webhook is the #1 cause
 * of "the integration silently stopped." This job refreshes every webhook ID
 * listed in AIRTABLE_WEBHOOK_IDS (comma-separated). Scheduled daily: Vercel
 * Cron (vercel.json) or node-cron on Railway (src/index.ts).
 */
export async function refreshWebhooks(): Promise<Record<string, string>> {
  const ids = env.AIRTABLE_WEBHOOK_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const results: Record<string, string> = {};
  for (const id of ids) {
    try {
      const { expirationTime } = await airtable.refreshWebhook(id);
      results[id] = `refreshed until ${expirationTime}`;
    } catch (err) {
      console.error(`[refresh-webhooks] ${id} failed:`, err);
      results[id] = `error: ${String(err)}`;
    }
  }
  return results;
}
