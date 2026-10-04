import { describe, it, expect } from "vitest";
import {
  KEY_NONE, KEY_UNKNOWN, DEFAULT_USAGE_FILTER,
  normalizeUsageFilter, isUsageFilterActive, resolveUsageFilter,
  buildUsageFilterSql, matchesUsageFilter,
} from "../../src/lib/usageFilter.js";
import { apiKeyIdFor, maskApiKey, redactByApiKey } from "../../src/lib/db/repos/usageApiKeyRedaction.js";

const catalog = [
  { id: "id-a", key: "sk-aaaaaaaa-1111", name: "Alpha", tags: ["clientes"] },
  { id: "id-b", key: "sk-bbbbbbbb-2222", name: "Beta", tags: [] },
];

describe("normalizeUsageFilter", () => {
  it("defaults to all/all", () => {
    expect(normalizeUsageFilter(DEFAULT_USAGE_FILTER)).toEqual({
      providers: { mode: "all", ids: [] },
      apiKeys: { mode: "all", ids: [], tags: [] },
      requestKind: "work",
    });
    expect(normalizeUsageFilter({})).toEqual(normalizeUsageFilter(DEFAULT_USAGE_FILTER));
  });

  it("lowercases provider ids and tags, keeps key ids, dedupes", () => {
    expect(normalizeUsageFilter({
      providers: { mode: "selected", ids: [" OpenAI ", "openai", "edge-tts"] },
      apiKeys: { mode: "selected", ids: ["Id-A", "Id-A", KEY_NONE], tags: ["Clientes", "clientes"] },
    })).toEqual({
      providers: { mode: "selected", ids: ["openai", "edge-tts"] },
      apiKeys: { mode: "selected", ids: ["Id-A", KEY_NONE], tags: ["clientes"] },
      requestKind: "work",
    });
  });

  it("accepts request kinds and treats non-work kinds as active", () => {
    expect(normalizeUsageFilter({ requestKind: "meta" }).requestKind).toBe("meta");
    expect(isUsageFilterActive({ ...DEFAULT_USAGE_FILTER, requestKind: "meta" })).toBe(true);
    expect(isUsageFilterActive({ ...DEFAULT_USAGE_FILTER, requestKind: "all" })).toBe(true);
  });

  it("drops lists in all mode and keeps explicit empty selections", () => {
    const f = normalizeUsageFilter({
      providers: { mode: "all", ids: ["openai"] },
      apiKeys: { mode: "selected", ids: [], tags: [] },
    });
    expect(f.providers).toEqual({ mode: "all", ids: [] });
    expect(f.apiKeys).toEqual({ mode: "selected", ids: [], tags: [] });
    expect(isUsageFilterActive(f)).toBe(true);
    expect(isUsageFilterActive(DEFAULT_USAGE_FILTER)).toBe(false);
  });

  it.each([
    [null],
    [[]],
    [{ providers: { mode: "nope", ids: [] } }],
    [{ apiKeys: { mode: "selected", ids: "id-a" } }],
    [{ apiKeys: { mode: "selected", ids: [""] } }],
    [{ apiKeys: { mode: "selected", ids: [42] } }],
    [{ providers: { mode: "selected", ids: Array.from({ length: 201 }, (_, i) => `p${i}`) } }],
    [{ requestKind: "everything" }],
  ])("rejects invalid input %#", (value) => {
    expect(() => normalizeUsageFilter(value)).toThrow(TypeError);
  });
});

describe("resolveUsageFilter + matchers", () => {
  const resolve = (f) => resolveUsageFilter(f, catalog);

  it("default filter is inactive but keeps only work requests", () => {
    const r = resolve(DEFAULT_USAGE_FILTER);
    expect(r.active).toBe(false);
    expect(buildUsageFilterSql(r)).toEqual({ sql: "kind = 'work'", params: [] });
    expect(buildUsageFilterSql(null)).toEqual({ sql: "kind = 'work'", params: [] });
    expect(matchesUsageFilter(r, { provider: "x", apiKey: null })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "x", apiKey: null, kind: "meta" })).toBe(false);
    expect(matchesUsageFilter(null, { provider: "x", kind: "meta" })).toBe(false);
  });

  it("selects metadata or every kind", () => {
    const meta = resolve({ requestKind: "meta" });
    expect(meta.active).toBe(true);
    expect(buildUsageFilterSql(meta).sql).toBe("kind = 'meta'");
    expect(matchesUsageFilter(meta, { provider: "9router", kind: "meta" })).toBe(true);
    expect(matchesUsageFilter(meta, { provider: "openai", kind: "work" })).toBe(false);
    const all = resolve({ requestKind: "all" });
    expect(buildUsageFilterSql(all)).toEqual({ sql: "", params: [] });
    expect(matchesUsageFilter(all, { provider: "9router", kind: "meta" })).toBe(true);
  });

  it("resolves key ids and tags to raw keys (OR) and ignores deleted ids", () => {
    const r = resolve({ apiKeys: { mode: "selected", ids: ["id-b", "id-gone"], tags: ["clientes"] } });
    expect([...r.keys.raw].sort()).toEqual(["sk-aaaaaaaa-1111", "sk-bbbbbbbb-2222"]);
    expect(r.keys.none).toBe(false);
    expect(r.keys.unknown).toBe(false);
  });

  it("matches none/unknown specials", () => {
    const r = resolve({ apiKeys: { mode: "selected", ids: [KEY_NONE, KEY_UNKNOWN] } });
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: null })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "" })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-ghost" })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-aaaaaaaa-1111" })).toBe(false);
  });

  it("ANDs providers with keys, provider match is case-insensitive", () => {
    const r = resolve({
      providers: { mode: "selected", ids: ["openai"] },
      apiKeys: { mode: "selected", ids: ["id-a"] },
    });
    expect(matchesUsageFilter(r, { provider: "OpenAI", apiKey: "sk-aaaaaaaa-1111" })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "anthropic", apiKey: "sk-aaaaaaaa-1111" })).toBe(false);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-bbbbbbbb-2222" })).toBe(false);
  });

  it("builds parameterized SQL in clause order", () => {
    const r = resolve({
      providers: { mode: "selected", ids: ["openai"] },
      apiKeys: { mode: "selected", ids: ["id-a", KEY_NONE, KEY_UNKNOWN] },
    });
    const { sql, params } = buildUsageFilterSql(r);
    expect(sql).toBe(
      "kind = 'work' AND LOWER(COALESCE(provider, '')) IN (?) AND (apiKey IN (?) OR (apiKey IS NULL OR apiKey = '') OR (apiKey IS NOT NULL AND apiKey <> '' AND apiKey NOT IN (SELECT key FROM apiKeys)))"
    );
    expect(params).toEqual(["openai", "sk-aaaaaaaa-1111"]);
  });

  it("empty selections match nothing", () => {
    const r = resolve({ apiKeys: { mode: "selected", ids: [], tags: [] } });
    expect(buildUsageFilterSql(r).sql).toBe("kind = 'work' AND 0");
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-aaaaaaaa-1111" })).toBe(false);
  });
});

describe("api key redaction", () => {
  it("masks keys like v0.5.95", () => {
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey("short")).toBe("s***");
    expect(maskApiKey("sk-aaaaaaaa-1111")).toBe("sk-aaaaa***1111");
  });

  it("gives stable ids", () => {
    const idByRaw = new Map([["sk-aaaaaaaa-1111", "id-a"]]);
    expect(apiKeyIdFor("sk-aaaaaaaa-1111", idByRaw)).toBe("id-a");
    expect(apiKeyIdFor(null, idByRaw)).toBe(KEY_NONE);
    expect(apiKeyIdFor("sk-ghost", idByRaw)).toMatch(/^ext:[0-9a-f]{10}$/);
    expect(apiKeyIdFor("sk-ghost", idByRaw)).toBe(apiKeyIdFor("sk-ghost", idByRaw));
  });

  it("re-keys byApiKey without raw keys and merges collisions", () => {
    const out = redactByApiKey({
      "sk-aaaaaaaa-1111|gpt|openai": { requests: 2, promptTokens: 10, completionTokens: 5, cachedTokens: 0, cost: 1, rawModel: "gpt", apiKey: "sk-aaaaaaaa-1111", lastUsed: "2026-09-01" },
      "local-no-key|gpt|openai": { requests: 1, promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0, lastUsed: "2026-09-02" },
      "local-no-key": { requests: 1, promptTokens: 2, completionTokens: 2, cachedTokens: 0, cost: 0, lastUsed: "2026-09-03T10:00:00.000Z" },
      "sk-ghost-0000000000|gpt|openai": { requests: 1, promptTokens: 3, completionTokens: 3, cachedTokens: 0, cost: 0 },
    }, catalog);

    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-aaaaaaaa-1111");
    expect(json).not.toContain("sk-ghost-0000000000");
    expect(out["id-a|gpt|openai"]).toMatchObject({ apiKeyId: "id-a", keyName: "Alpha", promptTokens: 10, apiKeyMasked: "sk-aaaaa***1111" });
    expect(out["id-a|gpt|openai"].apiKey).toBeUndefined();
    expect(out["__none__|gpt|openai"]).toMatchObject({ apiKeyId: KEY_NONE, keyName: "Local (No API Key)" });
    expect(out["__none__"]).toMatchObject({ apiKeyId: KEY_NONE, promptTokens: 2 });
    const ghost = Object.values(out).find((r) => r.apiKeyId.startsWith("ext:"));
    expect(ghost.keyName).toBe("Unknown key (sk-ghost***0000)");
  });
});
