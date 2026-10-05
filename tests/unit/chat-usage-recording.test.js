import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  handleChatCore: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: async () => true,
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (m) => {
    const [provider, ...rest] = m.split("/");
    return rest.length ? { provider, model: rest.join("/") } : { provider: null, model: m };
  },
  getComboModels: async () => null,
}));
vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("../../open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(), handleFusionChat: vi.fn(), detectRequiredCapabilities: () => new Set(),
}));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: (k) => k,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("../../open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));

// Host VM can be heavily loaded and cold imports of chat.js are slow.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const { saveUsageStats, createUsageSaver } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { withRequestUsage } = await import("../../src/lib/requestUsage.js");
const POST = withRequestUsage(handleChat);

const chatRequest = (body) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer client-key", "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "A", providerSpecificData: {} });
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});

describe("chat usage rows from chatCore", () => {
  it("records a success without provider usage as a zero-token row", () => {
    saveUsageStats({ provider: "openai", model: "gpt-x", tokens: null, connectionId: "c1", apiKey: "k", endpoint: "/v1/chat/completions", silent: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai", model: "gpt-x", tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok", httpStatus: 200, kind: "work",
    }));
  });

  it("records one row when completion and abort race", () => {
    const abortFirst = createUsageSaver();
    abortFirst({ provider: "openai", model: "gpt-x", tokens: null, silent: true, status: "aborted" });
    abortFirst({ provider: "openai", model: "gpt-x", tokens: { prompt_tokens: 5, completion_tokens: 1 }, silent: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "aborted", httpStatus: 499 }));

    const completeFirst = createUsageSaver();
    completeFirst({ provider: "openai", model: "gpt-x", tokens: { prompt_tokens: 5, completion_tokens: 1 }, silent: true });
    completeFirst({ provider: "openai", model: "gpt-x", tokens: null, silent: true, status: "aborted" });
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(2);
    expect(mocks.saveRequestUsage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok", httpStatus: 200 }));
  });
});

describe("chat requests through the route wrapper", () => {
  it("leaves the success row to chatCore", async () => {
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });
    const res = await POST(chatRequest({ model: "openai/gpt-x", messages: [] }));
    expect(res.status).toBe(200);
    await settle();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("records a provider failure with provider, model and account", async () => {
    mocks.handleChatCore.mockResolvedValue({ success: false, status: 503, error: "down", response: Response.json({ error: "down" }, { status: 503 }) });
    const res = await POST(chatRequest({ model: "openai/gpt-x", messages: [] }));
    expect(res.status).toBe(503);
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "openai", model: "gpt-x", connectionId: "conn-1", apiKey: "client-key",
      endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "error", httpStatus: 503, kind: "work", dedupe: false,
    });
  });

  it("records invalid JSON", async () => {
    const res = await POST(chatRequest("{not json"));
    expect(res.status).toBe(400);
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "unknown", model: "unknown", httpStatus: 400, status: "error" }));
  });

  it("records a request with no usable account", async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);
    const res = await POST(chatRequest({ model: "openai/gpt-x", messages: [] }));
    expect(res.status).toBe(404);
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", model: "gpt-x", connectionId: null, httpStatus: 404 }));
  });
});
