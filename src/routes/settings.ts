/**
 * Model and provider configuration from the UI.
 *
 * Two rules hold throughout: plaintext API keys are never returned, and a key
 * set with `wrangler secret put` always wins over one stored here.
 */

import { Hono } from "hono";
import { NoPassphraseError } from "../config/crypto";
import {
  deleteSecret,
  isSecretName,
  isSettingKey,
  putSecret,
  putSetting,
  resolveConfig,
  secretHints,
  SETTING_KEYS,
  type SettingKey,
} from "../config/settings";
import { createModel } from "../llm";
import { createSearchProvider } from "../tools/search";
import { readJson } from "./util";

export const settingsRoutes = new Hono<{ Bindings: Env }>();

/** The providers the UI offers, and what each one needs. */
const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI-compatible",
    needsKey: true,
    needsBaseUrl: true,
    note: "OpenAI, OpenRouter, Groq, DeepSeek, Together, vLLM — set the base URL to match.",
    exampleModel: "anthropic/claude-sonnet-5",
    exampleBaseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    needsKey: true,
    needsBaseUrl: false,
    note: "Direct to the Anthropic Messages API.",
    exampleModel: "claude-opus-5",
    exampleBaseUrl: "",
  },
  {
    id: "workers-ai",
    label: "Workers AI",
    needsKey: false,
    needsBaseUrl: false,
    note: 'Runs on Cloudflare. Needs the "ai" binding enabled in wrangler.jsonc.',
    exampleModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    exampleBaseUrl: "",
  },
  {
    id: "mock",
    label: "Mock (no key)",
    needsKey: false,
    needsBaseUrl: false,
    note: "Runs the whole pipeline with canned prose. Useful for testing the UI.",
    exampleModel: "",
    exampleBaseUrl: "",
  },
];

/** Current settings, which are overridden, and masked secret state. */
settingsRoutes.get("/", async (c) => {
  const cfg = await resolveConfig(c.env, c.env.DB);
  const { model, configured, note } = createModel(cfg);
  const search = createSearchProvider(cfg);
  const hints = await secretHints(c.env.DB);

  return c.json({
    providers: PROVIDERS,
    settings: {
      MODEL_PROVIDER: cfg.modelProvider,
      MODEL_ID: cfg.modelId,
      MODEL_BASE_URL: cfg.modelBaseUrl,
      MODEL_JSON_MODE: cfg.modelJsonMode,
      SEARCH_PROVIDER: cfg.searchProvider,
      MAX_POST_CHARS: String(cfg.maxPostChars),
    },
    overridden: cfg.overridden,
    model: { name: model.name, configured, note },
    search: { provider: search?.name ?? "none", configured: Boolean(search) },
    secrets: Object.fromEntries(
      (["MODEL_API_KEY", "SEARCH_API_KEY", "X_BEARER_TOKEN"] as const).map((name) => [
        name,
        {
          source: cfg.secretSources[name],
          hint: hints[name]?.hint ?? "",
          updatedAt: hints[name]?.updatedAt ?? "",
        },
      ]),
    ),
    canStoreSecrets: cfg.canStoreSecrets,
    undecryptable: cfg.undecryptable,
  });
});

settingsRoutes.put("/", async (c) => {
  const body = await readJson<Record<string, string>>(c);

  const updates: [SettingKey, string][] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!isSettingKey(key)) {
      return c.json({ error: `Unknown setting "${key}". Allowed: ${SETTING_KEYS.join(", ")}.` }, 400);
    }
    if (typeof value !== "string") {
      return c.json({ error: `Setting "${key}" must be a string.` }, 400);
    }
    updates.push([key, value]);
  }

  const provider = updates.find(([k]) => k === "MODEL_PROVIDER")?.[1]?.trim().toLowerCase();
  if (provider && !PROVIDERS.some((p) => p.id === provider)) {
    return c.json({ error: `Unknown provider "${provider}".` }, 400);
  }

  for (const [key, value] of updates) await putSetting(c.env.DB, key, value);

  const cfg = await resolveConfig(c.env, c.env.DB);
  const { model, configured, note } = createModel(cfg);
  return c.json({ ok: true, model: { name: model.name, configured, note } });
});

/**
 * Store an API key, encrypted. Send an empty value to remove it.
 * The plaintext is never echoed back.
 */
settingsRoutes.put("/secrets/:name", async (c) => {
  const name = c.req.param("name");
  if (!isSecretName(name)) return c.json({ error: `Unknown secret "${name}".` }, 400);

  const body = await readJson<{ value: string }>(c);
  const value = (body.value ?? "").trim();

  if (!value) {
    await deleteSecret(c.env.DB, name);
    return c.json({ ok: true, removed: true });
  }

  try {
    await putSecret(c.env.DB, c.env, name, value);
  } catch (err) {
    if (err instanceof NoPassphraseError) return c.json({ error: err.message }, 409);
    throw err;
  }

  const cfg = await resolveConfig(c.env, c.env.DB);
  return c.json({
    ok: true,
    source: cfg.secretSources[name],
    // A stored key is inert while an env secret of the same name exists.
    shadowedByEnv: cfg.secretSources[name] === "env",
  });
});

settingsRoutes.delete("/secrets/:name", async (c) => {
  const name = c.req.param("name");
  if (!isSecretName(name)) return c.json({ error: `Unknown secret "${name}".` }, 400);
  await deleteSecret(c.env.DB, name);
  return c.json({ ok: true });
});

/** Round-trip the configured model so a bad key or model id surfaces here, not mid-draft. */
settingsRoutes.post("/test", async (c) => {
  const cfg = await resolveConfig(c.env, c.env.DB);
  const { model, configured, note } = createModel(cfg);

  if (!configured) return c.json({ ok: false, model: model.name, error: note ?? "Not configured." });

  const started = Date.now();
  try {
    const reply = await model.complete(
      [{ role: "user", content: 'Reply with exactly: {"ok":true}' }],
      { task: "test", maxTokens: 64 },
    );
    return c.json({
      ok: true,
      model: model.name,
      ms: Date.now() - started,
      reply: reply.slice(0, 200),
    });
  } catch (err) {
    return c.json({
      ok: false,
      model: model.name,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Model ids for the current provider, so the UI can offer a list instead of a
 * free-text field. Only OpenRouter publishes a usable catalogue without auth;
 * everything else falls back to typing an id.
 */
settingsRoutes.get("/models", async (c) => {
  const cfg = await resolveConfig(c.env, c.env.DB);
  if (!cfg.modelBaseUrl.includes("openrouter.ai")) {
    return c.json({ models: [], source: "none" });
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return c.json({ models: [], source: "none" });

    const json = (await res.json()) as {
      data?: { id?: string; name?: string; supported_parameters?: string[] }[];
    };

    const models = (json.data ?? [])
      .filter((m) => m.id && !m.id.endsWith(":batch"))
      .map((m) => ({
        id: m.id as string,
        name: m.name ?? (m.id as string),
        // Flagged so the UI can warn before MODEL_JSON_MODE=schema fails at draft time.
        schema: (m.supported_parameters ?? []).some(
          (p) => p === "response_format" || p === "structured_outputs",
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return c.json({ models, source: "openrouter" });
  } catch {
    return c.json({ models: [], source: "none" });
  }
});
