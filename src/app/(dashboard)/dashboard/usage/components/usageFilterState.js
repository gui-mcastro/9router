import { KEY_NONE, KEY_UNKNOWN } from "@/lib/usageFilter";

export function apiKeyOptionIds(options) {
  return [...(options?.apiKeys || []).map((k) => k.id), KEY_NONE, KEY_UNKNOWN];
}

function toggleIn(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return [...set];
}

// In "all" mode every option is implicitly checked, so unchecking one keeps the rest.
export function toggleProvider(filter, id, allIds) {
  const current = new Set(filter.providers.mode === "all" ? allIds : filter.providers.ids);
  return { ...filter, providers: { mode: "selected", ids: toggleIn(current, id) } };
}

export function toggleApiKey(filter, id, allIds) {
  const s = filter.apiKeys;
  const current = new Set(s.mode === "all" ? allIds : s.ids);
  return { ...filter, apiKeys: { mode: "selected", ids: toggleIn(current, id), tags: s.mode === "all" ? [] : s.tags } };
}

// Tags are unchecked in "all" mode, so checking one narrows to that tag.
export function toggleTag(filter, tag) {
  const s = filter.apiKeys;
  const tags = new Set(s.mode === "all" ? [] : s.tags);
  return { ...filter, apiKeys: { mode: "selected", ids: s.mode === "all" ? [] : s.ids, tags: toggleIn(tags, tag) } };
}

export function selectAllSection(filter, section) {
  return { ...filter, [section]: section === "apiKeys" ? { mode: "all", ids: [], tags: [] } : { mode: "all", ids: [] } };
}

export function clearSection(filter, section) {
  return { ...filter, [section]: section === "apiKeys" ? { mode: "selected", ids: [], tags: [] } : { mode: "selected", ids: [] } };
}

export function onlyApiKey(filter, id) {
  return { ...filter, apiKeys: { mode: "selected", ids: [id], tags: [] } };
}

export function onlyTag(filter, tag) {
  return { ...filter, apiKeys: { mode: "selected", ids: [], tags: [tag] } };
}

export function setRequestKind(filter, requestKind) {
  return { ...filter, requestKind };
}

export function summarizeProviders(filter, options) {
  const s = filter.providers;
  if (s.mode === "all") return "All";
  if (!s.ids.length) return "None";
  if (s.ids.length === 1) return options.providers.find((p) => p.id === s.ids[0])?.label || s.ids[0];
  return `${s.ids.length} selected`;
}

function keyLabel(id, options) {
  if (id === KEY_NONE) return "No API key";
  if (id === KEY_UNKNOWN) return "Unknown keys";
  return options.apiKeys.find((k) => k.id === id)?.name || "Deleted key";
}

export function summarizeApiKeys(filter, options) {
  const s = filter.apiKeys;
  if (s.mode === "all") return "All";
  if (s.ids.length === 1 && !s.tags.length) return keyLabel(s.ids[0], options);
  const parts = [];
  if (s.ids.length) parts.push(`${s.ids.length} key${s.ids.length > 1 ? "s" : ""}`);
  if (s.tags.length) parts.push(s.tags.map((t) => `#${t}`).join(" "));
  return parts.length ? parts.join(" + ") : "None";
}
