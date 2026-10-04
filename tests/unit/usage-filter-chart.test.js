import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

let db;
let repo;
let a;
let b;
const sum = (buckets, field) => buckets.reduce((n, x) => n + (x[field] || 0), 0);

async function chartWith(filter, period) {
  await repo.setUsageFilter(filter);
  return db.getChartData(period, await repo.getResolvedUsageFilter());
}

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-chart-"));
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  a = await db.createApiKey("Alpha", "machine-test");
  b = await db.createApiKey("Beta", "machine-test");
  const save = (apiKey, p, c) => db.saveRequestUsage({ provider: "openai", model: "gpt", apiKey, tokens: { prompt_tokens: p, completion_tokens: c }, status: "ok" });
  await save(a.key, 10, 5);
  await save(b.key, 20, 10);
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("getChartData with a usage filter", () => {
  const onlyA = () => ({ apiKeys: { mode: "selected", ids: [a.id] } });

  it.each(["today", "24h", "7d", "30d", "all"])("only counts the selected key (%s)", async (period) => {
    const buckets = await chartWith(onlyA(), period);
    expect(sum(buckets, "tokens")).toBe(15);
    expect(sum(buckets, "requests")).toBe(1);
  });

  it("keeps the bucket layout of the unfiltered chart", async () => {
    expect(await chartWith(onlyA(), "7d")).toHaveLength(7);
    expect(await chartWith(onlyA(), "today")).toHaveLength(24);
  });

  it("empty selection returns zero buckets, and [] for all", async () => {
    const none = { apiKeys: { mode: "selected", ids: [] } };
    const week = await chartWith(none, "7d");
    expect(week).toHaveLength(7);
    expect(sum(week, "tokens")).toBe(0);
    expect(await chartWith(none, "all")).toEqual([]);
  });

  it("unfiltered chart is unchanged", async () => {
    expect(sum(await db.getChartData("7d"), "tokens")).toBe(45);
  });

  it("ignores metadata requests unless asked", async () => {
    await db.saveRequestUsage({ provider: "9router", model: "unknown", endpoint: "/v1/models", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "meta" });
    expect(sum(await db.getChartData("today"), "requests")).toBe(2);
    expect(sum(await db.getChartData("7d"), "requests")).toBe(2);
    expect(sum(await chartWith({ requestKind: "meta" }, "today"), "requests")).toBe(1);
    expect(sum(await chartWith({ requestKind: "all" }, "7d"), "requests")).toBe(3);
  });
});
