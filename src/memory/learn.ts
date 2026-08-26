/**
 * Turning feedback into memory.
 *
 * A rejected draft moves the format's stats. An edited draft is more valuable:
 * the diff between what the agent wrote and what the user posted is a direct
 * signal about their voice, so we ask the model to name the rule behind it and
 * store the edited text as a writing sample.
 */

import { type ChatModel, parseJson } from "../llm";
import { AGENT_ROLE, EXTRACT_SCHEMA, LEARN_SCHEMA, extractPrefsPrompt, learnPrompt } from "../agent/prompts";
import type { Verdict } from "../types";
import {
  addPreference,
  addSamples,
  getDraft,
  getProfile,
  listPreferences,
  recordVerdict,
  saveProfile,
} from "./store";
import type { StyleProfile } from "../types";

export interface FeedbackInput {
  draftId: string;
  verdict: Verdict;
  /** The text the user actually posted. Required for "edited" to teach anything. */
  finalText?: string;
  note?: string;
}

export interface FeedbackResult {
  recorded: boolean;
  learned: string[];
  sampleAdded: boolean;
}

export async function applyFeedback(
  db: D1Database,
  model: ChatModel,
  input: FeedbackInput,
): Promise<FeedbackResult> {
  const draft = await getDraft(db, input.draftId);
  if (!draft) return { recorded: false, learned: [], sampleAdded: false };

  await recordVerdict(db, input);

  const learned: string[] = [];
  let sampleAdded = false;

  // Anything the user posted is, by definition, in their voice.
  const posted = input.finalText?.trim();
  if ((input.verdict === "posted" || input.verdict === "edited") && posted) {
    await addSamples(db, [{ text: posted, format: draft.format, source: "accepted_draft" }]);
    sampleAdded = true;
  }

  if (input.verdict === "edited" && posted) {
    const original = firstVariantText(draft.variants_json);
    if (original && original !== posted) {
      try {
        const parsed = parseJson<{ rules?: string[] }>(
          await model.complete(
            [
              { role: "system", content: AGENT_ROLE },
              { role: "user", content: learnPrompt(original, posted) },
            ],
            { task: "learn", jsonSchema: LEARN_SCHEMA as Record<string, unknown>, maxTokens: 1000 },
          ),
        );
        for (const rule of parsed?.rules ?? []) {
          if (typeof rule === "string" && rule.trim().length > 4) {
            await addPreference(db, { rule: rule.trim(), source: "inferred", weight: 0.75 });
            learned.push(rule.trim());
          }
        }
      } catch {
        // Learning is best-effort; the verdict is already recorded.
      }
    }
  }

  // An explicit note from the user is a stronger signal than anything inferred.
  const note = input.note?.trim();
  if (note && note.length > 4) {
    await addPreference(db, { rule: note, source: "user", weight: 1.5 });
    learned.push(note);
  }

  return { recorded: true, learned, sampleAdded };
}

function firstVariantText(variantsJson: string): string | null {
  try {
    const variants = JSON.parse(variantsJson) as { parts?: { text?: string }[] }[];
    const parts = variants?.[0]?.parts;
    if (!parts?.length) return null;
    return parts.map((p) => p.text ?? "").join("\n\n").trim() || null;
  } catch {
    return null;
  }
}


/* ------------------------ learning from the conversation ------------------ */

/** Below this, a rule is treated as a guess about this post rather than a preference. */
const DURABLE_CONFIDENCE = 0.7;

export interface LearnedItem {
  id: number;
  rule: string;
}

export interface ConversationLearning {
  rules: LearnedItem[];
  /** Profile fields changed, as human-readable strings for the UI. */
  profile: string[];
}

/**
 * Read the user's instruction for standing preferences and record them.
 *
 * Deliberately conservative: only high-confidence durable rules are kept, and
 * everything written here is `inferred` at low weight, listed in Settings, and
 * undoable by id. A wrong guess should cost one click to reverse.
 */
export async function learnFromInstruction(
  db: D1Database,
  model: ChatModel,
  instruction: string,
): Promise<ConversationLearning> {
  const empty: ConversationLearning = { rules: [], profile: [] };
  if (instruction.trim().length < 8) return empty;

  const existing = await listPreferences(db, { activeOnly: true });
  let parsed: {
    rules?: { rule?: string; durable?: boolean; confidence?: number }[];
    profile?: Partial<StyleProfile> | null;
  } | null = null;

  try {
    parsed = parseJson(
      await model.complete(
        [
          { role: "system", content: AGENT_ROLE },
          { role: "user", content: extractPrefsPrompt(instruction, existing.map((p) => p.rule)) },
        ],
        { task: "extract", jsonSchema: EXTRACT_SCHEMA as Record<string, unknown>, maxTokens: 800 },
      ),
    );
  } catch {
    return empty; // Learning is best-effort; never fail a turn over it.
  }
  if (!parsed) return empty;

  const learned: LearnedItem[] = [];
  const seen = new Set(existing.map((p) => p.rule.toLowerCase()));

  for (const candidate of parsed.rules ?? []) {
    const rule = candidate.rule?.trim();
    if (!rule || rule.length < 5) continue;
    if (candidate.durable !== true) continue;
    if (typeof candidate.confidence !== "number" || candidate.confidence < DURABLE_CONFIDENCE) continue;
    if (seen.has(rule.toLowerCase())) continue;

    seen.add(rule.toLowerCase());
    await addPreference(db, { rule, source: "inferred", weight: 0.75 });

    const row = await db
      .prepare("SELECT id FROM preferences WHERE lower(rule) = lower(?) ORDER BY id DESC LIMIT 1")
      .bind(rule)
      .first<{ id: number }>();
    if (row) learned.push({ id: row.id, rule });
  }

  // Profile policies the user stated outright (emoji, hashtags, and so on).
  const changed: string[] = [];
  const patch = parsed.profile;
  if (patch && typeof patch === "object") {
    const current = (await getProfile(db)).profile;
    const allowed: (keyof StyleProfile)[] = ["emoji", "hashtags", "capitalization", "max_chars"];
    const update: Partial<StyleProfile> = {};

    for (const key of allowed) {
      const value = patch[key];
      if (value === undefined || value === null) continue;
      if (current[key] === value) continue;
      (update as Record<string, unknown>)[key] = value;
      changed.push(`${key.replace("_", " ")} → ${value}`);
    }
    if (changed.length) await saveProfile(db, { profile: update });
  }

  return { rules: learned, profile: changed };
}
