// Usage dashboard filter: which providers and which gateway API keys the
// /dashboard/usage page aggregates. Persisted globally in settings.usageFilter.
// Client-safe (no node imports); resolve/SQL helpers are only called server-side.

export const KEY_NONE = "__none__"; // requests made without an API key
export const KEY_UNKNOWN = "__unknown__"; // keys missing from the apiKeys table (deleted / never registered)
// "work" asks a provider to do something; "meta" only reads router metadata (model lists, voices…).
export const REQUEST_KINDS = Object.freeze(["work", "meta", "all"]);
const MAX_IDS = 200;

export const DEFAULT_USAGE_FILTER = Object.freeze({
  providers: Object.freeze({ mode: "all", ids: Object.freeze([]) }),
  apiKeys: Object.freeze({ mode: "all", ids: Object.freeze([]), tags: Object.freeze([]) }),
  requestKind: "work",
});

function normalizeMode(mode, field) {
  if (mode !== "all" && mode !== "selected") throw new TypeError(`Invalid ${field}.mode`);
  return mode;
}

function normalizeIdList(value, field, lowercase) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (value.length > MAX_IDS) throw new TypeError(`Too many ${field}`);
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) throw new TypeError(`${field} must contain non-empty strings`);
    const id = lowercase ? raw.trim().toLowerCase() : raw.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeUsageFilter(value) {
  if (!isPlainObject(value)) throw new TypeError("Invalid usage filter");
  const providers = value.providers ?? DEFAULT_USAGE_FILTER.providers;
  const apiKeys = value.apiKeys ?? DEFAULT_USAGE_FILTER.apiKeys;
  if (!isPlainObject(providers) || !isPlainObject(apiKeys)) throw new TypeError("Invalid usage filter");

  const providerMode = normalizeMode(providers.mode, "providers");
  const keyMode = normalizeMode(apiKeys.mode, "apiKeys");
  const providerIds = normalizeIdList(providers.ids, "providers.ids", true);
  const keyIds = normalizeIdList(apiKeys.ids, "apiKeys.ids", false);
  const tags = normalizeIdList(apiKeys.tags, "apiKeys.tags", true);
  const requestKind = value.requestKind ?? "work";
  if (!REQUEST_KINDS.includes(requestKind)) throw new TypeError("Invalid requestKind");

  return {
    providers: providerMode === "all" ? { mode: "all", ids: [] } : { mode: "selected", ids: providerIds },
    apiKeys: keyMode === "all" ? { mode: "all", ids: [], tags: [] } : { mode: "selected", ids: keyIds, tags },
    requestKind,
  };
}

export function isUsageFilterActive(filter) {
  return filter?.providers?.mode === "selected"
    || filter?.apiKeys?.mode === "selected"
    || (filter?.requestKind ?? "work") !== "work";
}

// catalog: [{ id, key, tags }] from apiKeysRepo. Tags are resolved here, at query
// time, so a key that gains/loses a tag enters/leaves the filter immediately.
export function resolveUsageFilter(filter, catalog = []) {
  const f = normalizeUsageFilter(filter ?? DEFAULT_USAGE_FILTER);
  const knownRaw = new Set(catalog.map((k) => k.key).filter(Boolean));
  const resolved = { active: isUsageFilterActive(f), requestKind: f.requestKind, providers: null, keys: null, knownRaw };
  if (f.providers.mode === "selected") resolved.providers = new Set(f.providers.ids);
  if (f.apiKeys.mode === "selected") {
    const ids = new Set(f.apiKeys.ids);
    const tags = new Set(f.apiKeys.tags);
    const raw = new Set();
    for (const k of catalog) {
      if (!k.key) continue;
      if (ids.has(k.id) || (k.tags || []).some((t) => tags.has(t))) raw.add(k.key);
    }
    resolved.keys = { raw, none: ids.has(KEY_NONE), unknown: ids.has(KEY_UNKNOWN) };
  }
  return resolved;
}

// Boolean SQL expression over usageHistory columns, meant to follow "AND".
// The request-kind cut always applies: without a filter, dashboards show work only.
export function buildUsageFilterSql(resolved) {
  const clauses = [];
  const params = [];
  const kind = resolved?.requestKind ?? "work";
  if (kind !== "all") clauses.push(kind === "meta" ? "kind = 'meta'" : "kind = 'work'");
  if (!resolved?.active) return { sql: clauses.join(" AND "), params };
  if (resolved.providers) {
    if (!resolved.providers.size) {
      clauses.push("0");
    } else {
      clauses.push(`LOWER(COALESCE(provider, '')) IN (${[...resolved.providers].map(() => "?").join(", ")})`);
      params.push(...resolved.providers);
    }
  }
  if (resolved.keys) {
    const parts = [];
    if (resolved.keys.raw.size) {
      parts.push(`apiKey IN (${[...resolved.keys.raw].map(() => "?").join(", ")})`);
      params.push(...resolved.keys.raw);
    }
    if (resolved.keys.none) parts.push("(apiKey IS NULL OR apiKey = '')");
    if (resolved.keys.unknown) parts.push("(apiKey IS NOT NULL AND apiKey <> '' AND apiKey NOT IN (SELECT key FROM apiKeys))");
    clauses.push(parts.length ? `(${parts.join(" OR ")})` : "0");
  }
  return { sql: clauses.join(" AND "), params };
}

// Same semantics as buildUsageFilterSql, for in-memory entries ({ provider, apiKey, kind }).
export function matchesUsageFilter(resolved, entry) {
  const kind = resolved?.requestKind ?? "work";
  if (kind !== "all" && (entry?.kind || "work") !== kind) return false;
  if (!resolved?.active) return true;
  if (resolved.providers && !resolved.providers.has(String(entry?.provider || "").toLowerCase())) return false;
  if (resolved.keys) {
    const key = entry?.apiKey;
    if (!key) return resolved.keys.none;
    if (resolved.keys.raw.has(key)) return true;
    return resolved.keys.unknown && !resolved.knownRaw.has(key);
  }
  return true;
}
