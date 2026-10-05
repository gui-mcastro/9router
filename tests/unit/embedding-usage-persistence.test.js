import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({
    apiKey: "provider-secret",
    connectionId: "connection-a",
    connectionName: "Provider A",
  }),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "openai", model: "text-embedding-3-small" }),
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));
vi.mock("../../open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: message }, { status }),
  unavailableResponse: (status, message) => Response.json({ error: message }, { status }),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";
import { withRequestUsage } from "../../src/lib/requestUsage.js";

const embed = (body) => withRequestUsage(handleEmbeddings)(new Request("http://localhost/v1/embeddings", {
  method: "POST",
  headers: { authorization: "Bearer client-key" },
  body: JSON.stringify(body),
}));

describe("embedding usage persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: true,
      usage: { prompt_tokens: 12, total_tokens: 12 },
      response: Response.json({ data: [] }),
    });
  });

  it("records exact provider usage for successful embedding requests", async () => {
    await embed({ model: "openai/text-embedding-3-small", input: "hello" });

    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "connection-a",
      apiKey: "client-key",
      endpoint: "/v1/embeddings",
      tokens: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
      status: "ok",
      httpStatus: 200,
      kind: "work",
      dedupe: false,
    });
  });

  it.each([
    null,
    {},
    { prompt_tokens: 0, total_tokens: 0 },
    { prompt_tokens: "12", total_tokens: 12 },
    { prompt_tokens: 12, total_tokens: 13 },
    { prompt_tokens: 12, completion_tokens: 1, total_tokens: 12 },
    { prompt_tokens: 12, total_tokens: 12, estimated: true },
  ])("records inexact usage as a zero-token request %#", async (usage) => {
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: true,
      usage,
      response: Response.json({ data: [] }),
    });

    await embed({ model: "openai/text-embedding-3-small", input: "hello" });

    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok",
    }));
  });
});
