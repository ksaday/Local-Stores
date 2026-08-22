import { cookies } from "next/headers";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

/** Only these. The path segment comes from a URL and reaches the API. */
const KINDS = new Set(["sales", "products", "customers", "stock"]);

/**
 * Proxies a report download.
 *
 * Same shape as the catalog export: a plain `<a href>` cannot attach the
 * session cookie to a cross-origin API request, so the download goes through
 * the BFF and the API's own `Content-Disposition` is preserved, which is what
 * makes the browser save a file rather than render text.
 *
 * The body is streamed rather than buffered. The largest of these is a few
 * megabytes today, and streaming means that stays true of this route however
 * large the file becomes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ storeId: string; kind: string }> },
) {
  const { storeId, kind } = await params;
  if (!KINDS.has(kind)) return new Response("Not found", { status: 404 });

  const jar = await cookies();
  const auth = jar
    .getAll()
    .filter((c) => c.name === "bba_at" || c.name === "bba_rt")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!auth) return new Response("Unauthorized", { status: 401 });

  // Only the parameters the export understands are forwarded, rather than the
  // caller's whole query string.
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ["from", "to", "grain"]) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }

  const upstream = await fetch(
    `${API_ORIGIN}/api/v1/stores/${storeId}/reports/export/${kind}.csv?${query}`,
    { headers: { cookie: auth, accept: "text/csv" }, cache: "no-store" },
  );

  if (!upstream.ok) {
    return new Response("Could not build that export.", { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        upstream.headers.get("content-disposition") ?? `attachment; filename="${kind}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
