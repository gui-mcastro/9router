import { handleEmbeddings } from "@/sse/handlers/embeddings.js";
import { withRequestUsage } from "@/lib/requestUsage.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/embeddings - OpenAI-compatible embeddings endpoint
 */
async function handlePost(request) {
  return await handleEmbeddings(request);
}

export const POST = withRequestUsage(handlePost);
