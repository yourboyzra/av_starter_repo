import type { ProviderRegistration } from "./types.js";
import { shopifyConnector } from "./shopify.js";
import { shopifySpecs } from "../mappers/shopify.js";
import { shipstationConnector } from "./shipstation.js";
import { shipstationSpecs } from "../mappers/shipstation.js";
import { quickbooksConnector } from "./quickbooks.js";
import { quickbooksSpecs } from "../mappers/quickbooks.js";

/**
 * Provider registry. Adding a provider = one adapter, one mapper spec, one
 * line here. The webhook route, sync job, and outbound endpoint all resolve
 * providers through this map — nothing else changes.
 */
export const registry: Record<string, ProviderRegistration> = {
  shopify: { connector: shopifyConnector, specs: shopifySpecs },
  shipstation: { connector: shipstationConnector, specs: shipstationSpecs },
  quickbooks: { connector: quickbooksConnector, specs: quickbooksSpecs },
};
