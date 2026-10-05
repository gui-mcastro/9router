// chatCore answers some Claude CLI requests locally (warmup/naming bypass). chat.js hands successful
// results off to chatCore's own recording, so the bypass branch must write the row itself.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

// Cold import of chatCore pulls the translator and provider registry; slow on the shared host.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("chatCore bypass responses", () => {
  it("record one zero-token ok row", async () => {
    const result = await handleChatCore({
      body: { model: "claude/claude-x", stream: false, messages: [{ role: "user", content: "Warmup" }] },
      modelInfo: { provider: "claude", model: "claude-x" },
      credentials: {},
      log: null,
      clientRawRequest: { endpoint: "/v1/messages", headers: {} },
      connectionId: "conn-1",
      userAgent: "claude-cli/1.0.0",
      apiKey: "client-key",
    });
    expect(result.success).toBe(true);
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude", model: "claude-x", connectionId: "conn-1", apiKey: "client-key",
      endpoint: "/v1/messages", status: "ok", httpStatus: 200, kind: "work",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
    }));
  });
});
