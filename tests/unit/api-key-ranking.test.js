import { describe, it, expect } from "vitest";
import { buildApiKeyRanking, UNTAGGED } from "../../src/app/(dashboard)/dashboard/usage/components/apiKeyRanking.js";

const rec = (apiKeyId, keyName, promptTokens, completionTokens, cost, requests) =>
  ({ apiKeyId, keyName, promptTokens, completionTokens, cachedTokens: 0, cost, requests });

const byApiKey = {
  "a|gpt|openai": rec("a", "Alpha", 100, 50, 1, 2),
  "a|claude|anthropic": rec("a", "Alpha", 50, 0, 2, 1),
  "b|gpt|openai": rec("b", "Beta", 10, 0, 5, 10),
  "__none__": rec("__none__", "Local (No API Key)", 0, 0, 0, 0),
};
const catalog = [
  { id: "a", name: "Alpha", isActive: true, tags: ["clientes", "time-x"] },
  { id: "b", name: "Beta", isActive: true, tags: [] },
];

describe("buildApiKeyRanking", () => {
  it("sums every model of a key and sorts by tokens", () => {
    const rows = buildApiKeyRanking(byApiKey, catalog, { groupBy: "key", metric: "tokens" });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ label: "Alpha", totalTokens: 200, value: 200, requests: 3, cost: 3, tags: ["clientes", "time-x"] });
    expect(rows[0].share).toBeCloseTo(200 / 210);
  });

  it("ranks by cost and requests", () => {
    expect(buildApiKeyRanking(byApiKey, catalog, { metric: "cost" }).map((r) => r.id)).toEqual(["b", "a"]);
    expect(buildApiKeyRanking(byApiKey, catalog, { metric: "requests" }).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("groups by tag, counting multi-tag keys in each tag", () => {
    const rows = buildApiKeyRanking(byApiKey, catalog, { groupBy: "tag", metric: "tokens" });
    expect(rows.map((r) => r.id)).toEqual(["clientes", "time-x", UNTAGGED]);
    expect(rows[0]).toMatchObject({ value: 200, keyCount: 1 });
    expect(rows[2]).toMatchObject({ label: "(untagged)", value: 10, keyCount: 1 });
  });

  it("returns [] for no usage", () => {
    expect(buildApiKeyRanking({}, catalog)).toEqual([]);
    expect(buildApiKeyRanking(undefined, undefined)).toEqual([]);
  });
});
