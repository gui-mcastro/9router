import { statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { getResolvedUsageFilter } from "@/lib/db/repos/usageFilterRepo.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null };

  const stream = new ReadableStream({
    async start(controller) {
      // Realtime fields only (what the dashboard merges from SSE); full stats come from /api/usage/stats.
      // Never rescan history here: every recorded request emits an update, per open tab.
      state.send = async () => {
        if (state.closed) return;
        try {
          const { activeRequests, recentRequests, errorProvider, pending } = await getActiveRequests(await getResolvedUsageFilter());
          const payload = { activeRequests, recentRequests, errorProvider, pending };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.send);
          clearInterval(state.keepalive);
        }
      };

      await state.send();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.send);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
