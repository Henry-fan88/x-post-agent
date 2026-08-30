/**
 * Generation, reading, and feedback.
 *
 * /api/generate streams progress over SSE so the UI can show the agent's steps
 * rather than a spinner. /api/learn is the deliberate version of the same thing:
 * no guessing at intent, the user pressed a button. /api/feedback is what closes
 * the memory loop.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readLinks, runAgent } from "../agent/orchestrator";
import { type RouteDecision, RouteError, detectMode } from "../agent/route";
import { resolveConfig } from "../config/settings";
import { createModel } from "../llm";
import { applyFeedback, studySource } from "../memory/learn";
import {
  STUDY_KIND,
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
import type {
  AgentEvent,
  OutputMode,
  SourceDoc,
  StudyResult,
  Variant,
  Verdict,
} from "../types";
import type { RefineTurn } from "../agent/prompts";
import { readJson } from "./util";

const MAX_INPUT_CHARS = 8000;

export const agentRoutes = new Hono<{ Bindings: Env }>();

agentRoutes.post("/generate", async (c) => {
  const body = await readJson<{ input: string; sessionId: string; mode?: string }>(c);
  const input = (body.input ?? "").trim();

  if (!input) return c.json({ error: "Send something to write about." }, 400);
  if (input.length > MAX_INPUT_CHARS) {
    return c.json({ error: `Input is too long (max ${MAX_INPUT_CHARS} characters).` }, 400);
  }

  const modes: OutputMode[] = ["post", "reply"];
  if (body.mode !== undefined && !modes.includes(body.mode as OutputMode)) {
    return c.json({ error: 'mode must be "post" or "reply".' }, 400);
  }
  const explicit = (body.mode as OutputMode | undefined) ?? null;

  const db = c.env.DB;

  // An existing session id makes this a follow-up; otherwise start a new one.
  let sessionId = (body.sessionId ?? "").trim();
  let history: RefineTurn[] = [];
  let priorSources: SourceDoc[] = [];
  let priorTopics: string[] = [];
  let isNew = false;

  if (sessionId) {
    const existing = await getSession(db, sessionId);
    if (!existing) return c.json({ error: "No such session." }, 404);
    const turns = await sessionTurns(db, sessionId);
    // A study turn has no drafts to refine, but everything it read still counts
    // as context. A session that opens with "read this" therefore starts the
    // pipeline fresh rather than trying to revise a summary.
    history = turns.filter((t) => t.input_kind !== STUDY_KIND).map(toRefineTurn);
    priorSources = sourcesOf(turns);
    priorTopics = topicsOf(turns);
  }

  // Routed before the session is created, so "reply" with nothing to reply to is
  // a 400 the composer can show -- rather than an empty session in the sidebar
  // and an error event arriving after the UI has already selected it.
  //
  // A follow-up is not routed at all: it inherits the mode of the session it is
  // refining, and re-deciding it from "make it shorter" is how that gets lost.
  let route: RouteDecision | null = null;
  if (!history.length) {
    try {
      route = detectMode(input, explicit);
    } catch (err) {
      if (err instanceof RouteError) return c.json({ error: err.message }, 400);
      throw err;
    }
  }

  if (!sessionId) {
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
      await runAgent({
        cfg,
        db,
        model,
        search,
        input,
        sessionId,
        route,
        history,
        priorSources,
        priorTopics,
        emit,
      });
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

  // A row stores only the sources it fetched, so replay accumulates: what a turn
  // worked from is everything gathered up to and including it.
  const gathered = new Map<string, SourceDoc>();
  const sourcesUpTo = (row: DraftRow): SourceDoc[] => {
    for (const source of sourcesOfOne(row)) {
      if (source.url && !gathered.has(source.url)) gathered.set(source.url, source);
    }
    return [...gathered.values()];
  };

  return c.json({
    session,
    turns: turns.map((t) =>
      t.input_kind === STUDY_KIND
        ? {
            id: t.id,
            input: t.input,
            kind: STUDY_KIND,
            createdAt: t.created_at,
            study: studyOf(t),
            sources: sourcesUpTo(t),
          }
        : {
            id: t.id,
            input: t.input,
            kind: "draft",
            format: t.format,
            mode: t.output_type === "reply" ? "reply" : "post",
            inReplyToId: t.in_reply_to_id,
            rationale: t.rationale,
            verdict: t.verdict,
            createdAt: t.created_at,
            variants: parseVariants(t.variants_json),
            sources: sourcesUpTo(t),
          },
    ),
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

/* --------------------------------- learn --------------------------------- */

/**
 * Learn from one source, on purpose.
 *
 * The conversational path has to guess whether "read this" meant read or write;
 * this one doesn't, because the user pressed a button next to a specific source.
 * That makes it the escape hatch for any phrasing the detector misses, and the
 * way to keep something you only meant to read at the time.
 */
agentRoutes.post("/learn", async (c) => {
  const body = await readJson<{ sessionId: string; url: string; instruction: string }>(c);
  const url = (body.url ?? "").trim();
  const sessionId = (body.sessionId ?? "").trim();
  if (!url) return c.json({ error: "A url is required." }, 400);

  const db = c.env.DB;
  const cfg = await resolveConfig(c.env, db);

  // Prefer the copy the session already read: the page may have changed, and
  // the point is to learn what the user saw.
  let doc: SourceDoc | undefined;
  if (sessionId) {
    doc = sourcesOf(await sessionTurns(db, sessionId)).find((s) => s.url === url);
  }
  if (!doc) {
    const { docs } = await readLinks(cfg, [url], new Set());
    doc = docs[0];
  }
  if (!doc) {
    return c.json(
      { error: `Couldn't read ${url} -- it may be paywalled, rendered by JavaScript, or blocking readers.` },
      502,
    );
  }

  const { model } = createModel(cfg);
  try {
    const digest = await studySource(db, model, {
      instruction: body.instruction?.trim() || `Learn what matters from "${doc.title}".`,
      sources: [doc],
      mode: "learn",
    });
    return c.json({ source: { url: doc.url, title: doc.title }, ...digest });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Couldn't distil that source." },
      502,
    );
  }
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
  return {
    instruction: row.input,
    format: row.format,
    // Read off the row rather than re-derived from the text: by turn three the
    // instruction is "make it shorter", which says nothing about what is being
    // shortened.
    mode: row.output_type === "reply" ? "reply" : "post",
    inReplyToId: row.in_reply_to_id,
    kind: (row.input_kind as RefineTurn["kind"]) ?? "idea",
    variants: parseVariants(row.variants_json),
  };
}

function sourcesOfOne(row: DraftRow): SourceDoc[] {
  const ctx = safeParse(row.context_json) as { sources?: SourceDoc[] } | null;
  return Array.isArray(ctx?.sources) ? ctx.sources : [];
}

/** The digest a study turn produced, as it was shown when the turn ran. */
function studyOf(row: DraftRow): Partial<StudyResult> {
  const ctx = safeParse(row.context_json) as { study?: Partial<StudyResult> } | null;
  return ctx && typeof ctx === "object" && ctx.study ? ctx.study : { summary: row.rationale };
}

/**
 * What this session has been about.
 *
 * Drafts record the topics the understand stage settled on; study turns record
 * the ones the source turned out to cover. Both are how notes are recalled on a
 * later turn, when nobody re-runs the understand stage.
 */
function topicsOf(rows: DraftRow[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const ctx = safeParse(row.context_json) as {
      understanding?: { topics?: unknown };
      study?: { topics?: unknown };
    } | null;
    for (const list of [ctx?.understanding?.topics, ctx?.study?.topics]) {
      if (!Array.isArray(list)) continue;
      for (const topic of list) {
        if (typeof topic === "string" && topic.trim()) out.add(topic.trim().toLowerCase());
      }
    }
  }
  return [...out];
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
