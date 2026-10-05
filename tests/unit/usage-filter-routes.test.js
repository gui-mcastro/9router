import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

let db;
let repo;
let a;
let b;

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-routes-"));
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  a = await db.createApiKey("Alpha", "machine-test");
  b = await db.createApiKey("Beta", "machine-test");
  await db.saveRequestUsage({ provider: "openai", model: "route-model-a", apiKey: a.key, tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: "ok" });
  await db.saveRequestUsage({ provider: "openai", model: "route-model-b", apiKey: b.key, tokens: { prompt_tokens: 20, completion_tokens: 10 }, status: "ok" });
  await repo.setUsageFilter({ apiKeys: { mode: "selected", ids: [a.id] } });
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("usage routes apply the saved filter", () => {
  it("GET /api/usage/stats", async () => {
    const { GET } = await import("@/app/api/usage/stats/route.js");
    const body = await (await GET(new Request("http://localhost/api/usage/stats?period=today"))).json();
    expect(body.filterActive).toBe(true);
    expect(body.totalPromptTokens).toBe(10);
  });

  it("GET /api/usage/chart", async () => {
    const { GET } = await import("@/app/api/usage/chart/route.js");
    const buckets = await (await GET(new Request("http://localhost/api/usage/chart?period=7d"))).json();
    expect(buckets.reduce((n, x) => n + x.tokens, 0)).toBe(15);
  });

  it("getActiveRequests filters recent requests from the in-memory ring", async () => {
    const resolved = await repo.getResolvedUsageFilter();
    const { recentRequests } = await db.getActiveRequests(resolved);
    const models = recentRequests.map((r) => r.model);
    expect(models).toContain("route-model-a");
    expect(models).not.toContain("route-model-b");
  });

  it("ring hides metadata by default and shows zero-token work rows", async () => {
    await db.saveRequestUsage({ provider: "9router", model: "ring-meta", endpoint: "/v1/models", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "meta" });
    await db.saveRequestUsage({ provider: "edge-tts", model: "ring-voice", endpoint: "/v1/audio/speech", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "work" });
    const models = (await db.getActiveRequests()).recentRequests.map((r) => r.model);
    expect(models).toContain("ring-voice");
    expect(models).not.toContain("ring-meta");
  });

  it("getActiveRequests carries the in-flight pending map", async () => {
    db.trackPendingRequest("pending-model", "openai", "conn-pending", true);
    try {
      const { pending } = await db.getActiveRequests();
      expect(pending.byModel["pending-model (openai)"]).toBe(1);
      expect(pending.byAccount["conn-pending"]["pending-model (openai)"]).toBe(1);
    } finally {
      db.trackPendingRequest("pending-model", "openai", "conn-pending", false);
    }
  });

  it("GET /api/usage/stream pushes only realtime fields, never the full stats", async () => {
    const { GET } = await import("@/app/api/usage/stream/route.js");
    const res = await GET();
    const reader = res.body.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text.startsWith("data: ")).toBe(true);
      const payload = JSON.parse(text.slice(6).trim());
      expect(payload).toHaveProperty("activeRequests");
      expect(payload).toHaveProperty("recentRequests");
      expect(payload).toHaveProperty("pending");
      expect(payload).toHaveProperty("errorProvider");
      expect(payload).not.toHaveProperty("byModel");
      expect(payload).not.toHaveProperty("totalRequests");
      expect(payload.recentRequests.map((r) => r.model)).toEqual(["route-model-a"]);
    } finally {
      await reader.cancel();
    }
  });
});
