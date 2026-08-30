/**
 * The agent pipeline.
 *
 *   understand -> resolve links -> research -> recall memory
 *              -> choose format -> draft -> critique -> save
 *
 * Each stage emits an event so the UI can show what the agent is doing rather
 * than a spinner. Stages that can fail without sinking the run (link reading,
 * research, critique) degrade to a warning instead of an error.
 *
 * There is a second, much shorter path. When the user hands over a source to be
 * read or learned rather than posted about, the run stops after reading it:
 *
 *   resolve links -> distill -> (learn) -> save the turn
 *
 * Sources gathered either way stay with the session, so a link read on one turn
 * is still context three turns later without being fetched again.
 */

import type { ResolvedConfig } from "../config/settings";
import { type ChatModel, parseJson } from "../llm";
import { learnFromInstruction, studySource } from "../memory/learn";
import {
  getFormatStats,
  getProfile,
  pickSamples,
  recentFormats,
  relevantNotes,
  relevantPreferences,
  saveDraft,
  saveStudyTurn,
} from "../memory/store";
import { fetchUrlAsText } from "../tools/fetch-url";
import type { SearchProvider } from "../tools/search";
import { createTranscriptProvider } from "../tools/transcript";
import { extractUrls, parseXUrl, readXPost } from "../tools/x";
import { parseYouTubeUrl, readYouTubeVideo } from "../tools/youtube";
import type {
  AgentEvent,
  GenerateResult,
  OutputMode,
  SourceDoc,
  StudyMode,
  StudyResult,
  Understanding,
  Variant,
} from "../types";
import { weightedLength } from "./chars";
import { type StudyIntent, detectStudyIntent } from "./intent";
import {
  FORMATS,
  REPLY_FORMAT,
  clampVariants,
  formatById,
  formatLabel,
  varietyBrief,
  variantCount,
} from "./formats";
import {
  CRITIQUE_SCHEMA,
  DRAFT_SCHEMA,
  FORMAT_SCHEMA,
  REFINE_SCHEMA,
  type RefineTurn,
  type ReplyTarget,
  UNDERSTAND_SCHEMA,
  critiquePrompt,
  draftPrompt,
  formatPrompt,
  refinePrompt,
  replyPrompt,
  systemFor,
  understandPrompt,
  voiceBrief,
} from "./prompts";
import { type RouteDecision, detectMode } from "./route";
import { replyProblems } from "./reply";

export type Emit = (event: AgentEvent) => void | Promise<void>;

const MAX_LINKS = 3;
const MAX_SEARCH_RESULTS = 4;

export interface RunOptions {
  cfg: ResolvedConfig;
  db: D1Database;
  model: ChatModel;
  search: SearchProvider | null;
  input: string;
  sessionId: string;
  /**
   * Post or reply, already decided.
   *
   * Routed by the caller so an unanswerable request -- "reply" with no status
   * link -- fails as a 400 before the stream opens, rather than as an error
   * event halfway through a run. Absent on a refine turn, which inherits the
   * mode from the session instead of re-deciding it.
   */
  route?: RouteDecision | null;
  /** Prior turns in this session. Non-empty means refine rather than start fresh. */
  history?: RefineTurn[];
  /** Sources already gathered in this session, reused instead of re-fetched. */
  priorSources?: SourceDoc[];
  /** Topics established earlier in the session, used to recall relevant notes. */
  priorTopics?: string[];
  emit: Emit;
}

export async function runAgent(opts: RunOptions): Promise<GenerateResult | StudyResult> {
  const rawUrls = extractUrls(opts.input);
  const intent = detectStudyIntent(opts.input, {
    hasUrl: rawUrls.length > 0,
    hasSources: Boolean(opts.priorSources?.length),
  });

  // "Read this" and "learn from this" end here; "learn from this and write a
  // thread" falls through to the pipeline and learns once the drafts are out.
  if (intent && !intent.alsoWrite) return await runStudy(opts, intent.mode, rawUrls);

  if (opts.history?.length) return await runRefine(opts, opts.history, intent);

  const { cfg, db, model, search, input, sessionId, emit } = opts;
  const warnings: string[] = [];

  // Decided before anything else runs, and never revisited: a post and a reply
  // are different things to write, and every stage below needs to know which
  // one it is working on. The caller normally routes first so a bad request
  // fails as a 400; this is the fallback for a direct call.
  const route = opts.route ?? detectMode(input);
  const mode = route.mode;

  const ask = async (task: string, prompt: string, schema: object) =>
    await model.complete(
      [
        { role: "system", content: systemFor(task) },
        { role: "user", content: prompt },
      ],
      { task, jsonSchema: schema as Record<string, unknown>, maxTokens: 4000 },
    );

  /* ------------------------------ understand ----------------------------- */

  await emit({ type: "step", step: "understand", label: "Reading your input" });

  let understanding: Understanding = {
    kind: rawUrls.length ? (rawUrls.some((u) => parseXUrl(u)) ? "x_post" : "link") : "idea",
    mode,
    inReplyToId: route.inReplyToId,
    intent: input.slice(0, 200),
    topics: [],
    claims: [],
    urls: rawUrls,
    directions: [],
    needs_research: false,
    research_queries: [],
  };

  try {
    const parsed = parseJson<Partial<Understanding>>(
      await ask("understand", understandPrompt(input), UNDERSTAND_SCHEMA),
    );
    if (parsed) {
      understanding = {
        ...understanding,
        ...parsed,
        // Trust our own URL extraction over the model's.
        urls: rawUrls.length ? rawUrls : (parsed.urls ?? []),
        topics: parsed.topics ?? [],
        claims: parsed.claims ?? [],
        directions: parsed.directions ?? [],
        research_queries: parsed.research_queries ?? [],
        // The router owns these. The model is asked to classify the input, and
        // is not allowed to change what the turn produces by getting creative.
        mode,
        inReplyToId: route.inReplyToId,
      };
    }
  } catch (err) {
    warnings.push(`Could not analyse the input (${errText(err)}); continuing with defaults.`);
  }

  /* ------------------------------- resolve ------------------------------- */

  // Anything already read in this session counts, even though this is the first
  // draft: a session can open with "read this" and only later ask for a post.
  const carried = opts.priorSources ?? [];
  const sources: SourceDoc[] = [...carried];
  const known = new Set(carried.map((s) => s.url));
  const toRead = understanding.urls.filter((u) => !known.has(u));

  if (toRead.length) {
    await emit({
      type: "step",
      step: "resolve",
      label: "Opening your link" + (toRead.length > 1 ? "s" : ""),
      detail: toRead.slice(0, MAX_LINKS).join(", "),
    });

    const { docs, failed } = await readLinks(cfg, toRead, known);
    sources.push(...docs);
    for (const url of failed) {
      warnings.push(`Couldn't read ${url} -- drafting from your text alone.`);
    }
  }
  // Only what this turn fetched is stored on this turn's row; the session
  // reassembles the full set by walking its turns.
  const fetched = sources.slice(carried.length);

  /* ------------------------------- research ------------------------------ */

  // A reply answers the post above it from what is already on screen. Sending it
  // off to search turns a conversational answer into a briefing.
  if (mode === "post" && understanding.needs_research && understanding.research_queries.length) {
    if (search) {
      await emit({
        type: "step",
        step: "research",
        label: "Searching for context",
        detail: understanding.research_queries.join(" | "),
      });
      for (const query of understanding.research_queries.slice(0, 2)) {
        try {
          const results = await search.search(query, MAX_SEARCH_RESULTS);
          sources.push(...results);
        } catch (err) {
          warnings.push(`Search failed for "${query}" (${errText(err)}).`);
        }
      }
    } else {
      warnings.push(
        "This would benefit from current information, but no search provider is configured (set SEARCH_PROVIDER and SEARCH_API_KEY).",
      );
    }
  }

  if (sources.length) await emit({ type: "sources", sources });

  /* -------------------------------- recall ------------------------------- */

  await emit({ type: "step", step: "recall", label: "Recalling how you write" });

  const [profileRecord, samples, notes, recent, stats] = await Promise.all([
    getProfile(db),
    pickSamples(db, { topics: understanding.topics, limit: 6 }),
    relevantNotes(db, [...understanding.topics, ...(opts.priorTopics ?? [])]),
    recentFormats(db, 8),
    getFormatStats(db),
  ]);
  const profile = profileRecord.profile;
  const maxChars = clampMaxChars(cfg, profile.max_chars);

  /* ------------------------- choose what to write ------------------------ */

  let formatId: string;
  let alternate: string | null = null;
  let rationale: string;
  let target: ReplyTarget | null = null;

  if (mode === "reply") {
    // No format chooser: the shape of a reply is set by the post it answers.
    formatId = REPLY_FORMAT;
    rationale = route.why;
    target = replyTarget(route, sources);

    if (!target.text) {
      warnings.push(
        `Couldn't read the post you're replying to (${route.target?.url ?? "the X link"}). ` +
          "The reply is written from your instruction alone -- check it against the original before sending.",
      );
    }

    await emit({ type: "format", format: formatId, label: "Reply", rationale });
  } else {
    await emit({ type: "step", step: "format", label: "Choosing a format" });

    formatId = understanding.kind === "idea" ? "observation" : "quote_reaction";
    rationale = "Fallback choice -- the format step did not return a usable answer.";

    try {
      const choice = parseJson<{ format: string; alternate: string; rationale: string }>(
        await ask(
          "choose_format",
          formatPrompt(input, understanding, varietyBrief(recent, stats)),
          FORMAT_SCHEMA,
        ),
      );
      if (choice && formatById(choice.format)) {
        formatId = choice.format;
        alternate = formatById(choice.alternate) ? choice.alternate : null;
        rationale = choice.rationale || rationale;
      }
    } catch (err) {
      warnings.push(`Format selection failed (${errText(err)}); used a default.`);
    }

    await emit({
      type: "format",
      format: formatId,
      label: formatLabel(formatId),
      rationale,
    });
  }

  /* -------------------------------- draft -------------------------------- */

  await emit({
    type: "step",
    step: "draft",
    label:
      mode === "reply"
        ? `Writing one reply${target?.handle ? ` to @${target.handle}` : ""}`
        : `Writing the ${formatLabel(formatId).toLowerCase()}`,
  });

  // Topic-scoped rules only fire on their own topic; a rule set while writing
  // about pricing has no business shaping a post about anything else.
  const prefs = await relevantPreferences(
    db,
    mode === "reply" ? null : formatId,
    understanding.topics,
  );
  const brief = voiceBrief(profile, prefs, samples, profileRecord.handle);
  const want = variantCount(formatId, mode);

  const draftRaw = await ask(
    "draft",
    mode === "reply" && target
      ? replyPrompt(input, understanding, brief, target, sources, notes, maxChars)
      : draftPrompt(input, understanding, formatId, brief, sources, notes, maxChars, want),
    DRAFT_SCHEMA,
  );
  let variants = clampVariants(toVariants(parseJson<{ variants: unknown }>(draftRaw)?.variants), want);

  if (!variants.length) {
    throw new Error(
      mode === "reply"
        ? "The model did not return a usable reply."
        : "The model did not return any usable drafts.",
    );
  }

  /* ------------------------------- critique ------------------------------ */

  await emit({ type: "step", step: "critique", label: "Checking it against your rules" });

  variants = await critique({
    ask,
    brief,
    directions: understanding.directions,
    variants,
    want,
    maxChars,
    mode,
    target,
    warnings,
  });

  // Length is checked here rather than trusted from the model, and by X's own
  // weighted count rather than by code points.
  for (const variant of variants) {
    for (const [i, part] of variant.parts.entries()) {
      part.chars = weightedLength(part.text);
      if (part.chars > maxChars) {
        warnings.push(
          `${mode === "reply" ? "The reply" : `Variant part ${i + 1}`} is ${part.chars} characters by X's count, over your ${maxChars} limit.`,
        );
      }
    }
  }

  /* --------------------------------- save -------------------------------- */

  const draftId = crypto.randomUUID();
  await saveDraft(db, {
    id: draftId,
    sessionId,
    input,
    inputKind: understanding.kind,
    outputType: mode,
    inReplyToId: route.inReplyToId,
    format: formatId,
    variants,
    context: { sources: fetched, understanding },
    rationale,
  });

  const result: GenerateResult = {
    draftId,
    sessionId,
    mode,
    inReplyToId: route.inReplyToId,
    refined: false,
    format: formatId,
    formatLabel: formatLabel(formatId),
    formatRationale: rationale,
    alternateFormat: alternate,
    variants,
    sources,
    understanding,
    warnings: [...new Set(warnings)],
  };

  await emit({ type: "result", result });

  // They said "learn from this and write me a thread". The drafts are out, so
  // the slower half can run now without holding them up.
  if (intent?.mode === "learn") {
    await learnFromSources(opts, sources, input);
  }

  return result;
}

/* -------------------------------- critique -------------------------------- */

interface CritiqueRun {
  ask: (task: string, prompt: string, schema: object) => Promise<string>;
  brief: string;
  directions: string[];
  variants: Variant[];
  want: 1 | 2;
  maxChars: number;
  mode: OutputMode;
  target: ReplyTarget | null;
  /** Appended to in place; anything left unfixed becomes something the user is told. */
  warnings: string[];
}

/**
 * The self-check, plus a repair pass for replies.
 *
 * A post is checked once, by the model, against the voice brief. A reply gets a
 * second, mechanical check on top, because the ways a reply goes wrong --
 * restating the parent, complimenting it, opening with the handle, ending on a
 * farmed question -- are exactly the ways an LLM writes one, and a model asked
 * to review its own output will pass all of them. So the faults are found in
 * code, named, and handed back for one repair pass.
 *
 * Whatever survives that becomes a warning rather than a silent pass. The user
 * is the one sending it; they get told what is wrong with it.
 */
async function critique(run: CritiqueRun): Promise<Variant[]> {
  const { ask, mode, target, maxChars, want } = run;
  let variants = run.variants;

  const faults = (list: Variant[]): string[] =>
    mode === "reply"
      ? list.flatMap((v) =>
          replyProblems(v.parts.map((p) => p.text).join("\n"), {
            parentText: target?.text ?? "",
            maxChars,
          }),
        )
      : [];

  let problems = faults(variants);

  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const review = parseJson<{ variants: unknown; warnings?: string[] }>(
        await ask(
          "critique",
          critiquePrompt({
            brief: run.brief,
            directions: run.directions,
            draftsJson: JSON.stringify({ variants }, null, 2),
            maxChars,
            mode,
            parentText: target?.text,
            problems,
          }),
          CRITIQUE_SCHEMA,
        ),
      );
      if (review) {
        const revised = clampVariants(toVariants(review.variants), want);
        if (revised.length) variants = revised;
        if (Array.isArray(review.warnings)) {
          run.warnings.push(...review.warnings.filter((w) => typeof w === "string" && w.trim()));
        }
      }
    } catch (err) {
      run.warnings.push(`Self-check skipped (${errText(err)}).`);
      return variants;
    }

    problems = faults(variants);
    // A post gets one pass; a clean reply is done; only a reply that is still
    // wrong is worth spending a second call on.
    if (!problems.length) break;
  }

  for (const problem of problems) {
    run.warnings.push(`This still reads like reply slop and I couldn't fix it: ${problem}`);
  }

  return variants;
}

/**
 * The post being replied to, as the reply prompt needs it.
 *
 * The parent is normally among the sources -- the resolve stage fetched it like
 * any other link. When it isn't (deleted, protected, X rate-limiting the
 * reader), the id from the URL is still enough to thread the reply correctly,
 * so the run continues with an empty parent and a warning rather than failing.
 */
function replyTarget(route: RouteDecision, sources: SourceDoc[]): ReplyTarget {
  const id = route.inReplyToId;
  const parent = sources.find(
    (s) =>
      s.kind === "x_post" &&
      ((route.target !== null && s.url === route.target.url) ||
        (id !== null && s.url.endsWith(`/${id}`))),
  );
  return {
    handle: (route.target?.handle || parent?.author || "").replace(/^@/, ""),
    id: id ?? "",
    text: parent?.text ?? "",
  };
}

/**
 * A follow-up turn.
 *
 * Skips understanding and format selection -- the session already established
 * those -- and reuses the sources it gathered. Only genuinely new links in the
 * instruction are fetched.
 */
async function runRefine(
  opts: RunOptions,
  history: RefineTurn[],
  intent: StudyIntent | null,
): Promise<GenerateResult> {
  const { cfg, db, model, input, sessionId, emit } = opts;
  const warnings: string[] = [];
  const carried = opts.priorSources ?? [];
  const sources: SourceDoc[] = [...carried];

  const ask = async (task: string, prompt: string, schema: object) =>
    await model.complete(
      [
        { role: "system", content: systemFor(task) },
        { role: "user", content: prompt },
      ],
      { task, jsonSchema: schema as Record<string, unknown>, maxTokens: 4000 },
    );

  const previous = history[history.length - 1];

  // The session already decided this, and a follow-up never changes it. Losing
  // it was the bug where "make it shorter" on a reply session came back as a
  // standalone post with no one to send it to.
  const mode = previous.mode;

  // Only fetch links this turn introduced; the rest are already in context.
  const known = new Set(sources.map((s) => s.url));
  const fresh = extractUrls(input).filter((u) => !known.has(u));
  if (fresh.length) {
    await emit({
      type: "step",
      step: "resolve",
      label: "Opening the new link" + (fresh.length > 1 ? "s" : ""),
      detail: fresh.slice(0, MAX_LINKS).join(", "),
    });
    const { docs, failed } = await readLinks(cfg, fresh, known);
    sources.push(...docs);
    for (const url of failed) warnings.push(`Couldn't read ${url}.`);
    await emit({ type: "sources", sources });
  }
  const fetched = sources.slice(carried.length);

  await emit({ type: "step", step: "recall", label: "Recalling how you write" });

  const topics = opts.priorTopics ?? [];
  const [profileRecord, samples, notes] = await Promise.all([
    getProfile(db),
    pickSamples(db, { topics, format: previous.format, limit: 6 }),
    relevantNotes(db, topics),
  ]);
  const profile = profileRecord.profile;
  const maxChars = clampMaxChars(cfg, profile.max_chars);
  const prefs = await relevantPreferences(
    db,
    mode === "reply" ? null : previous.format,
    topics,
  );
  const brief = voiceBrief(profile, prefs, samples, profileRecord.handle);

  // The parent is somewhere in the session's sources; a reply refined three
  // turns later is still checked against the post it goes under.
  const target =
    mode === "reply"
      ? replyTarget(
          {
            mode,
            inReplyToId: previous.inReplyToId,
            target: null,
            why: "",
          },
          sources,
        )
      : null;

  await emit({
    type: "step",
    step: "refine",
    label: mode === "reply" ? "Reworking the reply" : "Reworking the draft",
  });

  const want = variantCount(previous.format, mode);

  const parsed = parseJson<{ format?: string; changed?: string; variants?: unknown }>(
    await ask(
      "refine",
      refinePrompt(brief, history, input, sources, notes, maxChars, mode, target, want),
      REFINE_SCHEMA,
    ),
  );
  let variants = clampVariants(toVariants(parsed?.variants), want);
  if (!variants.length) throw new Error("The model did not return a usable revision.");

  // A reply keeps its pseudo-format however the model answers: there is no
  // format to switch to that would still be a reply.
  const formatId =
    mode === "reply"
      ? REPLY_FORMAT
      : parsed?.format && formatById(parsed.format)
        ? parsed.format
        : previous.format;
  const rationale = parsed?.changed?.trim() || "Applied your change.";

  if (formatId !== previous.format) {
    await emit({
      type: "format",
      format: formatId,
      label: formatLabel(formatId),
      rationale,
    });
  }

  await emit({ type: "step", step: "critique", label: "Checking it against your rules" });

  variants = await critique({
    ask,
    brief,
    // On a refine turn the whole instruction is the direction.
    directions: [input],
    variants,
    want: variantCount(formatId, mode),
    maxChars,
    mode,
    target,
    warnings,
  });

  for (const variant of variants) {
    for (const [i, part] of variant.parts.entries()) {
      part.chars = weightedLength(part.text);
      if (part.chars > maxChars) {
        warnings.push(
          `${mode === "reply" ? "The reply" : `Variant part ${i + 1}`} is ${part.chars} characters by X's count, over your ${maxChars} limit.`,
        );
      }
    }
  }

  const draftId = crypto.randomUUID();
  await saveDraft(db, {
    id: draftId,
    sessionId,
    input,
    // Carried, not reset. A session that opened on an X link is still an X-link
    // session on turn four, and the memory recalled for it depends on that.
    inputKind: previous.kind,
    outputType: mode,
    inReplyToId: previous.inReplyToId,
    format: formatId,
    variants,
    context: { sources: fetched },
    rationale,
  });

  const result: GenerateResult = {
    draftId,
    sessionId,
    mode,
    inReplyToId: previous.inReplyToId,
    refined: true,
    format: formatId,
    formatLabel: formatLabel(formatId),
    formatRationale: rationale,
    alternateFormat: null,
    variants,
    sources,
    understanding: {
      kind: previous.kind,
      mode,
      inReplyToId: previous.inReplyToId,
      intent: input,
      topics,
      claims: [],
      urls: [],
      // On a refine turn the whole instruction is the direction.
      directions: [input],
      needs_research: false,
      research_queries: [],
    },
    warnings: [...new Set(warnings)],
  };

  await emit({ type: "result", result });

  if (intent?.mode === "learn") {
    await learnFromSources(opts, sources, input);
  }

  // Only refine turns are mined for preferences: the opening message is the
  // idea itself, while follow-ups are where the user says how they want it
  // written. Runs after the result so drafts are never held up by it.
  try {
    const learned = await learnFromInstruction(db, model, input);
    if (learned.rules.length || learned.profile.length) {
      await emit({ type: "learned", learned });
    }
  } catch {
    // Never let learning break a turn that already produced drafts.
  }

  return result;
}

/* --------------------------------- study --------------------------------- */

/**
 * The read path: take the source in, write no post.
 *
 * "read" ends at a digest the user can see, with the source kept for the rest of
 * the session. "learn" does the same and commits what is worth keeping, which is
 * the only place in the agent where memory is written without a draft existing
 * first -- so everything it writes is listed with an undo next to it.
 */
async function runStudy(
  opts: RunOptions,
  mode: StudyMode,
  urls: string[],
): Promise<StudyResult> {
  const { cfg, db, model, input, sessionId, emit } = opts;
  const warnings: string[] = [];

  const carried = opts.priorSources ?? [];
  const sources: SourceDoc[] = [...carried];
  const known = new Set(carried.map((s) => s.url));
  const toRead = urls.filter((u) => !known.has(u));

  if (toRead.length) {
    await emit({
      type: "step",
      step: "resolve",
      label: toRead.length > 1 ? "Opening your links" : "Opening your link",
      detail: toRead.slice(0, MAX_LINKS).join(", "),
    });
    const { docs, failed } = await readLinks(cfg, toRead, known);
    sources.push(...docs);
    for (const url of failed) warnings.push(`Couldn't read ${url}.`);
  }
  const fetched = sources.slice(carried.length);

  if (!sources.length) {
    throw new Error(
      toRead.length
        ? `Couldn't read ${toRead[0]} -- it may be paywalled, rendered by JavaScript, or blocking readers.`
        : "There's nothing in this session to read yet. Send a link first.",
    );
  }

  await emit({ type: "sources", sources });
  await emit({
    type: "step",
    step: "study",
    label: mode === "learn" ? "Reading it, and deciding what to keep" : "Reading it closely",
  });

  const digest = await studySource(db, model, { instruction: input, sources, mode });

  const turnId = crypto.randomUUID();
  const result: StudyResult = {
    turnId,
    sessionId,
    mode,
    sources,
    summary: digest.summary,
    takeaways: digest.takeaways,
    angles: digest.angles,
    topics: digest.topics,
    learned: digest.learned,
    warnings: [...new Set(warnings)],
  };

  // The whole digest goes in the row so reopening the session shows what was
  // read, not just that something was. Sources follow the same rule as drafts:
  // only what this turn fetched, because the session reassembles the rest.
  const { sources: _replayed, ...stored } = result;
  await saveStudyTurn(db, {
    id: turnId,
    sessionId,
    input,
    summary: digest.summary,
    context: { sources: fetched, study: stored },
  });

  await emit({ type: "studied", result });
  return result;
}

/**
 * Distil the session's sources into memory alongside a draft.
 *
 * Runs after the result is out, for "learn from this and write me a post". The
 * user has their drafts either way, so a failure here is reported and dropped
 * rather than allowed to take the turn down with it.
 */
async function learnFromSources(
  opts: RunOptions,
  sources: SourceDoc[],
  instruction: string,
): Promise<void> {
  // Search snippets are the agent's own lookups, not something the user handed
  // over to be learned.
  const given = sources.filter((s) => s.kind !== "search");
  if (!given.length) return;

  await opts.emit({ type: "step", step: "study", label: "Deciding what to keep" });

  try {
    const { learned } = await studySource(opts.db, opts.model, {
      instruction,
      sources: given,
      mode: "learn",
    });
    if (learned.rules.length || learned.notes.length || learned.profile.length) {
      await opts.emit({ type: "learned", learned });
    }
  } catch (err) {
    await opts.emit({
      type: "error",
      message: `Your drafts are fine, but I couldn't distil the source into memory (${errText(err)}).`,
    });
  }
}

/**
 * Read the links this turn introduced.
 *
 * X posts go through the X reader, everything else through the HTML reader. A
 * link that will not open is a warning rather than a failure -- the user's own
 * words are usually enough to work from.
 */
export async function readLinks(
  cfg: ResolvedConfig,
  urls: string[],
  known: Set<string>,
): Promise<{ docs: SourceDoc[]; failed: string[] }> {
  const fresh = [...new Set(urls)].filter((u) => !known.has(u)).slice(0, MAX_LINKS);
  const docs: SourceDoc[] = [];
  const failed: string[] = [];
  // Null unless one is configured, which is the deployed instance's only way to
  // read a video at all -- see the note at the top of `transcript.ts`.
  const transcripts = createTranscriptProvider(cfg);

  const resolved = await Promise.all(
    fresh.map(async (url) => {
      const xRef = parseXUrl(url);
      if (xRef) return await readXPost(xRef, cfg.xBearerToken || undefined);

      // A watch page read as HTML is chrome -- "Subscribe", "Sign in" -- and
      // none of the talk, so there is no falling back to it when the captions
      // don't come. Better to report the link as unread than to draft a post
      // from YouTube's furniture.
      const ytRef = parseYouTubeUrl(url);
      if (ytRef) return await readYouTubeVideo(ytRef, transcripts);

      return await fetchUrlAsText(url);
    }),
  );

  for (const [i, doc] of resolved.entries()) {
    if (doc) docs.push(doc);
    else failed.push(fresh[i]);
  }
  return { docs, failed };
}

/* -------------------------------- helpers -------------------------------- */

/** Tolerates the several shapes a model might return for `variants`. */
function toVariants(raw: unknown): Variant[] {
  if (!Array.isArray(raw)) return [];
  const out: Variant[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as { parts?: unknown; text?: unknown; angle?: unknown };

    let texts: string[] = [];
    if (Array.isArray(v.parts)) {
      texts = v.parts
        .map((p) =>
          typeof p === "string"
            ? p
            : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
              ? (p as { text: string }).text
              : "",
        )
        .filter((t) => t.trim());
    } else if (typeof v.text === "string") {
      texts = [v.text];
    }
    if (!texts.length) continue;

    out.push({
      parts: texts.map((t) => ({ text: t.trim(), chars: weightedLength(t.trim()) })),
      angle: typeof v.angle === "string" ? v.angle : "",
    });
  }
  return out;
}

/** The style profile wins; the configured value is only the default for a fresh profile. */
function clampMaxChars(cfg: ResolvedConfig, profileValue: number): number {
  if (profileValue > 0) return profileValue;
  return cfg.maxPostChars > 0 ? cfg.maxPostChars : 280;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exposed for /api/config so the UI can show what the agent can pick from. */
export function formatSummaries() {
  return FORMATS.map((f) => ({ id: f.id, label: f.label, whenToUse: f.whenToUse }));
}
