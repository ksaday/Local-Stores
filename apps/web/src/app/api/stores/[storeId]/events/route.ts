import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

/**
 * Proxies the API's order event stream to the browser.
 *
 * The browser only ever talks to Next, and `EventSource` cannot set headers —
 * so the session cookie has to be attached here, server-side, exactly as the
 * rest of the BFF does. Without this the stream would be the one part of the
 * app that needed the API exposed directly to the browser.
 *
 * The body is passed straight through rather than buffered: reading it to a
 * string would defeat the entire point of a stream.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await params;

  const jar = await cookies();
  const auth = jar
    .getAll()
    .filter((c) => c.name === "bba_at" || c.name === "bba_rt")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  if (!auth) return new Response("Unauthorized", { status: 401 });

  const headers: Record<string, string> = { accept: "text/event-stream", cookie: auth };

  // Forwarded so the API can replay what this client missed. Reconnects are
  // the normal case for a tablet on shop wifi, not an edge case.
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) headers["last-event-id"] = lastEventId;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_ORIGIN}/api/v1/stores/${storeId}/events`, {
      headers,
      // Without this the connection is aborted when the client navigates away
      // mid-stream, which is exactly what happens on every page change.
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    // The client treats a failed connection as a reason to fall back to
    // polling, so a plain 503 is the right answer rather than a thrown error.
    return new Response("Event stream unavailable", { status: 503 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("Event stream unavailable", { status: upstream.status || 503 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
