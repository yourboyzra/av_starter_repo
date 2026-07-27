/** Escape a value for safe HTML output. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Safely extract a string field value from an Airtable fields object. */
export function str(fields: Record<string, unknown>, key: string): string {
  return String(fields[key] ?? "");
}
