import { beforeEach, describe, expect, it, vi } from "vitest";

const handleChat = vi.fn();
const getModelInfo = vi.fn();
const getComboModels = vi.fn();

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo, getComboModels }));

const { handleCompletion } = await import("../../src/sse/handlers/completion.js");

const model = "alims-intl/deepseek-v4-flash-0731";
const phpStormPayload = {
  model,
  prompt: "<｜fim▁end｜>\n}<｜fim▁begin｜><?php\n\nfunction calculateTotal($items)\n{\n\n    <｜fim▁hole｜>",
  stream: false,
  max_tokens: 128,
  stop: ["\n\n", "<｜fim▁begin｜>", "<｜fim▁end｜>", "<｜fim▁hole｜>"],
};

function request(body) {
  return new Request("https://router.test/api/v1/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-key" },
    body: JSON.stringify(body),
  });
}

async function error(response) {
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json();
}

describe("handleCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getComboModels.mockResolvedValue(null);
    getModelInfo.mockImplementation(async (modelId) => {
      const [provider, modelName] = modelId.split("/");
      return { provider, model: modelName };
    });
    handleChat.mockResolvedValue(new Response(JSON.stringify({
      id: "chatcmpl-1",
      created: 10,
      model,
      choices: [{ index: 0, message: { content: "return $items;" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }), { headers: { "content-type": "application/json" } }));
  });

  it("delegates the real PhpStorm FIM payload through chat with thinking disabled", async () => {
    const response = await handleCompletion(request(phpStormPayload));
    const delegated = await handleChat.mock.calls[0][0].clone().json();

    expect(response.status).toBe(200);
    expect(delegated).toMatchObject({
      model,
      stream: false,
      max_tokens: 128,
      stop: phpStormPayload.stop,
      enable_thinking: false,
    });
    expect(delegated.messages).toHaveLength(2);
    expect(delegated.messages[0].role).toBe("system");
    expect(delegated.messages[1].content).toContain("PREFIX");
    expect(delegated.messages[1].content).toContain("SUFFIX");
    expect(delegated.tools).toBeUndefined();
    expect((await response.json()).object).toBe("text_completion");
  });

  it.each([
    [{ ...phpStormPayload, model: "alims-intl/another-model" }, "does not support verified FIM completion"],
    [{ ...phpStormPayload, stream: true }, "completion streaming is not yet supported"],
    [{ ...phpStormPayload, max_tokens: 0 }, "max_tokens must be a positive safe integer"],
    [{ ...phpStormPayload, stop: ["ok", 1] }, "stop must be a string or an array of strings"],
    [{ ...phpStormPayload, prompt: "<｜fim▁begin｜>broken" }, "Malformed FIM prompt"],
  ])("returns JSON 400 for invalid completion requests", async (body, message) => {
    const response = await handleCompletion(request(body));
    expect(response.status).toBe(400);
    expect((await error(response)).error.message).toContain(message);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("returns a delegated chat error unchanged", async () => {
    handleChat.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    const response = await handleCompletion(request(phpStormPayload));
    expect(response.status).toBe(401);
    expect((await error(response)).error.message).toBe("Invalid API key");
  });
});
