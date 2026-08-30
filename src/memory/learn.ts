/**
 * Turning feedback and sources into memory.
 *
 * Three ways in. A rejected draft moves the format's stats. An edited draft is
 * more valuable: the diff between what the agent wrote and what the user posted
 * is a direct signal about their voice, so we ask the model to name the rule
 * behind it and store the edited text as a writing sample. And a source the user
 * says to learn from is distilled into notes -- and, only when they say the
 * source represents how they want to write, into rules and the profile.
 *
 * All of it is a guess, so all of it is reversible by id.
 */

import { type ChatModel, parseJson } from "../llm";
import {
  AGENT_ROLE,
  DISTILL_SCHEMA,
  EXTRACT_SCHEMA,
  LEARN_SCHEMA,
  distillPrompt,
  extractPrefsPrompt,
  learnPrompt,
} from "../agent/prompts";
import {
  type LearnedMemory,
  type ProfileChange,
  type SourceDoc,
  type StudyMode,
  type StyleProfile,
  type Verdict,
  emptyLearned,
} from "../types";
import {
  addNotes,
  addPreference,
  addSamples,
  getDraft,
  getProfile,
  listNotes,
  listPreferences,
  recordVerdict,
  saveProfile,
} from "./store";

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


/* -------------------------- shared: profile patches ----------------------- */

/**
 * Apply a partial profile update and describe what changed.
 *
 * Lists merge rather than replace -- learning should add a habit, not silently
 * drop the ones already recorded -- while scalars and the voice description are
 * overwritten. Every change carries its previous value, so the UI can put it
 * back with one click.
 */
async function applyProfilePatch(
  db: D1Database,
  patch: Partial<StyleProfile> | null | undefined,
  allowed: (keyof StyleProfile)[],
): Promise<ProfileChange[]> {
  if (!patch || typeof patch !== "object") return [];

  const current = (await getProfile(db)).profile;
  const update: Partial<StyleProfile> = {};
  const changes: ProfileChange[] = [];

  for (const field of allowed) {
    const incoming = patch[field];
    if (incoming === undefined || incoming === null) continue;

    const before = current[field];
    let after: unknown = incoming;

    if (Array.isArray(before)) {
      if (!Array.isArray(incoming)) continue;
      const merged = mergeList(
        before,
        incoming.filter((x): x is string => typeof x === "string"),
      );
      if (merged.length === before.length) continue; // nothing new in it
      after = merged;
    } else if (typeof before === "string") {
      const value = typeof incoming === "string" ? incoming.trim() : "";
      if (!value || value === before) continue;
      after = value;
    } else if (typeof before === "number") {
      if (typeof incoming !== "number" || incoming <= 0 || incoming === before) continue;
    }

    (update as Record<string, unknown>)[field] = after;
    changes.push({ field, from: before, to: after, label: describeChange(field, after) });
  }

  if (changes.length) await saveProfile(db, { profile: update });
  return changes;
}

/** A profile list is a prompt fragment, not an archive -- past this it stops being read. */
const MAX_LIST_ITEMS = 10;

function mergeList(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing.map((x) => x.toLowerCase().trim()));

  for (const item of incoming) {
    const value = item.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out.slice(0, MAX_LIST_ITEMS);
}

/** Field names as the Voice tab labels them, so a change reads the same in both places. */
const FIELD_LABELS: Partial<Record<keyof StyleProfile, string>> = {
  do: "always",
  dont: "never",
  signature_moves: "habits",
  max_chars: "max chars",
};

function describeChange(field: keyof StyleProfile, value: unknown): string {
  const name = FIELD_LABELS[field] ?? String(field).replace(/_/g, " ");
  const rendered = Array.isArray(value) ? value.join("; ") : String(value);
  return `${name} → ${rendered.length > 90 ? `${rendered.slice(0, 90)}…` : rendered}`;
}

/** Insert a rule and read back its id, which is what makes it undoable. */
async function addRuleWithId(
  db: D1Database,
  rule: string,
  weight = 0.75,
): Promise<{ id: number; rule: string } | null> {
  await addPreference(db, { rule, source: "inferred", weight });
  const row = await db
    .prepare("SELECT id FROM preferences WHERE lower(rule) = lower(?) ORDER BY id DESC LIMIT 1")
    .bind(rule)
    .first<{ id: number }>();
  return row ? { id: row.id, rule } : null;
}

/* ------------------------ learning from the conversation ------------------ */

/** Below this, a rule is treated as a guess about this post rather than a preference. */
const DURABLE_CONFIDENCE = 0.7;

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
): Promise<LearnedMemory> {
  const learned = emptyLearned();
  if (instruction.trim().length < 8) return learned;

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
    return learned; // Learning is best-effort; never fail a turn over it.
  }
  if (!parsed) return learned;

  const seen = new Set(existing.map((p) => p.rule.toLowerCase()));

  for (const candidate of parsed.rules ?? []) {
    const rule = candidate.rule?.trim();
    if (!rule || rule.length < 5) continue;
    if (candidate.durable !== true) continue;
    if (typeof candidate.confidence !== "number" || candidate.confidence < DURABLE_CONFIDENCE) continue;
    if (seen.has(rule.toLowerCase())) continue;

    seen.add(rule.toLowerCase());
    const added = await addRuleWithId(db, rule);
    if (added) learned.rules.push(added);
  }

  // Only policies the user stated outright. Voice and habits are not something
  // to infer from one instruction -- those come from studying their writing.
  learned.profile = await applyProfilePatch(db, parsed.profile, [
    "emoji",
    "hashtags",
    "capitalization",
    "max_chars",
  ]);

  return learned;
}

/* --------------------------- learning from a source ----------------------- */

/** A note is less invasive than a rule, so the bar to keep one is a little lower. */
const NOTE_CONFIDENCE = 0.6;

/** How many notes one source may contribute, however much it has to say. */
const MAX_NOTES_PER_SOURCE = 6;

export interface StudyDigest {
  summary: string;
  takeaways: string[];
  angles: string[];
  topics: string[];
  /** Empty in "read" mode: the digest was produced but nothing was written. */
  learned: LearnedMemory;
}

/**
 * Read one or more sources and, in "learn" mode, commit what is worth keeping.
 *
 * The two modes share a prompt because the reading is the same work either way;
 * only the writing differs. That also means a user who read something and then
 * decides it was worth keeping can re-run this in "learn" mode without the agent
 * having to fetch or re-read anything.
 */
export async function studySource(
  db: D1Database,
  model: ChatModel,
  opts: { instruction: string; sources: SourceDoc[]; mode: StudyMode },
): Promise<StudyDigest> {
  const digest: StudyDigest = {
    summary: "",
    takeaways: [],
    angles: [],
    topics: [],
    learned: emptyLearned(),
  };
  if (!opts.sources.length) return digest;

  const [existingNotes, existingRules, profileRecord] = await Promise.all([
    listNotes(db, { activeOnly: true }),
    listPreferences(db, { activeOnly: true }),
    getProfile(db),
  ]);

  const parsed = parseJson<{
    summary?: string;
    takeaways?: unknown;
    angles?: unknown;
    topics?: unknown;
    notes?: { note?: string; topics?: unknown; durable?: boolean; confidence?: number }[];
    rules?: { rule?: string; durable?: boolean; confidence?: number }[];
    profile?: Partial<StyleProfile> | null;
  }>(
    await model.complete(
      [
        { role: "system", content: AGENT_ROLE },
        {
          role: "user",
          content: distillPrompt({
            instruction: opts.instruction,
            sources: opts.sources,
            existingNotes: existingNotes.map((n) => n.note),
            existingRules: existingRules.map((p) => p.rule),
            profile: profileRecord.profile,
            mode: opts.mode,
          }),
        },
      ],
      { task: "distill", jsonSchema: DISTILL_SCHEMA as Record<string, unknown>, maxTokens: 3000 },
    ),
  );

  if (!parsed) throw new Error("The model did not return a usable reading of the source.");

  digest.summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  digest.takeaways = strings(parsed.takeaways);
  digest.angles = strings(parsed.angles);
  digest.topics = strings(parsed.topics).map((t) => t.toLowerCase());

  if (opts.mode !== "learn") return digest;

  // Notes are attributed to the primary source. With several links in one
  // message the model reads them together, so a per-note attribution would be a
  // guess -- the URL is here to answer "where did this come from", and the first
  // source is the one the user actually handed over.
  const primary = opts.sources[0];

  const keepable = (parsed.notes ?? [])
    .filter((n) => typeof n.note === "string" && n.note.trim().length > 7)
    .filter((n) => n.durable === true)
    .filter((n) => typeof n.confidence === "number" && n.confidence >= NOTE_CONFIDENCE)
    .slice(0, MAX_NOTES_PER_SOURCE);

  const added = await addNotes(
    db,
    keepable.map((n) => ({
      note: (n.note as string).trim(),
      topics: [...new Set([...strings(n.topics), ...digest.topics].map((t) => t.toLowerCase()))].join(", "),
      sourceUrl: primary.url,
      sourceTitle: primary.title,
    })),
  );
  digest.learned.notes = added.map((n) => ({ id: n.id, note: n.note }));

  const seenRules = new Set(existingRules.map((p) => p.rule.toLowerCase()));
  for (const candidate of parsed.rules ?? []) {
    const rule = candidate.rule?.trim();
    if (!rule || rule.length < 5) continue;
    if (candidate.durable !== true) continue;
    if (typeof candidate.confidence !== "number" || candidate.confidence < DURABLE_CONFIDENCE) continue;
    if (seenRules.has(rule.toLowerCase())) continue;

    seenRules.add(rule.toLowerCase());
    const stored = await addRuleWithId(db, rule);
    if (stored) digest.learned.rules.push(stored);
  }

  // No policy fields here. Whether the user wants emoji is something they tell
  // you, not something an essay's prose is evidence for -- so studying a source
  // can shape the voice description and its habits, and nothing else.
  digest.learned.profile = await applyProfilePatch(db, parsed.profile, [
    "voice",
    "tone",
    "audience",
    "do",
    "dont",
    "signature_moves",
  ]);

  return digest;
}

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
}
