import { describe, expect, it, vi, afterEach } from "vitest";
import { InvalidSignatureError } from "../src/connectors/types.js";
import { shipstationConnector, WEBHOOK_SECRET_HEADER } from "../src/connectors/shipstation.js";

/** Uses SHIPSTATION_WEBHOOK_SECRET from tests/setup.ts. */
const SECRET = "shipstation_webhook_testsecret";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shipstationConnector.parseWebhook", () => {
  it("rejects a missing/wrong shared-secret header", async () => {
    await expect(
      shipstationConnector.parseWebhook(JSON.stringify({ shipment_id: "se-1" }), {
        [WEBHOOK_SECRET_HEADER]: "wrong",
      })
    ).rejects.toBeInstanceOf(InvalidSignatureError);

    await expect(shipstationConnector.parseWebhook(JSON.stringify({ shipment_id: "se-1" }), {})).rejects.toBeInstanceOf(
      InvalidSignatureError
    );
  });

  it("throws a clear error when no shipment_id can be found in the payload", async () => {
    await expect(
      shipstationConnector.parseWebhook(JSON.stringify({ something_else: true }), {
        [WEBHOOK_SECRET_HEADER]: SECRET,
      })
    ).rejects.toThrow(/shipment_id/);
  });

  it("re-fetches the shipment by id and normalizes it, given a valid header", async () => {
    const fakeShipment = { shipment_id: "se-1", modified_at: "2026-01-01T00:00:00Z", ship_date: "2026-01-02" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(fakeShipment), { status: 200 }))
    );

    const event = await shipstationConnector.parseWebhook(JSON.stringify({ shipment_id: "se-1" }), {
      [WEBHOOK_SECRET_HEADER]: SECRET,
    });

    expect(event.records).toHaveLength(1);
    expect(event.records[0]!.entity).toBe("shipment");
    expect(event.records[0]!.externalId).toBe("se-1");
    expect(event.records[0]!.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("produces a stable, content-based eventId for the same payload (no documented delivery-id field)", async () => {
    const fakeShipment = { shipment_id: "se-1", modified_at: "2026-01-01T00:00:00Z" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(fakeShipment), { status: 200 }))
    );

    const body = JSON.stringify({ shipment_id: "se-1" });
    const first = await shipstationConnector.parseWebhook(body, { [WEBHOOK_SECRET_HEADER]: SECRET });
    const second = await shipstationConnector.parseWebhook(body, { [WEBHOOK_SECRET_HEADER]: SECRET });
    expect(first.eventId).toBe(second.eventId);
  });
});
