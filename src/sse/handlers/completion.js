const FIM_BEGIN = "<｜fim▁begin｜>";
const FIM_HOLE = "<｜fim▁hole｜>";
const FIM_END = "<｜fim▁end｜>";
const FIM_MARKERS = [FIM_BEGIN, FIM_HOLE, FIM_END];

import { getCompletionCapability } from "../services/completionCapabilities.js";

const BAD_REQUEST = 400;
const COMPLETION_SYSTEM_PROMPT = "Complete only the missing source code. Return no markdown, explanation, FIM delimiter, prefix, or suffix.";

export function parseCompletionPrompt(prompt) {
  const markerCounts = FIM_MARKERS.map((marker) => prompt.split(marker).length - 1);
  if (markerCounts.every((count) => count === 0)) {
    return { prefix: prompt, suffix: "", isFim: false };
  }

  if (markerCounts.some((count) => count !== 1)) {
    throw new Error("Malformed FIM prompt");
  }

  const endIndex = prompt.indexOf(FIM_END);
  const beginIndex = prompt.indexOf(FIM_BEGIN);
  const holeIndex = prompt.indexOf(FIM_HOLE);
  const suffixStart = endIndex + FIM_END.length;
  const prefixStart = beginIndex + FIM_BEGIN.length;
  if (endIndex !== 0 || beginIndex < suffixStart || holeIndex < prefixStart || holeIndex + FIM_HOLE.length !== prompt.length) {
    throw new Error("Malformed FIM prompt");
  }

  return {
    prefix: prompt.slice(prefixStart, holeIndex),
    suffix: prompt.slice(suffixStart, beginIndex),
    isFim: true,
  };
}

export function validateCompletionBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "request body must be an object" };
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return { error: "model must be a non-empty string" };
  }
  if (typeof body.prompt !== "string" || !body.prompt) {
    return { error: "prompt must be a non-empty string" };
  }
  if (body.stream === true) {
    return { error: "completion streaming is not yet supported" };
  }
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) {
    return { error: "max_tokens must be a positive safe integer" };
  }

  const stops = body.stop === undefined
    ? undefined
    : typeof body.stop === "string"
      ? [body.stop]
      : body.stop;
  if (stops !== undefined && (!Array.isArray(stops) || stops.some((stop) => typeof stop !== "string"))) {
    return { error: "stop must be a string or an array of strings" };
  }

  return { maxTokens: body.max_tokens, stops };
}

function stripStructuralLeakage(content) {
  let text = content
    .replace(new RegExp(`^(?:${FIM_BEGIN}|${FIM_HOLE}|${FIM_END})\\s*`), "")
    .replace(new RegExp(`\\s*(?:${FIM_BEGIN}|${FIM_HOLE}|${FIM_END})$`), "");
  const fenced = text.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  return fenced ? fenced[1] : text;
}

export function normalizeCompletionResponse(chatResponse, request) {
  const content = stripStructuralLeakage(chatResponse.choices?.[0]?.message?.content || "");
  const stops = typeof request.stop === "string" ? [request.stop] : request.stop || [];
  const stopIndexes = stops
    .map((stop) => content.indexOf(stop))
    .filter((index) => index >= 0);
  const text = stopIndexes.length ? content.slice(0, Math.min(...stopIndexes)) : content;
  const choice = chatResponse.choices?.[0] || {};

  return {
    id: chatResponse.id?.replace(/^chatcmpl-/, "cmpl-") || chatResponse.id,
    object: "text_completion",
    created: chatResponse.created,
    model: chatResponse.model,
    choices: [{
      text,
      index: choice.index || 0,
      finish_reason: choice.finish_reason,
      logprobs: null,
    }],
    usage: chatResponse.usage,
  };
}

function completionUserMessage({ prefix, suffix }) {
  return `PREFIX:\n${prefix}\n\nHOLE:\n\n\nSUFFIX:\n${suffix}`;
}

export async function handleCompletion(request) {
  const [{ errorResponse }, { getModelInfo, getComboModels }, { handleChat }] = await Promise.all([
    import("open-sse/utils/error.js"),
    import("../services/model.js"),
    import("./chat.js"),
  ]);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateCompletionBody(body);
  if (validation.error) return errorResponse(BAD_REQUEST, validation.error);

  let fim;
  try {
    fim = parseCompletionPrompt(body.prompt);
  } catch (error) {
    return errorResponse(BAD_REQUEST, error.message);
  }

  const comboModels = await getComboModels(body.model);
  if (comboModels) return errorResponse(BAD_REQUEST, "Selected model does not support verified FIM completion");
  const modelInfo = await getModelInfo(body.model);
  const capability = modelInfo?.provider && getCompletionCapability(modelInfo.provider, modelInfo.model);
  if (!capability?.supportsCompletion || (fim.isFim && !capability.supportsFim)) {
    return errorResponse(BAD_REQUEST, "Selected model does not support verified FIM completion");
  }

  const chatBody = {
    model: body.model,
    messages: [
      { role: "system", content: COMPLETION_SYSTEM_PROMPT },
      { role: "user", content: completionUserMessage(fim) },
    ],
    stream: false,
    ...(validation.maxTokens !== undefined && { max_tokens: validation.maxTokens }),
    ...(validation.stops !== undefined && { stop: validation.stops }),
    ...(capability.disableThinking === "enable_thinking" && { enable_thinking: false }),
  };
  const chatRequest = new Request(new URL("/api/v1/chat/completions", request.url), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(chatBody),
  });
  const response = await handleChat(chatRequest, {
    endpoint: "/v1/completions",
    body,
    headers: Object.fromEntries(request.headers.entries()),
  });
  if (!response.ok) return response;

  let chatResponse;
  try {
    chatResponse = await response.json();
  } catch {
    return errorResponse(502, "Invalid JSON response from chat completion");
  }
  return new Response(JSON.stringify(normalizeCompletionResponse(chatResponse, body)), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
