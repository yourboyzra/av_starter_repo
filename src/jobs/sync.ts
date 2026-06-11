import { registry } from "../connectors/registry.js";
import { runReconciliation } from "../sync/engine.js";

/**
 * Pattern B: scheduled reconciliation across all registered providers.
 * Webhooks miss events (provider outages, our downtime, expired
 * subscriptions); a watermark-based sync that self-heals is the difference
 * between a demo and a product. Always keep this running, even for
 * webhook-driven providers.
 */
export async function runSync(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const [provider, registration] of Object.entries(registry)) {
    try {
      results[provider] = await runReconciliation(provider, registration);
    } catch (err) {
      console.error(`[sync] ${provider} failed:`, err);
      results[provider] = { error: String(err) };
    }
  }
  return results;
}
