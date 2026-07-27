/** Lookup fields (multipleLookupValues) come back as arrays — take the first value. */
export function firstLookup(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}
