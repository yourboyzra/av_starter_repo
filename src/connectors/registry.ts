import type { ProviderRegistration } from "./types.js";
import { stripeConnector } from "./stripe.js";
import { stripeSpecs } from "../mappers/stripe.js";

/**
 * Provider registry. Adding a provider = one adapter, one mapper spec, one
 * line here. The webhook route, sync job, and outbound endpoint all resolve
 * providers through this map — nothing else changes.
 */
export const registry: Record<string, ProviderRegistration> = {
  stripe: { connector: stripeConnector, specs: stripeSpecs },
};
