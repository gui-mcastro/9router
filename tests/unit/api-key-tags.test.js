import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeApiKeyTags, parseStoredTags, parseTagInput, serializeTags,
} from "../../src/lib/apiKeyTags.js";

describe("api key tag helpers", () => {
  it("normalizes case, whitespace and duplicates", () => {
    expect(normalizeApiKeyTags([" Clientes ", "clientes", "Time A"])).toEqual(["clientes", "time-a"]);
    expect(normalizeApiKeyTags(undefined)).toEqual([]);
    expect(normalizeApiKeyTags(null)).toEqual([]);
    expect(normalizeApiKeyTags(["", "   "])).toEqual([]);
  });

  it.each([
    ["not-an-array"],
    [[1]],
    [["a,b"]],
    [["a|b"]],
    [["x".repeat(33)]],
    [Array.from({ length: 11 }, (_, i) => `t${i}`)],
  ])("rejects invalid tags %#", (value) => {
    expect(() => normalizeApiKeyTags(value)).toThrow(TypeError);
  });

  it("parses comma separated input", () => {
    expect(parseTagInput("a, B ,,c")).toEqual(["a", "b", "c"]);
    expect(parseTagInput("")).toEqual([]);
  });

  it("tolerates garbage in stored tags", () => {
    expect(parseStoredTags(null)).toEqual([]);
    expect(parseStoredTags("not json")).toEqual([]);
    expect(parseStoredTags('{"a":1}')).toEqual([]);
    expect(parseStoredTags('["a",2]')).toEqual(["a"]);
  });

  it("serializes safely", () => {
    expect(serializeTags(["B"])).toBe('["b"]');
    expect(serializeTags("garbage")).toBe("[]");
  });
});

describe("api key tags persistence", () => {
  let tempDir;
  let db;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-tags-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  it("new keys start without tags and tags round-trip", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    expect(key.tags).toEqual([]);
    await db.updateApiKey(key.id, { tags: ["Clientes"] });
    expect((await db.getApiKeyById(key.id)).tags).toEqual(["clientes"]);
    expect((await db.getApiKeys())[0].tags).toEqual(["clientes"]);
  });

  it("updating isActive keeps tags", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    await db.updateApiKey(key.id, { tags: ["clientes"] });
    await db.updateApiKey(key.id, { isActive: false });
    const stored = await db.getApiKeyById(key.id);
    expect(stored.isActive).toBe(false);
    expect(stored.tags).toEqual(["clientes"]);
  });

  it("PUT /api/keys/:id validates and saves tags", async () => {
    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const key = await db.createApiKey("Alpha", "machine-test");
    const put = (body) => PUT(
      new Request(`http://localhost/api/keys/${key.id}`, { method: "PUT", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: key.id }) },
    );

    const ok = await put({ tags: ["Time A"] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).key.tags).toEqual(["time-a"]);

    const bad = await put({ tags: "nope" });
    expect(bad.status).toBe(400);
    expect((await db.getApiKeyById(key.id)).tags).toEqual(["time-a"]);
  });

  it("export/import preserves tags", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    await db.updateApiKey(key.id, { tags: ["clientes"] });
    const dump = await db.exportDb();
    expect(dump.apiKeys[0].tags).toEqual(["clientes"]);
    await db.importDb(dump);
    expect((await db.getApiKeyById(key.id)).tags).toEqual(["clientes"]);
  });
});
