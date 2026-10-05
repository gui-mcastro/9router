import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleTtsCore: vi.fn(),
  saveRequestUsage: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  extractApiKey: () => "client-key",
  isValidApiKey: async () => true,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (m) => {
    const [provider, ...rest] = m.split("/");
    return { provider, model: rest.join("/") };
  },
  getComboModels: async (m) => (m === "my-tts-combo" ? ["elevenlabs/voice-id", "edge-tts/voice"] : null),
}));
vi.mock("../../open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.handleTtsCore }));
vi.mock("../../open-sse/services/combo.js", () => ({
  handleComboChat: async ({ body, models, handleSingleModel }) => {
    let last;
    for (const m of models) {
      last = await handleSingleModel(body, m);
      if (last.ok) return last;
    }
    return last;
  },
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { withRequestUsage } = await import("../../src/lib/requestUsage.js");
const POST = withRequestUsage(handleTts);

const speak = (model) => POST(new Request("http://localhost/v1/audio/speech", {
  method: "POST",
  headers: { authorization: "Bearer client-key" },
  body: JSON.stringify({ model, input: "olá" }),
}));
const audio = () => ({ success: true, response: new Response("audio", { status: 200 }) });
const failure = (status = 502) => ({ success: false, status, error: "boom", response: Response.json({ error: "boom" }, { status }) });
const recorded = () => mocks.saveRequestUsage.mock.calls.map(([entry]) => entry);

describe("TTS requests through the route wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestUsage.mockResolvedValue(undefined);
  });

  it("records a successful no-auth request once", async () => {
    mocks.handleTtsCore.mockResolvedValue(audio());
    expect((await speak("edge-tts/pt-BR-ThalitaMultilingualNeural")).status).toBe(200);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toEqual({
      provider: "edge-tts", model: "pt-BR-ThalitaMultilingualNeural", connectionId: null, apiKey: "client-key",
      endpoint: "/v1/audio/speech", tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok", httpStatus: 200, kind: "work", dedupe: false,
    });
  });

  it("records a failed no-auth request as error", async () => {
    mocks.handleTtsCore.mockResolvedValue(failure(502));
    expect((await speak("edge-tts/voice")).status).toBe(502);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ provider: "edge-tts", status: "error", httpStatus: 502 });
  });

  it("records only the final outcome of an account fallback", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "conn-1", connectionName: "A" })
      .mockResolvedValueOnce({ connectionId: "conn-2", connectionName: "B" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleTtsCore.mockResolvedValueOnce(failure(429)).mockResolvedValueOnce(audio());
    expect((await speak("elevenlabs/voice-id")).status).toBe(200);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ provider: "elevenlabs", connectionId: "conn-2", status: "ok" });
  });

  it("records the last tried account when every account fails", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "conn-1", connectionName: "A" })
      .mockResolvedValueOnce(null);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleTtsCore.mockResolvedValueOnce(failure(500));
    await speak("elevenlabs/voice-id");
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ connectionId: "conn-1", status: "error" });
  });

  it("records the failure even when no account was available", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(null);
    expect((await speak("elevenlabs/voice-id")).status).toBe(400);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ provider: "elevenlabs", connectionId: null, httpStatus: 400 });
  });

  it("does not leak the failed account of an earlier combo attempt into the final row", async () => {
    mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "A" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.handleTtsCore.mockImplementation(async ({ provider }) => (provider === "elevenlabs" ? failure(500) : audio()));
    expect((await speak("my-tts-combo")).status).toBe(200);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ provider: "edge-tts", model: "voice", connectionId: null, status: "ok" });
  });

  it("audio still succeeds when saving usage fails", async () => {
    mocks.saveRequestUsage.mockRejectedValue(new Error("db down"));
    mocks.handleTtsCore.mockResolvedValue(audio());
    expect((await speak("edge-tts/voice")).status).toBe(200);
  });
});
