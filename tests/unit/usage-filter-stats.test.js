import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KEY_NONE, KEY_UNKNOWN } from "../../src/lib/usageFilter.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const GHOST = "sk-ghost-key-0000000000";
let db;
let repo;
let a;
let b;

async function save(apiKey, provider, prompt, completion, extra = {}) {
  await db.saveRequestUsage({
    provider, model: `${provider.toLowerCase()}-model`, connectionId: "c1", apiKey,
    endpoint: "/v1/chat/completions", tokens: { prompt_tokens: prompt, completion_tokens: completion },
    status: "ok", ...extra,
  });
}

async function statsWith(filter, period = "today") {
  await repo.setUsageFilter(filter);
  return db.getUsageStats(period, await repo.getResolvedUsageFilter());
}

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-stats-"));
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  a = await db.createApiKey("Alpha", "machine-test");
  b = await db.createApiKey("Beta", "machine-test");
  await db.updateApiKey(a.id, { tags: ["clientes"] });
  await save(a.key, "openai", 10, 5);
  await save(b.key, "anthropic", 20, 10);
  await save(null, "openai", 1, 1);
  await save(GHOST, "OpenAI", 3, 3);
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("getUsageStats with a usage filter", () => {
  it("filters by key id across totals and breakdowns", async () => {
    const s = await statsWith({ apiKeys: { mode: "selected", ids: [a.id] } });
    expect(s.filterActive).toBe(true);
    expect(s.totalPromptTokens).toBe(10);
    expect(s.totalCompletionTokens).toBe(5);
    expect(s.totalRequests).toBe(1);
    expect(Object.keys(s.byProvider)).toEqual(["openai"]);
    expect(Object.values(s.byApiKey).every((r) => r.apiKeyId === a.id)).toBe(true);
    expect(s.recentRequests).toHaveLength(1);
    expect(s.recentRequests[0].promptTokens).toBe(10);
    expect(s.last10Minutes.reduce((n, m) => n + m.requests, 0)).toBe(1);
  });

  it("filters by tag", async () => {
    expect((await statsWith({ apiKeys: { mode: "selected", tags: ["clientes"] } })).totalPromptTokens).toBe(10);
  });

  it("tag filters are resolved at query time", async () => {
    await repo.setUsageFilter({ apiKeys: { mode: "selected", tags: ["clientes"] } });
    await db.updateApiKey(a.id, { tags: [] });
    const s = await db.getUsageStats("today", await repo.getResolvedUsageFilter());
    expect(s.totalPromptTokens).toBe(0);
  });

  it("matches providers case-insensitively", async () => {
    expect((await statsWith({ providers: { mode: "selected", ids: ["openai"] } })).totalPromptTokens).toBe(14);
  });

  it("ANDs providers and keys", async () => {
    const s = await statsWith({ providers: { mode: "selected", ids: ["anthropic"] }, apiKeys: { mode: "selected", ids: [a.id] } });
    expect(s.totalRequests).toBe(0);
  });

  it("selects requests without key and unknown keys", async () => {
    expect((await statsWith({ apiKeys: { mode: "selected", ids: [KEY_NONE] } })).totalPromptTokens).toBe(1);
    expect((await statsWith({ apiKeys: { mode: "selected", ids: [KEY_UNKNOWN] } })).totalPromptTokens).toBe(3);
  });

  it("empty selection shows nothing", async () => {
    const s = await statsWith({ apiKeys: { mode: "selected", ids: [], tags: [] } });
    expect(s.totalRequests).toBe(0);
    expect(s.totalPromptTokens).toBe(0);
    expect(s.recentRequests).toEqual([]);
  });

  it("ignores ids of deleted keys", async () => {
    const s = await statsWith({ apiKeys: { mode: "selected", ids: ["deleted-key-id"] } });
    expect(s.totalRequests).toBe(0);
  });

  it("explicit full selection matches unfiltered totals", async () => {
    const unfiltered = await db.getUsageStats("7d");
    const all = await statsWith({ apiKeys: { mode: "selected", ids: [a.id, b.id, KEY_NONE, KEY_UNKNOWN] } }, "7d");
    expect(all.totalPromptTokens).toBe(unfiltered.totalPromptTokens);
    expect(all.totalCompletionTokens).toBe(unfiltered.totalCompletionTokens);
    expect(all.totalRequests).toBe(unfiltered.totalRequests);
    expect(unfiltered.totalPromptTokens).toBe(34);
  });

  it("uses calendar-day windows for filtered periods", async () => {
    await save(a.key, "openai", 100, 0, { timestamp: new Date(Date.now() - 3 * 86400000).toISOString() });
    const filter = { apiKeys: { mode: "selected", ids: [a.id] } };
    expect((await statsWith(filter, "today")).totalPromptTokens).toBe(10);
    expect((await statsWith(filter, "7d")).totalPromptTokens).toBe(110);
    expect((await statsWith(filter, "all")).totalPromptTokens).toBe(110);
  });
});

describe("getUsageStats request kinds and recent requests", () => {
  const meta = () => db.saveRequestUsage({ provider: "9router", model: "unknown", apiKey: a.key, endpoint: "/v1/models", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "meta" });

  it.each(["today", "7d"])("excludes metadata requests by default (%s)", async (period) => {
    await meta();
    const s = await db.getUsageStats(period);
    expect(s.totalRequests).toBe(4);
    expect(s.recentRequests.some((r) => r.endpoint === "/v1/models")).toBe(false);
  });

  it("shows only metadata or every kind on request", async () => {
    await meta();
    const onlyMeta = await statsWith({ requestKind: "meta" });
    expect(onlyMeta.totalRequests).toBe(1);
    expect(Object.keys(onlyMeta.byProvider)).toEqual(["9router"]);
    expect((await statsWith({ requestKind: "all" })).totalRequests).toBe(5);
  });

  it("lists zero-token rows such as errors in recent requests", async () => {
    await db.saveRequestUsage({ provider: "openai", model: "broken-model", apiKey: a.key, endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "error", httpStatus: 503, kind: "work" });
    const s = await db.getUsageStats("today");
    const row = s.recentRequests.find((r) => r.model === "broken-model");
    expect(row).toMatchObject({ status: "error", httpStatus: 503, endpoint: "/v1/chat/completions", kind: "work" });
  });
});

describe("getUsageStats API key redaction", () => {
  it.each(["today", "24h", "7d", "all"])("never returns raw keys (%s)", async (period) => {
    const s = await db.getUsageStats(period);
    const json = JSON.stringify(s);
    for (const raw of [a.key, b.key, GHOST]) expect(json).not.toContain(raw);
    expect(s.filterActive).toBe(false);
    const ids = new Set(Object.values(s.byApiKey).map((r) => r.apiKeyId));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(KEY_NONE)).toBe(true);
    expect([...ids].some((id) => id.startsWith("ext:"))).toBe(true);
    expect(s.apiKeyCatalog).toHaveLength(2);
    expect(s.apiKeyCatalog).toEqual(expect.arrayContaining([
      { id: a.id, name: "Alpha", isActive: true, tags: ["clientes"] },
      { id: b.id, name: "Beta", isActive: true, tags: [] },
    ]));
  });
});
