import { cookies } from "next/headers";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

/**
 * Proxies the CSV download.
 *
 * A plain `<a href>` cannot attach the session cookie to a cross-origin API
 * request, so the download goes through the BFF like everything else. The
 * body is streamed and the API's own Content-Disposition preserved, so the
 * browser saves a file rather than rendering text.
 */
export async function GET(
  _request: Request,
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

  const upstream = await fetch(`${API_ORIGIN}/api/v1/stores/${storeId}/catalog.csv`, {
    headers: { cookie: auth, accept: "text/csv" },
    cache: "no-store",
  });

  if (!upstream.ok) {
    return new Response("Could not export the catalog.", { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="catalog.csv"',
      "Cache-Control": "no-store",
    },
  });
}
