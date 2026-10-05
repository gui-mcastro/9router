import { handleVideoCreate } from "@/sse/handlers/videoGeneration.js";
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

/** POST /v1/videos/extensions - async video extension (xAI Grok Imagine) */
async function handlePost(request) {
  return await handleVideoCreate(request, "extensions");
}

export const POST = withRequestUsage(handlePost);
