/**
 * Generation and feedback.
 *
 * /api/generate streams progress over SSE so the UI can show the agent's steps
 * rather than a spinner. /api/feedback is what closes the memory loop.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { runAgent } from "../agent/orchestrator";
import { resolveConfig } from "../config/settings";
import { createModel } from "../llm";
import { applyFeedback } from "../memory/learn";
import {
  createSession,
  deleteSession,
  getSession,
  lastTurn,
  listSessions,
  renameSession,
  sessionTurns,
  titleFromInput,
  type DraftRow,
} from "../memory/store";
import { createSearchProvider } from "../tools/search";
import type { AgentEvent, SourceDoc, Variant, Verdict } from "../types";
import type { RefineTurn } from "../agent/prompts";
import { readJson } from "./util";

const MAX_INPUT_CHARS = 8000;

export const agentRoutes = new Hono<{ Bindings: Env }>();

agentRoutes.post("/generate", async (c) => {
  const body = await readJson<{ input: string; sessionId: string }>(c);
  const input = (body.input ?? "").trim();

  if (!input) return c.json({ error: "Send something to write about." }, 400);
  if (input.length > MAX_INPUT_CHARS) {
    return c.json({ error: `Input is too long (max ${MAX_INPUT_CHARS} characters).` }, 400);
  }

  const db = c.env.DB;

  // An existing session id makes this a follow-up; otherwise start a new one.
  let sessionId = (body.sessionId ?? "").trim();
  let history: RefineTurn[] = [];
  let priorSources: SourceDoc[] = [];
  let isNew = false;

  if (sessionId) {
    const existing = await getSession(db, sessionId);
    if (!existing) return c.json({ error: "No such session." }, 404);
    const turns = await sessionTurns(db, sessionId);
    history = turns.map(toRefineTurn);
    priorSources = sourcesOf(turns);
  } else {
    sessionId = crypto.randomUUID();
    await createSession(db, { id: sessionId, title: titleFromInput(input) });
    isNew = true;
  }

  const cfg = await resolveConfig(c.env, db);
  const { model } = createModel(cfg);
  const search = createSearchProvider(cfg);

  return streamSSE(c, async (stream) => {
    const emit = async (event: AgentEvent) => {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    };

    // Sent first so the UI can select the session before any drafts land.
    await emit({ type: "session", sessionId, isNew, title: titleFromInput(input) });

    try {
      await runAgent({ cfg, db, model, search, input, sessionId, history, priorSources, emit });
    } catch (err) {
      console.error("generate failed", err);
      await emit({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong while writing.",
      });
    }
  });
});

/* -------------------------------- sessions ------------------------------- */

agentRoutes.get("/sessions", async (c) =>
  c.json({ sessions: await listSessions(c.env.DB) }),
);

agentRoutes.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const session = await getSession(c.env.DB, id);
  if (!session) return c.json({ error: "No such session." }, 404);

  const turns = await sessionTurns(c.env.DB, id);
  return c.json({
    session,
    turns: turns.map((t) => ({
      id: t.id,
      input: t.input,
      format: t.format,
      rationale: t.rationale,
      verdict: t.verdict,
      createdAt: t.created_at,
      variants: parseVariants(t.variants_json),
      sources: sourcesOfOne(t),
    })),
  });
});

agentRoutes.patch("/sessions/:id", async (c) => {
  const body = await readJson<{ title: string }>(c);
  if (!body.title?.trim()) return c.json({ error: "A title is required." }, 400);
  await renameSession(c.env.DB, c.req.param("id"), body.title);
  return c.json({ ok: true });
});

agentRoutes.delete("/sessions/:id", async (c) => {
  await deleteSession(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

agentRoutes.post("/feedback", async (c) => {
  const body = await readJson<{ draftId: string; verdict: string; finalText: string; note: string }>(c);

  const verdicts: Verdict[] = ["posted", "edited", "rejected"];
  if (!body.draftId || !verdicts.includes(body.verdict as Verdict)) {
    return c.json({ error: "draftId and a verdict of posted | edited | rejected are required." }, 400);
  }

  const { model } = createModel(await resolveConfig(c.env, c.env.DB));
  const result = await applyFeedback(c.env.DB, model, {
    draftId: body.draftId,
    verdict: body.verdict as Verdict,
    finalText: body.finalText,
    note: body.note,
  });

  if (!result.recorded) return c.json({ error: "No such draft." }, 404);
  return c.json(result);
});

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function parseVariants(json: string): Variant[] {
  const parsed = safeParse(json);
  return Array.isArray(parsed) ? (parsed as Variant[]) : [];
}

function toRefineTurn(row: DraftRow): RefineTurn {
  return { instruction: row.input, format: row.format, variants: parseVariants(row.variants_json) };
}

function sourcesOfOne(row: DraftRow): SourceDoc[] {
  const ctx = safeParse(row.context_json) as { sources?: SourceDoc[] } | null;
  return Array.isArray(ctx?.sources) ? ctx.sources : [];
}

/** Every source gathered across a session, de-duplicated by URL. */
function sourcesOf(rows: DraftRow[]): SourceDoc[] {
  const byUrl = new Map<string, SourceDoc>();
  for (const row of rows) {
    for (const source of sourcesOfOne(row)) {
      if (source.url && !byUrl.has(source.url)) byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}
