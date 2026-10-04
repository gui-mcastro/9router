import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyRequestKind } from "../../src/lib/requestKind.js";

// Cold imports of the DB layer are slow on small hosts; give them room.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe("test isolation", () => {
  it("tests never see the real home directory", () => {
    expect(os.homedir()).toContain("9router-test-home-");
  });
});

describe("classifyRequestKind", () => {
  it.each([
    ["GET", "/v1", "meta"],
    ["GET", "/v1/models", "meta"],
    ["GET", "/api/v1/models/openai/gpt-4o", "meta"],
    ["GET", "/v1/models/info", "meta"],
    ["GET", "/v1/audio/voices", "meta"],
    ["POST", "/v1/messages/count_tokens", "meta"],
    ["GET", "/v1beta/models", "meta"],
    ["GET", "/api/v1/videos/abc123", "meta"],
    ["POST", "/v1/chat/completions", "work"],
    ["POST", "/api/v1/responses", "work"],
    ["POST", "/codex/responses", "work"],
    ["POST", "/v1beta/models/gemini-2.5-flash:generateContent", "work"],
    ["POST", "/v1/videos/generations", "work"],
    ["POST", "/v1/audio/speech", "work"],
    ["POST", "/v1/messages", "work"],
  ])("%s %s → %s", (method, pathname, kind) => {
    expect(classifyRequestKind(method, pathname)).toBe(kind);
  });
});

describe("withRequestUsage", () => {
  let requestUsage;
  let adapter;

  beforeEach(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-request-usage-"));
    delete global._dbAdapter;
    vi.resetModules();
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    requestUsage = await import("@/lib/requestUsage.js");
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
    delete global._dbAdapter;
    delete process.env.DATA_DIR;
  });

  const rows = () => adapter.all(
    `SELECT provider, model, connectionId, apiKey, endpoint, status, httpStatus, kind, promptTokens FROM usageHistory ORDER BY id`
  );
  const req = (method, url, headers = {}) => new Request(`http://localhost${url}`, { method, headers });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("records one ok work row with what the handler resolved", async () => {
    const handler = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().set({ provider: "openai", model: "gpt-x", connectionId: "c1" });
      return new Response("ok");
    });
    const res = await handler(req("POST", "/v1/audio/speech", { authorization: "Bearer sk-client" }));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({
      provider: "openai", model: "gpt-x", connectionId: "c1", apiKey: "sk-client",
      endpoint: "/v1/audio/speech", status: "ok", httpStatus: 200, kind: "work", promptTokens: 0,
    });
  });

  it("records errors with the final status code", async () => {
    const handler = requestUsage.withRequestUsage(async () => Response.json({ error: "x" }, { status: 404 }));
    await handler(req("POST", "/v1/images/generations"));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ provider: "unknown", model: "unknown", status: "error", httpStatus: 404, apiKey: null });
  });

  it("records thrown errors as 500 and rethrows", async () => {
    const handler = requestUsage.withRequestUsage(async () => { throw new Error("boom"); });
    await expect(handler(req("POST", "/v1/search"))).rejects.toThrow("boom");
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ status: "error", httpStatus: 500 });
  });

  it("skips successful requests handed off to downstream recording", async () => {
    const ok = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().handOff();
      return new Response("stream");
    });
    const failed = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().handOff();
      return new Response("x", { status: 503 });
    });
    await ok(req("POST", "/v1/chat/completions"));
    await failed(req("POST", "/v1/chat/completions"));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: "error", httpStatus: 503 });
  });

  it("stores exact tokens set by the handler", async () => {
    const handler = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().set({ provider: "openai", model: "emb", tokens: { prompt_tokens: 12, completion_tokens: 0 } });
      return new Response("ok");
    });
    await handler(req("POST", "/v1/embeddings"));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].promptTokens).toBe(12);
  });

  it("records metadata requests outside the daily rollup", async () => {
    const handler = requestUsage.withRequestUsage(async () => Response.json({ data: [] }));
    await handler(req("GET", "/v1/models", { "x-api-key": "sk-meta" }));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ kind: "meta", provider: "9router", status: "ok", apiKey: "sk-meta" });
    expect(adapter.all(`SELECT dateKey FROM usageDaily`)).toEqual([]);
  });

  it("records requests rejected before routing", async () => {
    requestUsage.recordRejectedRequest(req("POST", "/v1/chat/completions?key=sk-bad"), 401);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ status: "error", httpStatus: 401, apiKey: "sk-bad", kind: "work", endpoint: "/v1/chat/completions" });
  });

  it("returns null outside a wrapped request", () => {
    expect(requestUsage.currentRequestUsage()).toBeNull();
  });
});

describe("extractRequestApiKey", () => {
  it.each([
    [{ authorization: "Bearer sk-a" }, "", "sk-a"],
    [{ "x-api-key": "sk-b" }, "", "sk-b"],
    [{ "x-goog-api-key": "sk-c" }, "", "sk-c"],
    [{}, "?key=sk-d", "sk-d"],
    [{}, "", null],
  ])("%j %s", async (headers, query, expected) => {
    const { extractRequestApiKey } = await import("../../src/lib/requestUsage.js");
    expect(extractRequestApiKey(new Request(`http://localhost/v1/chat/completions${query}`, { headers }))).toBe(expected);
  });

  it("truncates absurdly long keys", async () => {
    const { extractRequestApiKey } = await import("../../src/lib/requestUsage.js");
    const request = new Request("http://localhost/v1", { headers: { authorization: `Bearer ${"x".repeat(1000)}` } });
    expect(extractRequestApiKey(request)).toHaveLength(256);
  });
});
