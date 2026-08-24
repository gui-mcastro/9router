# PhpStorm FIM Text Completions Design

## Goal

Add `POST /v1/completions` so PhpStorm 2026.2.1 can use OpenAI-compatible inline completion with `(fim) DeepSeek`, while preserving `/v1/chat/completions` and `/v1/models` behavior.

## Scope

- Implement OpenAI Text Completion compatibility for `stream: false`.
- Support the DeepSeek FIM delimiters emitted by PhpStorm:
  - `<｜fim▁begin｜>`
  - `<｜fim▁hole｜>`
  - `<｜fim▁end｜>`
- Route through the existing authentication, model resolution, account fallback, timeout, provider execution, usage tracking, and request-log flow.
- Initially certify only `alims-intl/deepseek-v4-flash-0731` for FIM completion.
- Add focused automated tests and reproducible authenticated integration checks.

Out of scope:

- PhpStorm configuration changes.
- Native streaming completion support in the first change.
- Enabling every existing model for FIM without provider-specific verification.
- Modifying the existing chat or models API contract.

## Existing Flow

`/v1/*` is rewritten to `/api/v1/*`.

The established chat path is:

`src/app/api/v1/chat/completions/route.js`
→ `src/sse/handlers/chat.js`
→ `open-sse/handlers/chatCore.js`
→ `open-sse/executors/default.js`
→ provider-specific OpenAI-compatible Chat Completions endpoint.

The chat handler already applies local API-key authentication, model resolution, account fallback, timeout/error normalization, request logging, usage tracking, and model/provider routing. The new completion path must reuse it rather than create an outbound proxy.

For `alims-intl`, `open-sse/providers/registry/alims-intl.js` configures the existing upstream endpoint:

`https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`

## Provider Findings

Alibaba Model Studio documents `deepseek-v4-flash-0731` as a hybrid-thinking model. The documented switch to non-thinking mode in the OpenAI-compatible Chat Completions API is `enable_thinking: false`. It is necessary for short inline suggestions because thinking is enabled by default and billed/counts as output tokens.

Alibaba does not document native prefix/FIM completion for DeepSeek V4 Flash. Therefore this feature cannot claim raw native FIM transport. The router will preserve FIM semantics in an explicit adapter and ask the existing Chat Completions transport for exactly the missing code.

References:

- https://help.aliyun.com/en/model-studio/deepseek-api
- `open-sse/providers/registry/alims-intl.js`
- `src/sse/handlers/chat.js`

## API Contract

### Request

`POST /v1/completions`

Required:

```json
{
  "model": "alims-intl/deepseek-v4-flash-0731",
  "prompt": "string",
  "stream": false,
  "max_tokens": 128
}
```

Accepted optional fields in v1: `stop`, `temperature`, `top_p`, `seed`, `presence_penalty`, and `frequency_penalty`. These are forwarded only when already supported by the existing OpenAI-compatible chat transport.

Validation:

- `model` and `prompt` must be non-empty strings.
- `max_tokens`, when supplied, must be a positive safe integer.
- `stop` must be a string or an array of strings.
- `stream: true` returns an OpenAI-shaped `400` error stating that completion streaming is not yet supported.
- A non-FIM prompt is supported as prefix-only completion; `suffix` is empty.
- A malformed or incomplete FIM marker sequence returns a clear OpenAI-shaped `400` error, not a silently degraded chat request.

### Response

For `stream: false`, the response is OpenAI Text Completion JSON:

```json
{
  "id": "cmpl-...",
  "object": "text_completion",
  "created": 1787583125,
  "model": "alims-intl/deepseek-v4-flash-0731",
  "choices": [{
    "text": "...",
    "index": 0,
    "finish_reason": "stop",
    "logprobs": null
  }],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

Errors use the project’s existing `errorResponse` JSON shape and status conventions. Authentication results remain exactly those of `handleChat`.

## FIM Transformation

The adapter recognizes the order-independent DeepSeek marker layout used by PhpStorm:

```text
<｜fim▁end｜>{suffix}<｜fim▁begin｜>{prefix}<｜fim▁hole｜>
```

It extracts each segment without changing code bytes:

- `prefix`: code before the cursor.
- `hole`: requested insertion position; it must be empty in the current PhpStorm schema.
- `suffix`: code after the cursor.

It builds a single internal OpenAI chat request with:

1. a fixed system instruction: output only source code for the missing range; do not use markdown, explanations, delimiters, prefix, or suffix;
2. a user message containing distinctly labelled `PREFIX`, `HOLE`, and `SUFFIX` sections;
3. `max_tokens` copied from the completion request;
4. `stop` copied unchanged;
5. `stream: false`;
6. `enable_thinking: false` for the certified DeepSeek V4 provider/model;
7. no tools or reasoning request fields.

The adapter calls the existing chat handler internally through a cloned `Request`, preserving the original Authorization header and other request metadata. It then reads the normalized chat response, removes accidental FIM delimiters/code-fence wrappers only when they are router-added structural leakage, applies requested stop sequences as a final defensive truncation, and maps assistant content to `choices[0].text`.

No raw code prompt or authorization value is logged by new code. Existing optional request-body logging remains governed by the current `ENABLE_REQUEST_LOGS` control.

## Completion Capability Gate

Use a small configuration module near the completion handler rather than changing the generic model capability schema. It will declare initial, verified support:

```js
"alims-intl/deepseek-v4-flash-0731": {
  supportsCompletion: true,
  supportsFim: true,
  disableThinking: "enable_thinking"
}
```

Any other resolved model returns a `400` OpenAI error identifying that FIM completion has not been verified for the selected model. This is deliberate: generic chat capability does not prove FIM quality.

## Files

Create:

- `src/app/api/v1/completions/route.js` — thin compatibility route and CORS preflight.
- `src/sse/handlers/completion.js` — request validation, FIM parsing, existing-chat delegation, normalization.
- `src/sse/services/completionCapabilities.js` — narrow verified-model capability table.
- `tests/unit/completion-fim.test.js` — pure FIM parser and response-normalizer tests.
- `tests/unit/completion-route.test.js` — route/handler behavior with the existing chat handler mocked only at its network boundary.

Modify:

- `next.config.mjs` only if `/v1/:path*` does not already rewrite all v1 paths; expected outcome is no change.
- test configuration only if the existing aliases cannot import the new handler; expected outcome is no change.

## Tests and Verification

1. Failing test first: route is absent / handler does not exist.
2. FIM parser preserves the real PhpStorm prefix and suffix exactly.
3. Prefix-only completion remains valid.
4. Real PhpStorm payload produces an internal chat request with `enable_thinking:false`, requested `max_tokens`, requested stops, and no tools.
5. Response becomes `object: "text_completion"`, has `choices[0].text`, no reasoning content, and compatible usage.
6. Stops truncate output at the first match.
7. Invalid model, missing/invalid fields, malformed FIM, and `stream:true` return JSON errors.
8. Existing auth behavior is verified by delegating through the chat handler rather than bypassing it.
9. Existing `/v1/chat/completions` and `/v1/models` targeted tests remain green.
10. After deployment, run authenticated curl checks with a locally read API key but never print it; capture only HTTP status and schema assertions. Then test the PhpStorm scenario manually.

## Deployment and Upgrades

The change lives in `gui-mcastro/9router`, forked from `decolua/9router`. The installed production artifact is not edited directly.

Deployment will build/package from the fork and point the system service at the resulting version. Future upstream updates are merged into this fork, tests are run, then a new package/build is deployed. No server-only patch is required for this feature.

## Known Limitation

The provider has not documented native FIM completion for this model. The initial implementation is a controlled semantic adapter to Chat Completions, so the integration contract is guaranteed but suggestion quality must be accepted using the real PhpStorm payload before production rollout. Native FIM can replace the adapter later if Alibaba exposes a supported endpoint or parameter.

## Security

- Do not log Authorization headers, API keys, cookies, or full source prompts in new production logging.
- Preserve existing authorization and rate-limit behavior by routing through `handleChat`.
- Keep the model capability gate deny-by-default.
- Do not add credentials to the repository, GitHub Actions, test fixtures, or commit history.
