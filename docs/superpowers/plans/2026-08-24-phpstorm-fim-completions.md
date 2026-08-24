# PhpStorm FIM Text Completions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable OpenAI-compatible `POST /v1/completions` endpoint that adapts PhpStorm’s DeepSeek FIM payload into low-latency, non-reasoning code completion through the existing 9Router chat/provider pipeline.

**Architecture:** A thin Next route initializes translators and delegates to a focused completion handler. The handler validates the Text Completion request, parses FIM without loss, gates the verified model, builds an internal non-streaming chat request with `enable_thinking:false`, calls the existing `handleChat`, then maps the normalized chat response to OpenAI Text Completion JSON.

**Tech Stack:** Next.js App Routes, ESM JavaScript, Node `Request`/`Response`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-phpstorm-fim-completions-design.md`

## Global Constraints

- Preserve `/v1/chat/completions` and `/v1/models` behavior.
- Reuse existing `handleChat` authentication, model resolver, account fallback, timeout, rate-limit, logging, and usage paths.
- Initial delivery supports only `stream:false`; `stream:true` returns JSON `400`.
- Initial FIM capability is deny-by-default and certifies only `alims-intl/deepseek-v4-flash-0731`.
- FIM must retain prefix and suffix bytes exactly; never silently downgrade malformed FIM to chat.
- Send `enable_thinking:false` for the certified model; no tools/reasoning fields in the internal request.
- Never add API keys, Authorization headers, cookies, or code prompt bodies to tests, logs, commits, or GitHub.
- Keep the diff minimal; no provider executor or global generic-capability refactor.

---

### Task 1: Add pure completion/FIM helpers and tests

**Files:**
- Create: `src/sse/handlers/completion.js`
- Create: `src/sse/services/completionCapabilities.js`
- Test: `tests/unit/completion-fim.test.js`

**Interfaces:**
- Produces: `parseCompletionPrompt(prompt) -> { prefix, suffix, isFim }`
- Produces: `validateCompletionBody(body) -> { error?: string, maxTokens?, stops? }`
- Produces: `normalizeCompletionResponse(chatResponse, request) -> object`
- Produces: `getCompletionCapability(provider, model) -> { supportsCompletion, supportsFim, disableThinking } | null`

- [ ] **Step 1: Write the failing FIM parser and output-normalizer tests**

```js
import { describe, expect, it } from "vitest";
import { parseCompletionPrompt, normalizeCompletionResponse } from "../../src/sse/handlers/completion.js";

const BEGIN = "<｜fim▁begin｜>";
const HOLE = "<｜fim▁hole｜>";
const END = "<｜fim▁end｜>";

describe("DeepSeek FIM completion", () => {
  it("preserves PhpStorm prefix and suffix exactly", () => {
    const prompt = `${END}\n}${BEGIN}<?php\n\nfunction calculateTotal($items)\n{\n\n    ${HOLE}`;
    expect(parseCompletionPrompt(prompt)).toEqual({
      isFim: true,
      prefix: "<?php\n\nfunction calculateTotal($items)\n{\n\n    ",
      suffix: "\n}",
    });
  });

  it("uses a non-FIM prompt as prefix-only completion", () => {
    expect(parseCompletionPrompt("<?php\nfunction hello() {\n  ")).toEqual({
      isFim: false, prefix: "<?php\nfunction hello() {\n  ", suffix: ""
    });
  });

  it("maps chat output and truncates at the first requested stop", () => {
    const out = normalizeCompletionResponse({
      id: "chatcmpl-1", created: 10, model: "alims-intl/deepseek-v4-flash-0731",
      choices: [{ message: { content: "return 1;\n\nignored" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 6, total_tokens: 8 },
    }, { stop: ["\n\n"] });
    expect(out.object).toBe("text_completion");
    expect(out.choices[0].text).toBe("return 1;");
    expect(out.choices[0].logprobs).toBeNull();
    expect(out.usage.total_tokens).toBe(8);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the module is absent**

Run: `cd tests && npx vitest run unit/completion-fim.test.js`

Expected: FAIL with module-not-found for `src/sse/handlers/completion.js`.

- [ ] **Step 3: Add the minimal capability table**

```js
export const COMPLETION_CAPABILITIES = {
  "alims-intl/deepseek-v4-flash-0731": {
    supportsCompletion: true,
    supportsFim: true,
    disableThinking: "enable_thinking",
  },
};

export function getCompletionCapability(provider, model) {
  return COMPLETION_CAPABILITIES[`${provider}/${model}`] || null;
}
```

- [ ] **Step 4: Add minimal pure helpers**

Implement marker-count/order validation, prefix-only fallback, `stop` normalization, final defensive stop truncation, and conversion from `choices[0].message.content` into a completion response. Do not call providers from these helpers.

- [ ] **Step 5: Run the focused helper tests to verify they pass**

Run: `cd tests && npx vitest run unit/completion-fim.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sse/handlers/completion.js src/sse/services/completionCapabilities.js tests/unit/completion-fim.test.js
git commit -m "feat: add FIM completion helpers"
```

### Task 2: Delegate validated completions through existing chat handling

**Files:**
- Modify: `src/sse/handlers/completion.js`
- Test: `tests/unit/completion-route.test.js`

**Interfaces:**
- Consumes: `handleChat(request, clientRawRequest)` from `src/sse/handlers/chat.js`
- Produces: `handleCompletion(request) -> Promise<Response>`
- Internal request body: `{ model, messages, stream:false, max_tokens, stop?, enable_thinking:false }`

- [ ] **Step 1: Write failing handler-delegation tests**

Mock only `@/sse/handlers/chat.js` and assert that `handleCompletion` builds and delegates this real PhpStorm shape:

```js
const payload = {
  model: "alims-intl/deepseek-v4-flash-0731",
  prompt: "<｜fim▁end｜>\n}<｜fim▁begin｜><?php\n\nfunction calculateTotal($items)\n{\n\n    <｜fim▁hole｜>",
  stream: false,
  max_tokens: 128,
  stop: ["\n\n", "<｜fim▁begin｜>", "<｜fim▁end｜>", "<｜fim▁hole｜>"],
};
```

Assert the delegated body has:

```js
expect(body).toMatchObject({
  model: payload.model,
  stream: false,
  max_tokens: 128,
  stop: payload.stop,
  enable_thinking: false,
});
expect(body.messages).toHaveLength(2);
expect(body.messages[0].role).toBe("system");
expect(body.messages[1].content).toContain("PREFIX");
expect(body.messages[1].content).toContain("SUFFIX");
expect(body.tools).toBeUndefined();
```

Also test: missing model, malformed FIM, unsupported model, invalid `max_tokens`, invalid `stop`, and `stream:true` each return `application/json` with `status:400` and `error.message`.

- [ ] **Step 2: Run the test and verify failure**

Run: `cd tests && npx vitest run unit/completion-route.test.js`

Expected: FAIL because `handleCompletion` has not been exported/implemented.

- [ ] **Step 3: Implement `handleCompletion` minimally**

- Parse JSON exactly once.
- Validate input through Task 1 helpers.
- Resolve `model` with `getModelInfo`.
- Reject combos and any model without verified completion capability.
- Build a cloned internal `Request` preserving original headers and URL, but use `/api/v1/chat/completions` in the request URL so endpoint-aware format detection remains OpenAI chat.
- Use a fixed system instruction and labelled user content. Never interpolate prompt into logs.
- Call `handleChat(internalRequest, { endpoint: "/v1/completions", body: originalBody, headers: originalHeaders })`.
- If delegated chat returns an error, return it unchanged.
- If delegated chat succeeds, normalize it with Task 1 helper.

- [ ] **Step 4: Run targeted tests and verify green**

Run: `cd tests && npx vitest run unit/completion-fim.test.js unit/completion-route.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sse/handlers/completion.js tests/unit/completion-route.test.js
git commit -m "feat: route FIM completions through chat pipeline"
```

### Task 3: Expose `/v1/completions` and verify regressions

**Files:**
- Create: `src/app/api/v1/completions/route.js`
- Test: `tests/unit/completion-route.test.js`
- Verify: `next.config.mjs`

**Interfaces:**
- Produces: `OPTIONS() -> Response` CORS preflight
- Produces: `POST(request) -> handleCompletion(request)`
- Existing rewrite: `/v1/:path*` must reach `/api/v1/:path*`.

- [ ] **Step 1: Write failing route export tests**

```js
import { POST, OPTIONS } from "../../src/app/api/v1/completions/route.js";

it("answers OpenAI completion POST through the route", async () => {
  const response = await POST(new Request("https://router.test/api/v1/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "alims-intl/deepseek-v4-flash-0731", prompt: "x", stream: false, max_tokens: 8 }),
  }));
  expect(response.headers.get("content-type")).toContain("application/json");
});

it("answers CORS preflight", async () => {
  expect((await OPTIONS()).headers.get("Access-Control-Allow-Methods")).toContain("POST");
});
```

- [ ] **Step 2: Run the route test and verify failure**

Run: `cd tests && npx vitest run unit/completion-route.test.js`

Expected: FAIL with missing route module.

- [ ] **Step 3: Add the thin route**

Mirror `src/app/api/v1/chat/completions/route.js`: one-time `initTranslators()`, identical CORS headers, then `return handleCompletion(request)`.

- [ ] **Step 4: Confirm no rewrite change is necessary**

Run: `grep -n "v1/:path" next.config.mjs`

Expected: existing wildcard rewrite covers `/v1/completions`. Do not modify `next.config.mjs` if it does.

- [ ] **Step 5: Run focused feature tests**

Run: `cd tests && npx vitest run unit/completion-fim.test.js unit/completion-route.test.js`

Expected: PASS.

- [ ] **Step 6: Run existing API regression tests and baseline check**

Run:

```bash
cd tests
npx vitest run unit/models.test.js unit/chat-route.test.js
node __baseline__/verify-no-regression.mjs
```

Expected: targeted tests PASS; baseline script reports no new unapproved regression. If the named upstream tests are absent, run the closest existing `models`/`chat` unit test identified with `find tests/unit` and record the exact command.

- [ ] **Step 7: Build production artifact**

Run: `npm run build`

Expected: Next production build succeeds.

- [ ] **Step 8: Commit and push**

```bash
git add src/app/api/v1/completions/route.js tests/unit/completion-route.test.js
git commit -m "feat: expose OpenAI text completions endpoint"
git push origin master
```

### Task 4: Perform safe live validation and prepare deployment

**Files:**
- No production-source change unless a test exposes a defect.
- Verify: `docs/superpowers/specs/2026-08-24-phpstorm-fim-completions-design.md`

**Interfaces:**
- Request: PhpStorm payload from the approved specification.
- Expected: HTTP `200`, `object:"text_completion"`, non-empty `choices[0].text`, no `reasoning_content` field.

- [ ] **Step 1: Package/build from the fork without altering installed 9Router**

Run the project’s documented build/package command and record artifact path/version. Do not overwrite `/usr/local/lib/node_modules/9router` yet.

- [ ] **Step 2: Run a local isolated server or test harness**

Use a temporary data directory and the existing provider configuration only through an explicit local copy; do not print its secrets. Verify `/v1/models`, `/v1/chat/completions`, and `/v1/completions` schema/status.

- [ ] **Step 3: Execute the real PhpStorm FIM payload**

Read the local API key only into process memory. Send the exact approved request. Print only response status, `object`, finish reason, usage counters, and an escaped/truncated text preview; never print Authorization or prompt.

- [ ] **Step 4: Verify direct requirements**

Assert:

```js
assert.equal(status, 200);
assert.equal(body.object, "text_completion");
assert.equal(typeof body.choices?.[0]?.text, "string");
assert.ok(body.choices[0].text.length > 0);
assert.equal(body.choices[0].reasoning_content, undefined);
```

- [ ] **Step 5: Request approval before production deployment**

Report build, test, and live-validation evidence; identify exact service/package changes needed. Do not restart or replace the running 9Router until the user approves deployment.

## Plan Self-Review

- Spec coverage: tasks cover endpoint, FIM preservation, DeepSeek non-thinking control, response contract, stop/max token validation, invalid model/input/stream errors, existing chat/model regression, safe logging, and real PhpStorm validation.
- Placeholder scan: no unresolved placeholders or unspecified code steps.
- Interface consistency: `handleCompletion` owns completion validation/delegation; `handleChat` retains all existing provider/auth behavior; the route remains a thin adapter.
