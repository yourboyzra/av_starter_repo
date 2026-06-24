import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification. Never skip this — an unverified webhook
 * endpoint is a public write API into the client's base.
 *
 * Universal principle: HMAC over the RAW, UNPARSED body, compared with
 * timingSafeEqual. Read the raw body before JSON parsing.
 */

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** HMAC-SHA256, hex digest (most providers). */
export function verifyHmac(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

/** HMAC-SHA256, base64 digest (e.g. Airtable webhook notifications, macSecretBase64). */
export function verifyHmacBase64(rawBody: string, signature: string, secretBase64: string): boolean {
  const expected = createHmac("sha256", Buffer.from(secretBase64, "base64"))
    .update(rawBody)
    .digest("base64");
  return safeEqual(expected, signature);
}

/**
 * HMAC-SHA256, base64 digest, PLAIN secret (e.g. Shopify's
 * X-Shopify-Hmac-Sha256 — unlike verifyHmacBase64 above, the secret itself
 * is a plain string, not base64-encoded; only the digest is base64).
 */
export function verifyHmacBase64PlainSecret(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(expected, signature);
}

/**
 * Plain shared-secret header comparison — no HMAC at all. For providers like
 * ShipStation V2, where webhook "verification" is just configuring a custom
 * header (key + value) at subscription time that gets echoed back on every
 * delivery; there's no signature to compute, just a constant-time match.
 */
export function verifySharedSecret(received: string | undefined, expected: string): boolean {
  return typeof received === "string" && safeEqual(received, expected);
}

/**
 * Stripe-style: signature header `t=<ts>,v1=<sig>[,v1=...]`, HMAC over
 * `${t}.${rawBody}`, with timestamp tolerance for replay protection.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  const parts = new Map<string, string[]>();
  for (const kv of header.split(",")) {
    const [k, v] = kv.split("=", 2);
    if (!k || v === undefined) continue;
    const key = k.trim();
    parts.set(key, [...(parts.get(key) ?? []), v]);
  }
  const ts = parts.get("t")?.[0];
  const sigs = parts.get("v1") ?? [];
  if (!ts || sigs.length === 0) return false;

  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return sigs.some((sig) => safeEqual(expected, sig));
}
