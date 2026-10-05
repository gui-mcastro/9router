import { handleTts } from "@/sse/handlers/tts.js";
import { withRequestUsage } from "@/lib/requestUsage.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/audio/speech - OpenAI-compatible TTS endpoint */
async function handlePost(request) {
  return await handleTts(request);
}

export const POST = withRequestUsage(handlePost);
