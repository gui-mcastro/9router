import { describe, expect, it, vi } from "vitest";

const handleCompletion = vi.fn(async () => new Response(JSON.stringify({ object: "text_completion" }), {
  headers: { "content-type": "application/json" },
}));
const initTranslators = vi.fn(async () => {});

vi.mock("@/sse/handlers/completion.js", () => ({ handleCompletion }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators }));

const { OPTIONS, POST } = await import("../../src/app/api/v1/completions/route.js");

describe("/api/v1/completions route", () => {
  it("delegates POST to the completion handler", async () => {
    const request = new Request("https://router.test/api/v1/completions", { method: "POST" });
    const response = await POST(request);

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(handleCompletion).toHaveBeenCalledWith(request);
    expect(initTranslators).toHaveBeenCalledTimes(1);
  });

  it("answers CORS preflight", async () => {
    const response = await OPTIONS();
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
