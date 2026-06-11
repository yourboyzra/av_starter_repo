import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AirtableRecord } from "../src/lib/airtable.js";

/**
 * Sync engine tests with the Airtable client mocked — verifies the echo
 * suppression guards (timestamp + content) and the outbound write-back path
 * without touching the network.
 */

vi.mock("../src/lib/airtable.js", () => ({
  fEscape: (s: string) => s.replace(/'/g, "\\'"),
  airtable: {
    findByField: vi.fn(),
    upsert: vi.fn(async () => []),
    update: vi.fn(async () => undefined),
    find: vi.fn(),
    list: vi.fn(async () => []),
    create: vi.fn(async () => []),
  },
}));

const { airtable } = await import("../src/lib/airtable.js");
const { processInbound, pushOutbound } = await import("../src/sync/engine.js");
const { NotSupportedError } = await import("../src/connectors/types.js");
const { stripeSpecs } = await import("../src/mappers/stripe.js");

const mocked = vi.mocked(airtable);

const customerEvent = (overrides: Partial<{ updatedAt: string; raw: Record<string, unknown> }> = {}) => ({
  externalId: "cus_1",
  entity: "customer",
  updatedAt: overrides.updatedAt ?? "2026-06-01T12:00:00.000Z",
  raw: overrides.raw ?? { id: "cus_1", name: "Ada", email: "a@b.co", phone: "" },
});

const existingRecord = (fields: Record<string, unknown>): AirtableRecord => ({
  id: "recEXISTING",
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processInbound", () => {
  it("writes a new record with Synced At and Sync Status", async () => {
    mocked.findByField.mockResolvedValue(null);

    const result = await processInbound(stripeSpecs, [customerEvent()]);

    expect(result).toEqual({ written: 1, skipped: 0 });
    expect(mocked.upsert).toHaveBeenCalledTimes(1);
    const [table, records, mergeOn] = mocked.upsert.mock.calls[0]!;
    expect(table).toBe("Customers");
    expect(mergeOn).toEqual(["Stripe ID"]);
    const fields = records[0]!.fields;
    expect(fields["Stripe ID"]).toBe("cus_1");
    expect(fields["Sync Status"]).toBe("Synced");
    expect(typeof fields["Stripe Synced At"]).toBe("string");
  });

  it("timestamp guard: skips events older than the record's last sync (echo suppression)", async () => {
    mocked.findByField.mockResolvedValue(
      existingRecord({ "Stripe Synced At": "2026-06-02T00:00:00.000Z" }) // synced AFTER the event
    );

    const result = await processInbound(stripeSpecs, [customerEvent({ updatedAt: "2026-06-01T12:00:00.000Z" })]);

    expect(result).toEqual({ written: 0, skipped: 1 });
    expect(mocked.upsert).not.toHaveBeenCalled();
  });

  it("content guard: skips when mapped fields equal stored values (no write -> no echo)", async () => {
    mocked.findByField.mockResolvedValue(
      existingRecord({
        "Stripe Synced At": "2026-05-01T00:00:00.000Z", // older than event — passes timestamp guard
        "Stripe ID": "cus_1",
        Name: "Ada",
        Email: "a@b.co",
        Phone: "",
      })
    );

    const result = await processInbound(stripeSpecs, [customerEvent()]);

    expect(result).toEqual({ written: 0, skipped: 1 });
    expect(mocked.upsert).not.toHaveBeenCalled();
  });

  it("writes when content actually changed", async () => {
    mocked.findByField.mockResolvedValue(
      existingRecord({
        "Stripe Synced At": "2026-05-01T00:00:00.000Z",
        "Stripe ID": "cus_1",
        Name: "Old Name",
        Email: "a@b.co",
        Phone: "",
      })
    );

    const result = await processInbound(stripeSpecs, [customerEvent()]);

    expect(result).toEqual({ written: 1, skipped: 0 });
    expect(mocked.upsert).toHaveBeenCalledTimes(1);
  });

  it("ignores entities with no mapping spec", async () => {
    const result = await processInbound(stripeSpecs, [{ ...customerEvent(), entity: "subscription" }]);
    expect(result).toEqual({ written: 0, skipped: 1 });
    expect(mocked.findByField).not.toHaveBeenCalled();
  });

  it("processes oldest events first so the newest data lands last", async () => {
    mocked.findByField.mockResolvedValue(null);
    await processInbound(stripeSpecs, [
      customerEvent({ updatedAt: "2026-06-03T00:00:00.000Z", raw: { id: "cus_1", name: "Newest" } }),
      customerEvent({ updatedAt: "2026-06-01T00:00:00.000Z", raw: { id: "cus_1", name: "Oldest" } }),
    ]);
    const names = mocked.upsert.mock.calls.map((c) => c[1][0]!.fields["Name"]);
    expect(names).toEqual(["Oldest", "Newest"]);
  });
});

describe("pushOutbound", () => {
  const spec = stripeSpecs["customer"]!;

  it("pushes and writes the returned ID + Synced status back (trust the returned ID)", async () => {
    mocked.find.mockResolvedValue(
      existingRecord({ Name: "Ada", Email: "a@b.co", Phone: "", "Stripe ID": "" })
    );
    const connector = {
      name: "stripe",
      pullChanges: vi.fn(),
      parseWebhook: vi.fn(),
      push: vi.fn(async () => "cus_RETURNED"), // provider may merge and return a different ID
    };

    const result = await pushOutbound(connector, spec, "customer", "recEXISTING");

    expect(result).toEqual({ externalId: "cus_RETURNED" });
    expect(connector.push).toHaveBeenCalledWith("customer", null, expect.objectContaining({ name: "Ada" }));
    const writeBack = mocked.update.mock.calls[0]![1][0]!;
    expect(writeBack.fields["Stripe ID"]).toBe("cus_RETURNED");
    expect(writeBack.fields["Sync Status"]).toBe("Synced");
  });

  it("on failure: sets Sync Status=Error and Sync Error in the base, then rethrows", async () => {
    mocked.find.mockResolvedValue(existingRecord({ Name: "Ada", "Stripe ID": "cus_1" }));
    const connector = {
      name: "stripe",
      pullChanges: vi.fn(),
      parseWebhook: vi.fn(),
      push: vi.fn(async () => {
        throw new Error("stripe is down");
      }),
    };

    await expect(pushOutbound(connector, spec, "customer", "recEXISTING")).rejects.toThrow("stripe is down");
    const writeBack = mocked.update.mock.calls[0]![1][0]!;
    expect(writeBack.fields["Sync Status"]).toBe("Error");
    expect(String(writeBack.fields["Sync Error"])).toContain("stripe is down");
  });

  it("throws NotSupportedError for inbound-only entities (invoice)", async () => {
    const connector = { name: "stripe", pullChanges: vi.fn(), parseWebhook: vi.fn(), push: vi.fn() };
    await expect(
      pushOutbound(connector, stripeSpecs["invoice"]!, "invoice", "recX")
    ).rejects.toBeInstanceOf(NotSupportedError);
  });
});
