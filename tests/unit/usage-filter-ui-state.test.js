import { describe, it, expect } from "vitest";
import { DEFAULT_USAGE_FILTER, KEY_NONE, KEY_UNKNOWN } from "../../src/lib/usageFilter.js";
import {
  apiKeyOptionIds, toggleProvider, toggleApiKey, toggleTag, selectAllSection, clearSection,
  onlyApiKey, onlyTag, setRequestKind, summarizeProviders, summarizeApiKeys,
} from "../../src/app/(dashboard)/dashboard/usage/components/usageFilterState.js";

const options = {
  providers: [{ id: "openai", label: "OpenAI" }, { id: "edge-tts", label: "Edge TTS" }],
  apiKeys: [{ id: "a", name: "Alpha", isActive: true, tags: ["clientes"] }, { id: "b", name: "Beta", isActive: true, tags: [] }],
  tags: ["clientes"],
};

describe("usage filter UI transitions", () => {
  it("lists special key options after real keys", () => {
    expect(apiKeyOptionIds(options)).toEqual(["a", "b", KEY_NONE, KEY_UNKNOWN]);
  });

  it("unchecking in all mode keeps everything else", () => {
    const f = toggleProvider(DEFAULT_USAGE_FILTER, "openai", ["openai", "edge-tts"]);
    expect(f.providers).toEqual({ mode: "selected", ids: ["edge-tts"] });
    const k = toggleApiKey(DEFAULT_USAGE_FILTER, "a", apiKeyOptionIds(options));
    expect(k.apiKeys).toEqual({ mode: "selected", ids: ["b", KEY_NONE, KEY_UNKNOWN], tags: [] });
  });

  it("toggling twice restores membership", () => {
    const once = toggleApiKey(onlyApiKey(DEFAULT_USAGE_FILTER, "a"), "b", apiKeyOptionIds(options));
    expect(once.apiKeys.ids).toEqual(["a", "b"]);
    expect(toggleApiKey(once, "b", apiKeyOptionIds(options)).apiKeys.ids).toEqual(["a"]);
  });

  it("checking a tag in all mode narrows to that tag", () => {
    expect(toggleTag(DEFAULT_USAGE_FILTER, "clientes").apiKeys).toEqual({ mode: "selected", ids: [], tags: ["clientes"] });
    expect(onlyTag(DEFAULT_USAGE_FILTER, "clientes").apiKeys).toEqual({ mode: "selected", ids: [], tags: ["clientes"] });
  });

  it("switches request kind and keeps it across other changes", () => {
    const meta = setRequestKind(DEFAULT_USAGE_FILTER, "meta");
    expect(meta.requestKind).toBe("meta");
    expect(onlyApiKey(meta, "a").requestKind).toBe("meta");
    expect(selectAllSection(meta, "providers").requestKind).toBe("meta");
  });

  it("select all and clear", () => {
    const narrowed = onlyApiKey(DEFAULT_USAGE_FILTER, "a");
    expect(selectAllSection(narrowed, "apiKeys").apiKeys).toEqual({ mode: "all", ids: [], tags: [] });
    expect(clearSection(narrowed, "providers").providers).toEqual({ mode: "selected", ids: [] });
    expect(clearSection(narrowed, "apiKeys").apiKeys).toEqual({ mode: "selected", ids: [], tags: [] });
  });

  it("summaries", () => {
    expect(summarizeProviders(DEFAULT_USAGE_FILTER, options)).toBe("All");
    expect(summarizeProviders({ ...DEFAULT_USAGE_FILTER, providers: { mode: "selected", ids: ["openai"] } }, options)).toBe("OpenAI");
    expect(summarizeProviders(clearSection(DEFAULT_USAGE_FILTER, "providers"), options)).toBe("None");
    expect(summarizeApiKeys(onlyApiKey(DEFAULT_USAGE_FILTER, "a"), options)).toBe("Alpha");
    expect(summarizeApiKeys(onlyApiKey(DEFAULT_USAGE_FILTER, KEY_NONE), options)).toBe("No API key");
    expect(summarizeApiKeys(onlyApiKey(DEFAULT_USAGE_FILTER, "gone"), options)).toBe("Deleted key");
    expect(summarizeApiKeys(onlyTag(DEFAULT_USAGE_FILTER, "clientes"), options)).toBe("#clientes");
    expect(summarizeApiKeys({ ...DEFAULT_USAGE_FILTER, apiKeys: { mode: "selected", ids: ["a", "b"], tags: ["x"] } }, options)).toBe("2 keys + #x");
  });
});
