import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidSignatureError } from "../src/connectors/types.js";

vi.mock("../src/lib/oauth.js", () => ({
  getAccessToken: vi.fn(async () => "fake-qb-token"),
}));

const { quickbooksConnector } = await import("../src/connectors/quickbooks.js");

/** Must match QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN in tests/setup.ts */
const VERIFIER_TOKEN = "qb_webhook_verifier_token_test";

function signBody(body: string): string {
  return createHmac("sha256", VERIFIER_TOKEN).update(body).digest("base64");
}

describe("quickbooksConnector.push", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to create a new entity and returns the QB Id", async () => {
    const fakeResponse = {
      PurchaseOrder: { Id: "42", SyncToken: "0", MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fakeResponse), { status: 200 })));

    const id = await quickbooksConnector.push("purchase_order", null, { VendorRef: { value: "56" } });
    expect(id).toBe("42");
  });

  it("fetches SyncToken then POSTs ?operation=update with sparse:true", async () => {
    const getResponse = {
      PurchaseOrder: { Id: "42", SyncToken: "3", MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" } },
    };
    const updateResponse = {
      PurchaseOrder: { Id: "42", SyncToken: "4", MetaData: { LastUpdatedTime: "2026-01-02T00:00:00Z" } },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(getResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(updateResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const id = await quickbooksConnector.push("purchase_order", "42", { Memo: "updated" });
    expect(id).toBe("42");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [updateUrl, updateInit] = fetchMock.mock.calls[1]!;
    expect(String(updateUrl)).toContain("operation=update");
    const body = JSON.parse(updateInit!.body as string);
    expect(body.SyncToken).toBe("3");
    expect(body.sparse).toBe(true);
    expect(body.Id).toBe("42");
  });

  it("throws NotSupportedError for unknown entities", async () => {
    await expect(quickbooksConnector.push("invoice", null, {})).rejects.toThrow(/Not supported/);
  });
});

describe("quickbooksConnector.pullChanges", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls CDC and normalizes results", async () => {
    const fakeResponse = {
      CDCResponse: [
        {
          QueryResponse: [
            {
              PurchaseOrder: [
                { Id: "10", SyncToken: "0", MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" } },
                { Id: "11", SyncToken: "1", MetaData: { LastUpdatedTime: "2026-01-02T00:00:00Z" } },
              ],
            },
          ],
        },
      ],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fakeResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const records = await quickbooksConnector.pullChanges("purchase_order", "2026-01-01T00:00:00Z");
    expect(records).toHaveLength(2);
    expect(records[0]!.entity).toBe("purchase_order");
    expect(records[0]!.externalId).toBe("10");
    expect(records[1]!.externalId).toBe("11");

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("cdc");
    expect(String(url)).toContain("PurchaseOrder");
  });

  it("returns empty array when CDC has no matching entities", async () => {
    const fakeResponse = { CDCResponse: [{ QueryResponse: [{}] }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fakeResponse), { status: 200 })));

    const records = await quickbooksConnector.pullChanges("purchase_order", "2026-01-01T00:00:00Z");
    expect(records).toHaveLength(0);
  });

  it("throws NotSupportedError for unknown entities", async () => {
    await expect(quickbooksConnector.pullChanges("invoice", "2026-01-01T00:00:00Z")).rejects.toThrow(
      /Not supported/
    );
  });
});

describe("quickbooksConnector.parseWebhook", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ eventNotifications: [] });
    const sig = signBody(body);
    await expect(
      quickbooksConnector.parseWebhook(body + " ", { "intuit-signature": sig })
    ).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects a missing signature header", async () => {
    const body = JSON.stringify({ eventNotifications: [] });
    await expect(quickbooksConnector.parseWebhook(body, {})).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("accepts a valid signature and fetches changed entities", async () => {
    const notification = {
      eventNotifications: [
        {
          dataChangeEvent: {
            entities: [
              { name: "PurchaseOrder", id: "42", operation: "Update", lastUpdated: "2026-01-01T00:00:00Z" },
            ],
          },
        },
      ],
    };
    const body = JSON.stringify(notification);
    const sig = signBody(body);
    const fakeGet = {
      PurchaseOrder: { Id: "42", SyncToken: "1", MetaData: { LastUpdatedTime: "2026-01-01T00:00:00Z" } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fakeGet), { status: 200 })));

    const event = await quickbooksConnector.parseWebhook(body, { "intuit-signature": sig });
    expect(event.records).toHaveLength(1);
    expect(event.records[0]!.entity).toBe("purchase_order");
    expect(event.records[0]!.externalId).toBe("42");
  });

  it("skips entities we do not handle without failing", async () => {
    const notification = {
      eventNotifications: [
        {
          dataChangeEvent: {
            entities: [{ name: "Invoice", id: "99", operation: "Create", lastUpdated: "2026-01-01T00:00:00Z" }],
          },
        },
      ],
    };
    const body = JSON.stringify(notification);
    const sig = signBody(body);

    const event = await quickbooksConnector.parseWebhook(body, { "intuit-signature": sig });
    expect(event.records).toHaveLength(0);
  });
});
