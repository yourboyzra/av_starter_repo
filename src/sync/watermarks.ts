import { airtable } from "../lib/airtable.js";

/**
 * Reconciliation watermarks, persisted in a `Sync Config` table (Key, Value)
 * so a redeploy doesn't reprocess history. Save ONLY after a fully
 * successful sync pass.
 */
const CONFIG_TABLE = "Sync Config";

export async function loadWatermark(key: string, fallback: string): Promise<string> {
  const rec = await airtable.findByField(CONFIG_TABLE, "Key", `watermark:${key}`);
  const value = rec?.fields["Value"];
  return typeof value === "string" && value ? value : fallback;
}

export async function saveWatermark(key: string, value: string): Promise<void> {
  const fullKey = `watermark:${key}`;
  const existing = await airtable.findByField(CONFIG_TABLE, "Key", fullKey);
  if (existing) {
    await airtable.update(CONFIG_TABLE, [{ id: existing.id, fields: { Value: value } }]);
  } else {
    await airtable.create(CONFIG_TABLE, [{ fields: { Key: fullKey, Value: value } }]);
  }
}
