/**
 * X post agent -- Worker entrypoint.
 *
 * The Worker owns /api/*; everything else is served from public/ by the static
 * asset binding (see `run_worker_first` in wrangler.jsonc).
 */

import { Hono } from "hono";
import { formatSummaries } from "./agent/orchestrator";
import { resolveConfig } from "./config/settings";
import { getProfile } from "./memory/store";
import { createModel } from "./llm";
import { agentRoutes } from "./routes/agent";
import { memoryRoutes } from "./routes/memory";
import { settingsRoutes } from "./routes/settings";
import { createSearchProvider } from "./tools/search";

const app = new Hono<{ Bindings: Env }>();

/**
 * Optional shared-passphrase gate. Off unless APP_PASSWORD is set, which keeps
 * local development frictionless while giving a deployed instance a lock.
 * /api/config stays open so the UI can discover that a passphrase is needed.
 */
app.use("/api/*", async (c, next) => {
  const expected = c.env.APP_PASSWORD?.trim();
  if (!expected) return await next();
  if (c.req.path === "/api/config") return await next();

  const supplied = c.req.header("x-app-password") ?? "";
  if (!timingSafeEqual(supplied, expected)) {
    return c.json({ error: "Wrong or missing passphrase." }, 401);
  }
  return await next();
});

app.get("/api/config", async (c) => {
  const [cfg, profile] = await Promise.all([
    resolveConfig(c.env, c.env.DB),
    getProfile(c.env.DB),
  ]);
  const { model, configured, note } = createModel(cfg);
  const search = createSearchProvider(cfg);

  return c.json({
    // Not sensitive, and the UI needs it to render post previews before the
    // user has authenticated against the gated memory routes.
    handle: profile.handle,
    model: { name: model.name, configured, note },
    search: { provider: search?.name ?? "none", configured: Boolean(search) },
    xApi: { configured: Boolean(cfg.xBearerToken) },
    authRequired: Boolean(c.env.APP_PASSWORD?.trim()),
    maxPostChars: cfg.maxPostChars,
    formats: formatSummaries(),
  });
});

app.route("/api", agentRoutes);
app.route("/api/memory", memoryRoutes);
app.route("/api/settings", settingsRoutes);

app.notFound((c) =>
  c.req.path.startsWith("/api/") ? c.json({ error: "Not found." }, 404) : c.env.ASSETS.fetch(c.req.raw),
);

app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: "Internal error." }, 500);
});

/** Constant-time string compare, so the gate doesn't leak the passphrase by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Compare a fixed number of bytes regardless of input length.
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export default app;
