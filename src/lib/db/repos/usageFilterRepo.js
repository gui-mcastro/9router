import { getAdapter } from "../driver.js";
import { getSettings, updateSettings } from "./settingsRepo.js";
import { getApiKeys } from "./apiKeysRepo.js";
import { DEFAULT_USAGE_FILTER, normalizeUsageFilter, resolveUsageFilter } from "../../usageFilter.js";

export async function getUsageFilter() {
  const settings = await getSettings();
  try {
    return normalizeUsageFilter(settings.usageFilter ?? DEFAULT_USAGE_FILTER);
  } catch {
    // Corrupt or legacy value: behave as "show everything" rather than failing the dashboard.
    return normalizeUsageFilter(DEFAULT_USAGE_FILTER);
  }
}

export async function setUsageFilter(value) {
  const filter = normalizeUsageFilter(value);
  await updateSettings({ usageFilter: filter });
  return filter;
}

export async function getResolvedUsageFilter() {
  const [filter, catalog] = await Promise.all([getUsageFilter(), getApiKeys()]);
  return resolveUsageFilter(filter, catalog);
}

// Options do not depend on the active filter, so de-selected items stay listed.
export async function getUsageFilterOptions() {
  const db = await getAdapter();
  const ids = new Set();
  for (const r of db.all(`SELECT DISTINCT LOWER(provider) AS p FROM usageHistory WHERE provider IS NOT NULL AND provider <> ''`)) {
    ids.add(r.p);
  }

  const [{ getProviderConnections }, { getProviderNodes }, { AI_PROVIDERS }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./nodesRepo.js"),
    import("@/shared/constants/providers"),
  ]);
  try {
    for (const c of await getProviderConnections()) {
      if (c.isActive !== false && c.provider) ids.add(String(c.provider).toLowerCase());
    }
  } catch {}
  const nodeNames = {};
  try {
    for (const n of await getProviderNodes()) {
      if (n.id && n.name) nodeNames[String(n.id).toLowerCase()] = n.name;
    }
  } catch {}

  const providers = [...ids].sort().map((id) => ({ id, label: nodeNames[id] || AI_PROVIDERS[id]?.name || id }));
  const apiKeys = (await getApiKeys()).map(({ id, name, isActive, tags }) => ({ id, name, isActive, tags: tags || [] }));
  const tags = [...new Set(apiKeys.flatMap((k) => k.tags))].sort();
  return { providers, apiKeys, tags };
}
