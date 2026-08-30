/**
 * The format catalogue.
 *
 * The agent picks one per post rather than defaulting to a house style, and
 * `varietyBrief` biases it away from whatever it just used. Format choice is
 * the difference between an agent that writes in your voice and one that
 * writes the same post every time.
 */

import type { FormatStat, Variant } from "../types";

export interface PostFormat {
  id: string;
  label: string;
  whenToUse: string;
  structure: string;
  /** [min, max] posts. 1 means a single tweet; more means a thread. */
  parts: [number, number];
}

export const FORMATS: PostFormat[] = [
  {
    id: "one_liner",
    label: "One-liner",
    whenToUse: "The idea is already sharp and needs no support. Strongest format when it fits.",
    structure: "A single sentence, ideally under 120 characters. No setup, no follow-through.",
    parts: [1, 1],
  },
  {
    id: "hot_take",
    label: "Hot take",
    whenToUse: "You hold a view most people in the audience don't, and can back it in a line.",
    structure: "Contrarian claim in the first sentence, then one or two lines of justification. Never hedge the claim itself.",
    parts: [1, 1],
  },
  {
    id: "observation",
    label: "Observation",
    whenToUse: "You noticed a pattern worth naming. Lower stakes than a hot take.",
    structure: "Name the pattern, then the detail that makes it real. End on the observation, not a lesson.",
    parts: [1, 1],
  },
  {
    id: "long_post",
    label: "Long post",
    whenToUse:
      "The idea needs room -- a claim, the evidence under it, and what follows -- and reads better whole than split. The right answer whenever someone asks for something long, comprehensive, or sophisticated.",
    structure:
      "One post, several paragraphs. Open on the claim, develop it in the order a reader needs it, close on the consequence. Paragraph breaks carry the structure a thread would have spent post numbers on. Long because the argument earns it, never to fill the budget.",
    parts: [1, 1],
  },
  {
    id: "insight_thread",
    label: "Thread",
    whenToUse:
      "Rare. Only when the reader has to stop between steps -- a sequence where each post changes what the next one means -- or when the user asks for a thread outright. Length alone is never the reason: a long argument belongs in long_post.",
    structure:
      "First post stands alone and states the conclusion. Each following post makes one point. 3-7 posts. Never number them, never announce it's a thread.",
    parts: [3, 7],
  },
  {
    id: "build_log",
    label: "Build log",
    whenToUse: "You shipped, broke, fixed, or learned something while building.",
    structure: "What you did, the specific thing that surprised you, and what it cost. Concrete numbers beat adjectives.",
    parts: [1, 3],
  },
  {
    id: "numbered_list",
    label: "List",
    whenToUse: "Several parallel points of roughly equal weight, none needing much elaboration.",
    structure: "A one-line frame, then 3-6 short items, one per line. Items are specific, not categories.",
    parts: [1, 2],
  },
  {
    id: "story",
    label: "Short story",
    whenToUse: "A specific thing happened to you and the point lands better as narrative.",
    structure: "Situation, turn, and what it left you thinking. Past tense. Keep it under a minute of reading.",
    parts: [1, 4],
  },
  {
    id: "question",
    label: "Open question",
    whenToUse: "You genuinely want answers, not engagement. Do not fake this.",
    structure: "Enough context to make the question answerable, then the question. No 'what do you think?' filler.",
    parts: [1, 1],
  },
  {
    id: "quote_reaction",
    label: "Reaction",
    whenToUse: "Responding to someone else's post or article. The default when the input is a link.",
    structure:
      "Your point first -- it must stand on its own for someone who doesn't click. Reference the source's claim specifically rather than gesturing at it.",
    parts: [1, 2],
  },
  {
    id: "teardown",
    label: "Teardown",
    whenToUse: "You have specific, technical things to say about how something works.",
    structure: "Name the thing, then 2-4 specific mechanics with real detail. Assume a knowledgeable reader.",
    parts: [1, 4],
  },
  {
    id: "announcement",
    label: "Announcement",
    whenToUse: "You are launching or releasing something.",
    structure: "What it is and who it's for in the first line. One line on why it exists. Link last.",
    parts: [1, 2],
  },
  {
    id: "before_after",
    label: "Before / after",
    whenToUse: "A contrast carries the whole point -- old way vs new way, expectation vs reality.",
    structure: "State both sides in parallel construction, shortest form possible. Let the gap do the work.",
    parts: [1, 1],
  },
  {
    id: "resource_drop",
    label: "Resource",
    whenToUse: "Sharing something useful you didn't make.",
    structure: "What it is, the one non-obvious reason it's worth your time, then the link.",
    parts: [1, 1],
  },
];

const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

/**
 * The pseudo-format a reply is stored under.
 *
 * Not in the catalogue, and deliberately so: a reply's shape is set by the post
 * it answers rather than chosen from a list, so it never goes through the format
 * chooser. It still needs an id, because a draft row has a format column and
 * because accept/reject rates on replies are worth having separately.
 */
export const REPLY_FORMAT = "reply";

export function formatById(id: string): PostFormat | undefined {
  return BY_ID.get(id);
}

export function formatLabel(id: string): string {
  if (id === REPLY_FORMAT) return "Reply";
  return BY_ID.get(id)?.label ?? id;
}

/** The catalogue as prompt text. */
export function formatCatalogue(): string {
  return FORMATS.map(
    (f) =>
      `- ${f.id} (${f.label}) -- ${f.whenToUse}\n  Shape: ${f.structure}\n  Length: ${
        f.parts[0] === f.parts[1] ? `${f.parts[0]} post` : `${f.parts[0]}-${f.parts[1]} posts`
      }`,
  ).join("\n");
}

/**
 * Anti-repetition signal for the format chooser.
 *
 * Recency discourages, acceptance rate encourages. Both are advisory: if a
 * format is clearly right for the input the model should still pick it.
 */
export function varietyBrief(recent: string[], stats: FormatStat[]): string {
  const lines: string[] = [];

  // Replies are not drawn from this catalogue, so they are not repetition to avoid.
  const fromCatalogue = recent.filter((id) => BY_ID.has(id));

  if (fromCatalogue.length) {
    const labels = fromCatalogue.slice(0, 5).map(formatLabel);
    lines.push(
      `Recently used, newest first: ${labels.join(", ")}. Avoid repeating the most recent one unless it is clearly the best fit for this input.`,
    );
  } else {
    lines.push("No formats used yet -- no repetition to avoid.");
  }

  // Same reason: an accept rate on replies says nothing about which post format
  // to choose, and naming a format the chooser cannot pick is worse than silence.
  const judged = stats.filter((s) => BY_ID.has(s.format) && s.accepted + s.rejected >= 2);
  if (judged.length) {
    const scored = judged
      .map((s) => ({
        id: s.format,
        rate: s.accepted / (s.accepted + s.rejected),
        n: s.accepted + s.rejected,
      }))
      .sort((a, b) => b.rate - a.rate);

    const liked = scored.filter((s) => s.rate >= 0.6).map((s) => formatLabel(s.id));
    const disliked = scored.filter((s) => s.rate < 0.34).map((s) => formatLabel(s.id));
    if (liked.length) lines.push(`The user usually posts drafts in these formats: ${liked.join(", ")}.`);
    if (disliked.length) lines.push(`The user usually rejects these formats: ${disliked.join(", ")}.`);
  }

  return lines.join("\n");
}


/* ------------------------------ variant lock ----------------------------- */

/**
 * Formats where a second variant is always a worse version of the first.
 *
 * A one-liner or a hot take is a single sentence that either lands or doesn't;
 * asking for two produces the same sentence with the words moved, and the user
 * has to read both to discover that. A before/after is fixed by its own
 * structure. Everything else genuinely supports two different angles.
 */
const SINGLE_VARIANT = new Set(["one_liner", "hot_take", "question", "before_after"]);

/** How many drafts this turn should produce. Replies are always one. */
export function variantCount(formatId: string, mode: "post" | "reply" = "post"): 1 | 2 {
  if (mode === "reply") return 1;
  return SINGLE_VARIANT.has(formatId) ? 1 : 2;
}

/** Words that carry the angle, for telling two drafts apart. */
function shape(text: string): Set<string> {
  const latin = text.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? [];
  const cjk = text.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) ?? [];
  const bigrams = cjk.slice(0, -1).map((c, i) => c + cjk[i + 1]);
  return new Set([...latin, ...bigrams]);
}

/** How much of the shorter draft is also in the longer one. */
function similarity(a: string, b: string): number {
  const left = shape(a);
  const right = shape(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

const PARAPHRASE = 0.72;

/**
 * Hold the model to the variant count, and drop a second draft that is the
 * first one reworded.
 *
 * The count is enforced here rather than trusted from the prompt, because a
 * model asked for one draft will still occasionally hand back two, and the
 * whole point of the lock is that the user is not made to choose between a post
 * and its own paraphrase.
 */
export function clampVariants(variants: Variant[], want: 1 | 2): Variant[] {
  const kept = variants.slice(0, want);
  if (kept.length < 2) return kept;

  const [first, second] = kept.map((v) => v.parts.map((p) => p.text).join("\n"));
  return similarity(first, second) >= PARAPHRASE ? [kept[0]] : kept;
}
