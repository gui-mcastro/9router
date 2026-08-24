const FIM_BEGIN = "<｜fim▁begin｜>";
const FIM_HOLE = "<｜fim▁hole｜>";
const FIM_END = "<｜fim▁end｜>";
const FIM_MARKERS = [FIM_BEGIN, FIM_HOLE, FIM_END];

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

export function normalizeCompletionResponse(chatResponse, request) {
  const content = chatResponse.choices?.[0]?.message?.content || "";
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
