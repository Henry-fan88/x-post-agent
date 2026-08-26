/**
 * Generation and feedback.
 *
 * /api/generate streams progress over SSE so the UI can show the agent's steps
 * rather than a spinner. /api/feedback is what closes the memory loop.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { runAgent } from "../agent/orchestrator";
import { createModel } from "../llm";
import { applyFeedback } from "../memory/learn";
import { listDrafts } from "../memory/store";
import { createSearchProvider } from "../tools/search";
import type { AgentEvent, Verdict } from "../types";
import { readJson } from "./util";

const MAX_INPUT_CHARS = 8000;

export const agentRoutes = new Hono<{ Bindings: Env }>();

agentRoutes.post("/generate", async (c) => {
  const body = await readJson<{ input: string }>(c);
  const input = (body.input ?? "").trim();

  if (!input) return c.json({ error: "Send something to write about." }, 400);
  if (input.length > MAX_INPUT_CHARS) {
    return c.json({ error: `Input is too long (max ${MAX_INPUT_CHARS} characters).` }, 400);
  }

  const { model } = createModel(c.env);
  const search = createSearchProvider(c.env);

  return streamSSE(c, async (stream) => {
    const emit = async (event: AgentEvent) => {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    };

    try {
      await runAgent({ env: c.env, db: c.env.DB, model, search, input, emit });
    } catch (err) {
      console.error("generate failed", err);
      await emit({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong while writing.",
      });
    }
  });
});

agentRoutes.post("/feedback", async (c) => {
  const body = await readJson<{ draftId: string; verdict: string; finalText: string; note: string }>(c);

  const verdicts: Verdict[] = ["posted", "edited", "rejected"];
  if (!body.draftId || !verdicts.includes(body.verdict as Verdict)) {
    return c.json({ error: "draftId and a verdict of posted | edited | rejected are required." }, 400);
  }

  const { model } = createModel(c.env);
  const result = await applyFeedback(c.env.DB, model, {
    draftId: body.draftId,
    verdict: body.verdict as Verdict,
    finalText: body.finalText,
    note: body.note,
  });

  if (!result.recorded) return c.json({ error: "No such draft." }, 404);
  return c.json(result);
});

agentRoutes.get("/history", async (c) => {
  const rows = await listDrafts(c.env.DB, 30);
  return c.json({
    drafts: rows.map((d) => ({
      id: d.id,
      input: d.input,
      format: d.format,
      verdict: d.verdict,
      createdAt: d.created_at,
      variants: safeParse(d.variants_json),
    })),
  });
});

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
