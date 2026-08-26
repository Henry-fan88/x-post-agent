/**
 * The agent pipeline.
 *
 *   understand -> resolve links -> research -> recall memory
 *              -> choose format -> draft -> critique -> save
 *
 * Each stage emits an event so the UI can show what the agent is doing rather
 * than a spinner. Stages that can fail without sinking the run (link reading,
 * research, critique) degrade to a warning instead of an error.
 */

import { type ChatModel, parseJson } from "../llm";
import {
  getFormatStats,
  getProfile,
  pickSamples,
  recentFormats,
  relevantPreferences,
  saveDraft,
} from "../memory/store";
import { fetchUrlAsText } from "../tools/fetch-url";
import type { SearchProvider } from "../tools/search";
import { extractUrls, parseXUrl, readXPost } from "../tools/x";
import type {
  AgentEvent,
  GenerateResult,
  SourceDoc,
  Understanding,
  Variant,
} from "../types";
import { FORMATS, formatById, formatLabel, varietyBrief } from "./formats";
import {
  AGENT_ROLE,
  CRITIQUE_SCHEMA,
  DRAFT_SCHEMA,
  FORMAT_SCHEMA,
  UNDERSTAND_SCHEMA,
  critiquePrompt,
  draftPrompt,
  formatPrompt,
  understandPrompt,
  voiceBrief,
} from "./prompts";

export type Emit = (event: AgentEvent) => void | Promise<void>;

const MAX_LINKS = 3;
const MAX_SEARCH_RESULTS = 4;

/** X weights some characters differently; code points are the closest cheap approximation. */
export function countChars(text: string): number {
  return [...text].length;
}

export async function runAgent(opts: {
  env: Env;
  db: D1Database;
  model: ChatModel;
  search: SearchProvider | null;
  input: string;
  emit: Emit;
}): Promise<GenerateResult> {
  const { env, db, model, search, input, emit } = opts;
  const warnings: string[] = [];

  const ask = async (task: string, prompt: string, schema: object) =>
    await model.complete(
      [
        { role: "system", content: AGENT_ROLE },
        { role: "user", content: prompt },
      ],
      { task, jsonSchema: schema as Record<string, unknown>, maxTokens: 4000 },
    );

  /* ------------------------------ understand ----------------------------- */

  await emit({ type: "step", step: "understand", label: "Reading your input" });

  const rawUrls = extractUrls(input);
  let understanding: Understanding = {
    kind: rawUrls.length ? (rawUrls.some((u) => parseXUrl(u)) ? "x_post" : "link") : "idea",
    intent: input.slice(0, 200),
    topics: [],
    claims: [],
    urls: rawUrls,
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
        research_queries: parsed.research_queries ?? [],
      };
    }
  } catch (err) {
    warnings.push(`Could not analyse the input (${errText(err)}); continuing with defaults.`);
  }

  /* ------------------------------- resolve ------------------------------- */

  const sources: SourceDoc[] = [];

  if (understanding.urls.length) {
    await emit({
      type: "step",
      step: "resolve",
      label: "Opening your link" + (understanding.urls.length > 1 ? "s" : ""),
      detail: understanding.urls.slice(0, MAX_LINKS).join(", "),
    });

    const resolved = await Promise.all(
      understanding.urls.slice(0, MAX_LINKS).map(async (url) => {
        const xRef = parseXUrl(url);
        return xRef
          ? await readXPost(xRef, env.X_BEARER_TOKEN)
          : await fetchUrlAsText(url);
      }),
    );

    for (const [i, doc] of resolved.entries()) {
      if (doc) sources.push(doc);
      else warnings.push(`Couldn't read ${understanding.urls[i]} -- drafting from your text alone.`);
    }
  }

  /* ------------------------------- research ------------------------------ */

  if (understanding.needs_research && understanding.research_queries.length) {
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

  const [profileRecord, samples, recent, stats] = await Promise.all([
    getProfile(db),
    pickSamples(db, { topics: understanding.topics, limit: 6 }),
    recentFormats(db, 8),
    getFormatStats(db),
  ]);
  const profile = profileRecord.profile;
  const maxChars = clampMaxChars(env, profile.max_chars);

  /* ---------------------------- choose format ---------------------------- */

  await emit({ type: "step", step: "format", label: "Choosing a format" });

  let formatId = understanding.kind === "idea" ? "observation" : "quote_reaction";
  let alternate: string | null = null;
  let rationale = "Fallback choice -- the format step did not return a usable answer.";

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

  /* -------------------------------- draft -------------------------------- */

  await emit({ type: "step", step: "draft", label: `Writing the ${formatLabel(formatId).toLowerCase()}` });

  const prefs = await relevantPreferences(db, formatId);
  const brief = voiceBrief(profile, prefs, samples, profileRecord.handle);

  const draftRaw = await ask(
    "draft",
    draftPrompt(input, understanding, formatId, brief, sources, maxChars),
    DRAFT_SCHEMA,
  );
  let variants = toVariants(parseJson<{ variants: unknown }>(draftRaw)?.variants);

  if (!variants.length) {
    throw new Error("The model did not return any usable drafts.");
  }

  /* ------------------------------- critique ------------------------------ */

  await emit({ type: "step", step: "critique", label: "Checking it against your rules" });

  try {
    const review = parseJson<{ variants: unknown; warnings?: string[] }>(
      await ask(
        "critique",
        critiquePrompt(brief, JSON.stringify({ variants }, null, 2), maxChars),
        CRITIQUE_SCHEMA,
      ),
    );
    if (review) {
      const revised = toVariants(review.variants);
      if (revised.length) variants = revised;
      if (Array.isArray(review.warnings)) {
        warnings.push(...review.warnings.filter((w) => typeof w === "string" && w.trim()));
      }
    }
  } catch (err) {
    warnings.push(`Self-check skipped (${errText(err)}).`);
  }

  // Length is checked here rather than trusted from the model.
  for (const variant of variants) {
    for (const [i, part] of variant.parts.entries()) {
      part.chars = countChars(part.text);
      if (part.chars > maxChars) {
        warnings.push(
          `Variant part ${i + 1} is ${part.chars} characters, over your ${maxChars} limit.`,
        );
      }
    }
  }

  /* --------------------------------- save -------------------------------- */

  const draftId = crypto.randomUUID();
  await saveDraft(db, {
    id: draftId,
    input,
    inputKind: understanding.kind,
    format: formatId,
    variants,
    context: { sources, understanding },
    rationale,
  });

  const result: GenerateResult = {
    draftId,
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
  return result;
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
      parts: texts.map((t) => ({ text: t.trim(), chars: countChars(t.trim()) })),
      angle: typeof v.angle === "string" ? v.angle : "",
    });
  }
  return out;
}

/** The style profile wins; MAX_POST_CHARS is only the default for a fresh profile. */
function clampMaxChars(env: Env, profileValue: number): number {
  if (profileValue > 0) return profileValue;
  const envValue = Number(env.MAX_POST_CHARS);
  return Number.isFinite(envValue) && envValue > 0 ? envValue : 280;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exposed for /api/config so the UI can show what the agent can pick from. */
export function formatSummaries() {
  return FORMATS.map((f) => ({ id: f.id, label: f.label, whenToUse: f.whenToUse }));
}
