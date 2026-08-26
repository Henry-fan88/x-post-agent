import type { Context } from "hono";

/**
 * Read a JSON body without throwing on malformed input.
 *
 * Returns Partial<T> rather than T: the body is user-supplied, so every field
 * is treated as optional and validated at the call site.
 */
export async function readJson<T>(c: Context): Promise<Partial<T>> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" ? (body as Partial<T>) : {};
  } catch {
    return {};
  }
}
