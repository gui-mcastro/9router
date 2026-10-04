// Tags let users group gateway API keys (e.g. "clientes", "pessoal") for usage
// filtering and ranking. Client-safe: no node imports.

export const MAX_TAGS_PER_KEY = 10;
export const MAX_TAG_LENGTH = 32;

export function normalizeApiKeyTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("tags must be an array");
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new TypeError("tags must be strings");
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new TypeError(`tag too long (max ${MAX_TAG_LENGTH}): ${tag}`);
    if (/[,|]/.test(tag)) throw new TypeError("tags cannot contain ',' or '|'");
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS_PER_KEY) throw new TypeError(`too many tags (max ${MAX_TAGS_PER_KEY})`);
  return out;
}

export function parseTagInput(text) {
  return normalizeApiKeyTags(String(text || "").split(","));
}

export function parseStoredTags(text) {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function serializeTags(value) {
  try {
    return JSON.stringify(normalizeApiKeyTags(value));
  } catch {
    return "[]";
  }
}
