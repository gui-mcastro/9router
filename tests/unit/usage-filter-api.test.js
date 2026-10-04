import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let db;
let repo;
let route;

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-filter-"));
  // The adapter lives on a global that survives vi.resetModules(); drop it so each test gets its own DB.
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  route = await import("@/app/api/usage/filter/route.js");
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  delete process.env.DATA_DIR;
});

const put = (body) => route.PUT(new Request("http://localhost/api/usage/filter", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

describe("usage filter persistence", () => {
  it("defaults to all/all on a fresh install", async () => {
    expect(await repo.getUsageFilter()).toEqual({
      providers: { mode: "all", ids: [] },
      apiKeys: { mode: "all", ids: [], tags: [] },
      requestKind: "work",
    });
    expect((await repo.getResolvedUsageFilter()).active).toBe(false);
  });

  it("falls back to all when the stored filter is corrupt", async () => {
    await db.updateSettings({ usageFilter: { providers: "garbage" }, usageProviderFilter: { mode: "selected", providerIds: ["x"] } });
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).filter.providers.mode).toBe("all");
  });

  it("PUT normalizes, stores and returns the filter", async () => {
    const res = await put({ providers: { mode: "selected", ids: [" OpenAI "] }, apiKeys: { mode: "all" } });
    expect(res.status).toBe(200);
    expect((await res.json()).filter.providers).toEqual({ mode: "selected", ids: ["openai"] });
    expect((await repo.getUsageFilter()).providers.ids).toEqual(["openai"]);
  });

  it("PUT rejects invalid input without writing", async () => {
    expect((await put({ providers: { mode: "selected", ids: [42] } })).status).toBe(400);
    expect((await put("{not json")).status).toBe(400);
    expect((await repo.getUsageFilter()).providers.mode).toBe("all");
  });

  it("GET returns options without raw keys", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    await db.updateApiKey(key.id, { tags: ["clientes"] });
    await db.saveRequestUsage({ provider: "OpenAI", model: "gpt", apiKey: key.key, tokens: { prompt_tokens: 1, completion_tokens: 1 }, status: "ok" });

    const res = await route.GET();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(key.key);
    expect(body.options.apiKeys).toEqual([{ id: key.id, name: "Alpha", isActive: true, tags: ["clientes"] }]);
    expect(body.options.tags).toEqual(["clientes"]);
    expect(body.options.providers.map((p) => p.id)).toContain("openai");
  });
});
