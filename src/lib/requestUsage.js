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

// Attacker-controlled paths must not bloat history rows.
const MAX_ENDPOINT_LENGTH = 128;

// Recording must never break a request: an unparseable request gets a record that writes nothing.
const NOOP_RECORD = Object.freeze({
  noop: true,
  fields: Object.freeze({}),
  set() {},
  handOff() {},
  handedOff: false,
});

function createRecord(request, { kind } = {}) {
  try {
    return buildRecord(request, kind);
  } catch {
    return NOOP_RECORD;
  }
}

function buildRecord(request, kindOverride) {
  const url = new URL(request.url);
  const fields = {};
  let handedOff = false;
  return {
    kind: kindOverride || classifyRequestKind(request.method, url.pathname),
    endpoint: url.pathname.slice(0, MAX_ENDPOINT_LENGTH),
    apiKey: extractRequestApiKey(request),
    fields,
    set(values = {}) {
      for (const name of RECORDED_FIELDS) {
        // undefined leaves the field alone; an explicit null clears it (a combo moving to the next model resets the account).
        if (values[name] !== undefined) fields[name] = values[name];
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
  if (record.noop) return;
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
      // Wrapper rows are one per request by construction; never collapse them with a same-millisecond twin.
      dedupe: false,
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

// Requests refused before any route runs (dashboard guard 401). A refused request did no work, so it is
// recorded as non-work (history only: no daily rollup, no lifetime counter, hidden from the default view).
// CORS preflights are never recorded. Must never throw into the guard.
export function recordRejectedRequest(request, httpStatus) {
  try {
    if (request.method === "OPTIONS") return;
    recordOutcome(createRecord(request, { kind: "meta" }), httpStatus);
  } catch {
    // Recording is best-effort; the 401 still goes out.
  }
}
