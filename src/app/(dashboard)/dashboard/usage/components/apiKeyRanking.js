import { KEY_NONE } from "@/lib/usageFilter";

export const UNTAGGED = "__untagged__";

const SUM_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];
const METRICS = {
  tokens: (r) => r.promptTokens + r.completionTokens,
  cost: (r) => r.cost,
  requests: (r) => r.requests,
};

function emptyRow(id, label, tags) {
  return { id, label, tags, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
}

function addInto(target, source) {
  for (const f of SUM_FIELDS) target[f] += source[f] || 0;
}

// byApiKey: redacted stats map ("<apiKeyId>|model|provider" → totals). catalog: stats.apiKeyCatalog.
export function buildApiKeyRanking(byApiKey = {}, catalog = [], { groupBy = "key", metric = "tokens" } = {}) {
  const byId = new Map((catalog || []).map((k) => [k.id, k]));
  const perKey = new Map();
  for (const rec of Object.values(byApiKey || {})) {
    const id = rec.apiKeyId || KEY_NONE;
    if (!perKey.has(id)) perKey.set(id, emptyRow(id, byId.get(id)?.name || rec.keyName || id, byId.get(id)?.tags || []));
    addInto(perKey.get(id), rec);
  }

  const value = METRICS[metric] || METRICS.tokens;
  // Keys without usage for this metric would inflate tag key counts; drop them first.
  const keyRows = [...perKey.values()].filter((r) => value(r) > 0);
  const total = keyRows.reduce((sum, r) => sum + value(r), 0);

  let rows = keyRows;
  if (groupBy === "tag") {
    const groups = new Map();
    for (const r of keyRows) {
      for (const tag of r.tags.length ? r.tags : [UNTAGGED]) {
        if (!groups.has(tag)) groups.set(tag, { ...emptyRow(tag, tag === UNTAGGED ? "(untagged)" : tag, []), keyCount: 0 });
        const g = groups.get(tag);
        g.keyCount += 1;
        addInto(g, r);
      }
    }
    rows = [...groups.values()];
  }

  return rows
    .map((r) => ({ ...r, totalTokens: r.promptTokens + r.completionTokens, value: value(r), share: total > 0 ? value(r) / total : 0 }))
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label));
}
