import { createHash } from "node:crypto";
import { KEY_NONE } from "../../usageFilter.js";

const NO_KEY_BUCKET = "local-no-key";
const SUM_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 12) return key.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
  return key.slice(0, 8) + "***" + key.slice(-4);
}

// Stable, non-reversible id for a raw gateway key: catalog id when registered,
// "__none__" when absent, "ext:<hash>" for keys missing from the catalog.
export function apiKeyIdFor(rawKey, idByRawKey) {
  if (!rawKey || typeof rawKey !== "string") return KEY_NONE;
  const id = idByRawKey.get(rawKey);
  if (id) return id;
  return `ext:${createHash("sha256").update(rawKey).digest("hex").slice(0, 10)}`;
}

// stats.byApiKey is keyed by `${rawKey}|model|provider` (or "local-no-key…").
// Re-key it by API key id so raw keys never reach the browser.
export function redactByApiKey(byApiKey = {}, catalog = []) {
  const idByRaw = new Map(catalog.filter((k) => k.key).map((k) => [k.key, k.id]));
  const nameById = new Map(catalog.map((k) => [k.id, k.name]));
  const out = {};
  for (const [mapKey, rec] of Object.entries(byApiKey)) {
    const [first, ...rest] = mapKey.split("|");
    const rawKey = first === NO_KEY_BUCKET ? null : first;
    const apiKeyId = apiKeyIdFor(rawKey, idByRaw);
    const newKey = [apiKeyId, ...rest].join("|");
    const keyName = apiKeyId === KEY_NONE
      ? "Local (No API Key)"
      : nameById.get(apiKeyId) || `Unknown key (${maskApiKey(rawKey)})`;
    const { apiKey: _raw, ...clean } = rec;
    const prev = out[newKey];
    if (!prev) {
      out[newKey] = { ...clean, apiKeyId, keyName, apiKeyMasked: maskApiKey(rawKey), apiKeyKey: apiKeyId };
      continue;
    }
    for (const f of SUM_FIELDS) prev[f] = (prev[f] || 0) + (clean[f] || 0);
    if (clean.lastUsed && (!prev.lastUsed || clean.lastUsed > prev.lastUsed)) prev.lastUsed = clean.lastUsed;
  }
  return out;
}
