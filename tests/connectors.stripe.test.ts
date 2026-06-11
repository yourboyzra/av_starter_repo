import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stripeConnector } from "../src/connectors/stripe.js";
import { InvalidSignatureError } from "../src/connectors/types.js";

/** Uses STRIPE_WEBHOOK_SECRET from tests/setup.ts ("whsec_testsecret"). */
const SECRET = "whsec_testsecret";

function signedEvent(type: string, object: Record<string, unknown>) {
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: "evt_test_1", type, created, data: { object } });
  const sig = createHmac("sha256", SECRET).update(`${created}.${body}`).digest("hex");
  return { body, header: `t=${created},v1=${sig}`, created };
}

describe("stripeConnector.parseWebhook", () => {
  it("accepts a correctly signed event and normalizes it", async () => {
    const { body, header, created } = signedEvent("customer.updated", { id: "cus_9", name: "Ada" });

    const event = await stripeConnector.parseWebhook(body, { "stripe-signature": header });

    expect(event.eventId).toBe("evt_test_1");
    expect(event.records).toHaveLength(1);
    const rec = event.records[0]!;
    expect(rec.entity).toBe("customer"); // "customer.updated" -> "customer"
    expect(rec.externalId).toBe("cus_9");
    expect(rec.updatedAt).toBe(new Date(created * 1000).toISOString());
    expect((rec.raw as { name: string }).name).toBe("Ada");
  });

  it("rejects a tampered body", async () => {
    const { body, header } = signedEvent("customer.updated", { id: "cus_9" });
    const tampered = body.replace("cus_9", "cus_EVIL");

    await expect(
      stripeConnector.parseWebhook(tampered, { "stripe-signature": header })
    ).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects a missing signature header", async () => {
    const { body } = signedEvent("customer.updated", { id: "cus_9" });
    await expect(stripeConnector.parseWebhook(body, {})).rejects.toBeInstanceOf(InvalidSignatureError);
  });
});
