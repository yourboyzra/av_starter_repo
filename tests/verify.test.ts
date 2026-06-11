import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmac, verifyHmacBase64, verifyStripeSignature } from "../src/lib/verify.js";

const SECRET = "test-webhook-secret";
const BODY = '{"id":"evt_1","type":"customer.created"}';

describe("verifyHmac (hex)", () => {
  it("accepts a correct signature", () => {
    const sig = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyHmac(BODY, sig, SECRET)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyHmac(BODY, "deadbeef", SECRET)).toBe(false);
  });

  it("rejects a signature over a tampered body", () => {
    const sig = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyHmac(BODY + "x", sig, SECRET)).toBe(false);
  });
});

describe("verifyHmacBase64 (Airtable-style)", () => {
  it("accepts a correct base64 signature with a base64 secret", () => {
    const secretB64 = Buffer.from(SECRET).toString("base64");
    const sig = createHmac("sha256", Buffer.from(secretB64, "base64")).update(BODY).digest("base64");
    expect(verifyHmacBase64(BODY, sig, secretB64)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const secretB64 = Buffer.from(SECRET).toString("base64");
    expect(verifyHmacBase64(BODY, "bm9wZQ==", secretB64)).toBe(false);
  });
});

describe("verifyStripeSignature", () => {
  const sign = (body: string, ts: number, secret = SECRET) =>
    createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  it("accepts a valid, fresh signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${sign(BODY, ts)}`;
    expect(verifyStripeSignature(BODY, header, SECRET)).toBe(true);
  });

  it("accepts when one of several v1 signatures matches (key rotation)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${"0".repeat(64)},v1=${sign(BODY, ts)}`;
    expect(verifyStripeSignature(BODY, header, SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${sign(BODY, ts, "other-secret")}`;
    expect(verifyStripeSignature(BODY, header, SECRET)).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const ts = Math.floor(Date.now() / 1000) - 3600; // 1 h old > 300 s tolerance
    const header = `t=${ts},v1=${sign(BODY, ts)}`;
    expect(verifyStripeSignature(BODY, header, SECRET)).toBe(false);
  });

  it("rejects malformed headers", () => {
    expect(verifyStripeSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyStripeSignature(BODY, "t=,v1=", SECRET)).toBe(false);
    expect(verifyStripeSignature(BODY, "v1=abc", SECRET)).toBe(false);
  });
});
