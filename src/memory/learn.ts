/**
 * Turning feedback into memory.
 *
 * A rejected draft moves the format's stats. An edited draft is more valuable:
 * the diff between what the agent wrote and what the user posted is a direct
 * signal about their voice, so we ask the model to name the rule behind it and
 * store the edited text as a writing sample.
 */

import { type ChatModel, parseJson } from "../llm";
import { AGENT_ROLE, LEARN_SCHEMA, learnPrompt } from "../agent/prompts";
import type { Verdict } from "../types";
import { addPreference, addSamples, getDraft, recordVerdict } from "./store";

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
