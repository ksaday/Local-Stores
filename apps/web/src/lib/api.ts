import { cookies } from "next/headers";
import type { ProblemDetails } from "@bba/shared";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";
const API_BASE = `${API_ORIGIN}/api/v1`;

/**
 * Thrown for any non-2xx API response, carrying the Problem Details body so a
 * page can map the stable `code` to user-facing copy rather than string-match
 * a message (plan §10.1).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
  }

  /** Field-level errors keyed by field name, for attaching to form inputs. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) out[e.field] = e.message;
    return out;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Forward the caller's session. Off for genuinely public reads. */
  authenticated?: boolean;
  /** Next.js cache tags, for on-demand revalidation of storefront pages. */
  tags?: string[];
  revalidate?: number | false;
}

/**
 * Server-side API client (plan §11.3).
 *
 * Runs only in Server Components and route handlers. The session cookie is
 * read via `next/headers` and forwarded server-to-server, so the access token
 * is never readable by client JavaScript — which is the entire point of it
 * being httpOnly.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, authenticated = true, tags, revalidate } = options;

  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";

  if (authenticated) {
    const jar = await cookies();
    const pairs = jar
      .getAll()
      .filter((c) => c.name === "bba_at" || c.name === "bba_rt")
      .map((c) => `${c.name}=${c.value}`);
    if (pairs.length > 0) headers.cookie = pairs.join("; ");
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // Authenticated reads are per-user and must never be shared across
    // sessions by a cache.
    cache: authenticated ? "no-store" : undefined,
    next: authenticated ? undefined : { tags, revalidate },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, (parsed ?? {}) as ProblemDetails);
  }

  // The API wraps single resources as { data }, collections as { data, meta }.
  const payload = parsed as { data?: unknown } | null;
  return (payload && "data" in payload ? payload.data : payload) as T;
}

/** Whether a request carries a session at all, without calling the API. */
export async function hasSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return Boolean(jar.get("bba_at") ?? jar.get("bba_rt"));
}

export interface CurrentUser {
  id: string;
  email: string;
  platformRole: "SUPER_ADMIN" | null;
  memberships: { storeId: string; role: string }[];
}

/**
 * The signed-in user, or null. Returns null rather than throwing on 401 so a
 * layout can decide what to do — some surfaces redirect, others render a
 * signed-out state.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!(await hasSessionCookie())) return null;
  try {
    return await api<CurrentUser>("/auth/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}
