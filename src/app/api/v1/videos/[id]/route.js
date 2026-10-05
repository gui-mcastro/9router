import { handleVideoGet } from "@/sse/handlers/videoGeneration.js";
import { withRequestUsage } from "@/lib/requestUsage.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** GET /v1/videos/{request_id} - poll async video job status (xAI Grok Imagine) */
async function handleGet(request, { params }) {
  const { id } = await params;
  return await handleVideoGet(request, id);
}

export const GET = withRequestUsage(handleGet);
