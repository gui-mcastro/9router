import { AsyncLocalStorage } from "node:async_hooks";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { classifyRequestKind } from "./requestKind.js";

const MAX_KEY_LENGTH = 256;
const RECORDED_FIELDS = ["provider", "model", "connectionId", "tokens"];
// One store per process even if Next bundles this module into several chunks.
const storage = (globalThis.__requestUsageStorage ||= new AsyncLocalStorage());

function queryKey(url) {
  try {
    return new URL(url).searchParams.get("key");
  } catch {
    return null;
  }
}

// Same sources the dashboard guard accepts; truncated because rejected requests store whatever was sent.
export function extractRequestApiKey(request) {
  const headers = request.headers;
  const auth = headers.get("authorization");
  const key = auth?.startsWith("Bearer ")
    ? auth.slice(7)
    : headers.get("x-api-key") || headers.get("x-goog-api-key") || queryKey(request.url);
  return key ? key.slice(0, MAX_KEY_LENGTH) : null;
}

function createRecord(request) {
  const url = new URL(request.url);
  const fields = {};
  let handedOff = false;
  return {
    kind: classifyRequestKind(request.method, url.pathname),
    endpoint: url.pathname,
    apiKey: extractRequestApiKey(request),
    fields,
    set(values = {}) {
      for (const name of RECORDED_FIELDS) {
        if (values[name] != null) fields[name] = values[name];
      }
    },
    // Success will be written downstream (chatCore saves the row with tokens when the response completes).
    handOff() {
      handedOff = true;
    },
    get handedOff() {
      return handedOff;
    },
  };
}

function recordOutcome(record, httpStatus) {
  const ok = httpStatus < 400;
  if (ok && record.handedOff) return;
  const f = record.fields;
  Promise.resolve()
    .then(() => saveRequestUsage({
      provider: f.provider || (record.kind === "meta" ? "9router" : "unknown"),
      model: f.model || "unknown",
      connectionId: f.connectionId || null,
      apiKey: record.apiKey,
      endpoint: record.endpoint,
      tokens: f.tokens || { prompt_tokens: 0, completion_tokens: 0 },
      status: ok ? "ok" : "error",
      httpStatus,
      kind: record.kind,
    }))
    .catch(() => {});
}

export function currentRequestUsage() {
  return storage.getStore() || null;
}

// Wrap a /v1 route handler so every request leaves exactly one usageHistory row.
export function withRequestUsage(handler) {
  return async function usageRecordedHandler(request, ...rest) {
    const record = createRecord(request);
    return storage.run(record, async () => {
      let response;
      try {
        response = await handler(request, ...rest);
      } catch (error) {
        recordOutcome(record, 500);
        throw error;
      }
      recordOutcome(record, response?.status ?? 200);
      return response;
    });
  };
}

// Requests refused before any route runs (dashboard guard 401).
export function recordRejectedRequest(request, httpStatus) {
  recordOutcome(createRecord(request), httpStatus);
}
