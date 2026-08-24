import { describe, expect, it } from "vitest";
import {
  normalizeCompletionResponse,
  parseCompletionPrompt,
  validateCompletionBody,
} from "../../src/sse/handlers/completion.js";
import { getCompletionCapability } from "../../src/sse/services/completionCapabilities.js";

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
      isFim: false,
      prefix: "<?php\nfunction hello() {\n  ",
      suffix: "",
    });
  });

  it.each([
    `${BEGIN}prefix${HOLE}`,
    `${END}suffix${HOLE}${BEGIN}prefix`,
    `${END}suffix${BEGIN}prefix${HOLE}unexpected`,
    `${END}suffix${BEGIN}prefix${HOLE}${HOLE}`,
  ])("rejects malformed marker sequences", (prompt) => {
    expect(() => parseCompletionPrompt(prompt)).toThrow("Malformed FIM prompt");
  });

  it("normalizes completion limits and stops", () => {
    expect(validateCompletionBody({ model: "alims-intl/deepseek-v4-flash-0731", prompt: "prefix", max_tokens: 128, stop: "\n\n" })).toEqual({
      maxTokens: 128,
      stops: ["\n\n"],
    });
    expect(validateCompletionBody({ model: "alims-intl/deepseek-v4-flash-0731", prompt: "prefix", stop: [";", "\n"] })).toEqual({
      maxTokens: undefined,
      stops: [";", "\n"],
    });
  });

  it.each([
    [{ prompt: "prefix" }, "model must be a non-empty string"],
    [{ model: "alims-intl/deepseek-v4-flash-0731", prompt: "" }, "prompt must be a non-empty string"],
    [{ model: "alims-intl/deepseek-v4-flash-0731", prompt: "prefix", stream: true }, "completion streaming is not yet supported"],
    [{ model: "alims-intl/deepseek-v4-flash-0731", prompt: "prefix", max_tokens: 0 }, "max_tokens must be a positive safe integer"],
    [{ model: "alims-intl/deepseek-v4-flash-0731", prompt: "prefix", max_tokens: 1.5 }, "max_tokens must be a positive safe integer"],
    [{ model: "alims-intl/deepseek-v4-flash-0731", prompt: "prefix", stop: ["ok", 1] }, "stop must be a string or an array of strings"],
  ])("rejects invalid completion options", (body, error) => {
    expect(validateCompletionBody(body)).toEqual({ error });
  });

  it("maps chat output and truncates at the earliest requested stop", () => {
    const out = normalizeCompletionResponse({
      id: "chatcmpl-1",
      created: 10,
      model: "alims-intl/deepseek-v4-flash-0731",
      choices: [{ message: { content: "return 1;\n\nignored;also ignored" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 6, total_tokens: 8 },
    }, { stop: [";", "\n\n"] });

    expect(out.id).toBe("cmpl-1");
    expect(out.object).toBe("text_completion");
    expect(out.choices[0]).toEqual({
      text: "return 1",
      index: 0,
      finish_reason: "stop",
      logprobs: null,
    });
    expect(out.usage.total_tokens).toBe(8);
  });

  it("only certifies the initial provider and model", () => {
    expect(getCompletionCapability("alims-intl", "deepseek-v4-flash-0731")).toEqual({
      supportsCompletion: true,
      supportsFim: true,
      disableThinking: "enable_thinking",
    });
    expect(getCompletionCapability("alims-intl", "another-model")).toBeNull();
  });
});
