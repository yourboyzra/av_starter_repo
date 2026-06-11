import { env } from "../config.js";

/**
 * THE Airtable client. House rule: every Airtable read/write in this codebase
 * goes through this module. It enforces:
 *   - 5 rps/base rate limit (serialized queue at ~4.5 rps)
 *   - retries with backoff on 429 (31 s penalty box) and 5xx
 *   - 10-record batching on create/update/delete
 *   - upsert via performUpsert.fieldsToMergeOn (the integration workhorse)
 *
 * Production rule: use FIELD IDS, not names (returnFieldsByFieldId + IDs in
 * writes). Clients rename fields; field IDs never change.
 */

const BASE_URL = "https://api.airtable.com/v0";
const MIN_INTERVAL_MS = 220; // ~4.5 rps, safely under the 5 rps cap

let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** Serialize all Airtable calls through one throttled queue. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCall + MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {}); // keep the chain alive on errors
  return run;
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  attempt = 0
): Promise<T> {
  const res = await throttled(() =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  );

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`Airtable ${res.status} after 5 attempts: ${url}`);
    const backoff = res.status === 429 ? 31_000 : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, backoff));
    return request(method, url, body, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const recordsUrl = (path: string) => `${BASE_URL}/${env.AIRTABLE_BASE_ID}/${path}`;

export type Fields = Record<string, unknown>;
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Fields;
}

const chunk = <T>(arr: T[], size = 10): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );

/** Escape user input for filterByFormula (single quotes). */
export const fEscape = (s: string) => s.replace(/'/g, "\\'");

export const airtable = {
  /** List all records, following pagination. Prefer field IDs in production. */
  async list(table: string, params: Record<string, string> = {}): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    let offset: string | undefined;
    do {
      const qs = new URLSearchParams({ ...params, ...(offset ? { offset } : {}) });
      const page = await request<{ records: AirtableRecord[]; offset?: string }>(
        "GET",
        recordsUrl(`${encodeURIComponent(table)}?${qs}`)
      );
      out.push(...page.records);
      offset = page.offset;
    } while (offset);
    return out;
  },

  /** Fetch a single record by Airtable record ID. */
  async find(table: string, recordId: string): Promise<AirtableRecord> {
    return request<AirtableRecord>("GET", recordsUrl(`${encodeURIComponent(table)}/${recordId}`));
  },

  /** Find at most one record where `field` equals `value` (escaped). */
  async findByField(table: string, field: string, value: string): Promise<AirtableRecord | null> {
    const hits = await this.list(table, {
      filterByFormula: `{${field}} = '${fEscape(value)}'`,
      maxRecords: "1",
    });
    return hits[0] ?? null;
  },

  async create(table: string, records: { fields: Fields }[], typecast = false): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    for (const batch of chunk(records)) {
      const res = await request<{ records: AirtableRecord[] }>(
        "POST",
        recordsUrl(encodeURIComponent(table)),
        { records: batch, typecast }
      );
      out.push(...res.records);
    }
    return out;
  },

  /**
   * Upsert by external ID — the workhorse of every integration.
   * mergeOn: field name(s) or ID(s) holding the external system's ID.
   */
  async upsert(
    table: string,
    records: { fields: Fields }[],
    mergeOn: string[],
    typecast = false
  ): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    for (const batch of chunk(records)) {
      const res = await request<{ records: AirtableRecord[] }>(
        "PATCH",
        recordsUrl(encodeURIComponent(table)),
        { records: batch, performUpsert: { fieldsToMergeOn: mergeOn }, typecast }
      );
      out.push(...res.records);
    }
    return out;
  },

  async update(table: string, records: { id: string; fields: Fields }[]): Promise<void> {
    for (const batch of chunk(records)) {
      await request("PATCH", recordsUrl(encodeURIComponent(table)), { records: batch });
    }
  },

  async destroy(table: string, ids: string[]): Promise<void> {
    for (const batch of chunk(ids)) {
      const qs = batch.map((id) => `records[]=${id}`).join("&");
      await request("DELETE", recordsUrl(`${encodeURIComponent(table)}?${qs}`));
    }
  },

  /**
   * Refresh an Airtable webhook (they expire after 7 days — an expired webhook
   * is the #1 cause of "the integration silently stopped"). Meta API, but it
   * still goes through this module's throttle/retry per the house rule.
   */
  async refreshWebhook(webhookId: string): Promise<{ expirationTime: string }> {
    return request<{ expirationTime: string }>(
      "POST",
      `${BASE_URL}/bases/${env.AIRTABLE_BASE_ID}/webhooks/${webhookId}/refresh`
    );
  },
};
