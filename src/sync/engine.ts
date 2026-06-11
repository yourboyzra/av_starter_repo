import { airtable, type Fields } from "../lib/airtable.js";
import {
  NotSupportedError,
  type Connector,
  type EntitySpec,
  type ExternalRecord,
  type ProviderRegistration,
} from "../connectors/types.js";
import { loadWatermark, saveWatermark } from "./watermarks.js";

/**
 * Provider-agnostic sync engine. Three flows:
 *   5.1 inbound real-time   (webhook -> processInbound)
 *   5.2 inbound reconcile   (cron -> runReconciliation; always build this)
 *   5.3 outbound            (Airtable change -> pushOutbound)
 *
 * ECHO SUPPRESSION (critical for two-way sync — our push triggers their
 * webhook back at us, which would trigger our push again, forever):
 *   - Timestamp guard: on inbound, skip if the record's `{Provider} Synced At`
 *     is >= the event's updatedAt.
 *   - Content guard: before any write, diff mapped fields against current
 *     values; if nothing changes, don't write. No write -> no echo.
 */

/** Content guard: true if any mapped field differs from the stored value. */
function hasChanges(existing: Fields, mapped: Fields): boolean {
  return Object.entries(mapped).some(
    ([k, v]) => JSON.stringify(existing[k] ?? null) !== JSON.stringify(v ?? null)
  );
}

/** Flow 5.1 / shared inbound path: normalized external records -> Airtable. */
export async function processInbound(
  specs: Record<string, EntitySpec>,
  records: ExternalRecord[]
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;

  // Oldest first so the newest data lands last.
  const ordered = [...records].sort(
    (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
  );

  for (const rec of ordered) {
    const spec = specs[rec.entity];
    if (!spec) {
      skipped++;
      continue; // entity not mapped for this project — ignore
    }

    const existing = await airtable.findByField(spec.table, spec.idField, rec.externalId);

    // Timestamp guard (echo + stale-event suppression)
    if (existing) {
      const syncedAt = existing.fields[spec.syncedAtField];
      if (typeof syncedAt === "string" && syncedAt && new Date(syncedAt) >= new Date(rec.updatedAt)) {
        skipped++;
        continue;
      }
    }

    const mapped = spec.mapIn(rec);

    // Content guard
    if (existing && !hasChanges(existing.fields, mapped)) {
      skipped++;
      continue;
    }

    const fields: Fields = {
      ...mapped,
      [spec.syncedAtField]: new Date().toISOString(),
      ...(spec.statusField ? { [spec.statusField]: "Synced" } : {}),
      ...(spec.errorField ? { [spec.errorField]: "" } : {}),
    };
    await airtable.upsert(spec.table, [{ fields }], [spec.idField]);
    written++;
  }
  return { written, skipped };
}

/** Flow 5.2: reconciliation by watermark. Self-heals missed webhooks. */
export async function runReconciliation(
  provider: string,
  registration: ProviderRegistration
): Promise<Record<string, { pulled: number; written: number; skipped: number } | { skipped: string }>> {
  const results: Record<string, { pulled: number; written: number; skipped: number } | { skipped: string }> = {};

  for (const entity of Object.keys(registration.specs)) {
    const key = `${provider}:${entity}`;
    const startedAt = new Date().toISOString();
    const since = await loadWatermark(key, new Date(Date.now() - 24 * 3600_000).toISOString());

    let changes: ExternalRecord[];
    try {
      changes = await registration.connector.pullChanges(entity, since);
    } catch (err) {
      if (err instanceof NotSupportedError) {
        results[entity] = { skipped: "pullChanges not supported" };
        continue; // webhook-only provider — degrade gracefully
      }
      throw err;
    }

    const { written, skipped } = await processInbound(registration.specs, changes);
    // Save the watermark ONLY after full success of this entity's pass.
    await saveWatermark(key, startedAt);
    results[entity] = { pulled: changes.length, written, skipped };
  }
  return results;
}

/** Flow 5.3: Airtable record -> provider. Writes the linkage + status back. */
export async function pushOutbound(
  connector: Connector,
  spec: EntitySpec,
  entity: string,
  airtableRecordId: string
): Promise<{ externalId: string } | { skipped: string }> {
  if (!spec.mapOut) throw new NotSupportedError(`outbound mapping for ${entity}`);

  const record = await airtable.find(spec.table, airtableRecordId);
  const payload = spec.mapOut(record.fields, record.id);
  const currentExternalId = record.fields[spec.idField];
  const externalId = typeof currentExternalId === "string" && currentExternalId ? currentExternalId : null;

  try {
    const returnedId = await connector.push(entity, externalId, payload);
    // Always trust the returned ID (providers like GHL may merge on push).
    await airtable.update(spec.table, [
      {
        id: record.id,
        fields: {
          [spec.idField]: returnedId,
          [spec.syncedAtField]: new Date().toISOString(),
          ...(spec.statusField ? { [spec.statusField]: "Synced" } : {}),
          ...(spec.errorField ? { [spec.errorField]: "" } : {}),
        },
      },
    ]);
    return { externalId: returnedId };
  } catch (err) {
    // Failures must be visible in the base, not just in logs.
    await airtable.update(spec.table, [
      {
        id: record.id,
        fields: {
          ...(spec.statusField ? { [spec.statusField]: "Error" } : {}),
          ...(spec.errorField ? { [spec.errorField]: String(err) } : {}),
        },
      },
    ]);
    throw err;
  }
}
