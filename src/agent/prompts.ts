/**
 * Prompts for each pipeline stage, plus the JSON schemas providers can enforce.
 *
 * The voice brief is the important part: it is assembled from memory and is
 * what makes drafts sound like the user rather than like a model.
 */

import type { Preference, Sample, SourceDoc, StyleProfile, Understanding } from "../types";
import { formatById, formatCatalogue } from "./formats";

export const AGENT_ROLE =
  "You are a ghostwriter for one person's X account. You write in their voice, not yours, and you never write like a brand.";

/** Everything the agent remembers about how this person writes. */
export function voiceBrief(
  profile: StyleProfile,
  prefs: Preference[],
  samples: Sample[],
  handle: string,
): string {
  const parts: string[] = [];

  parts.push(`# Voice
${handle ? `Account: @${handle.replace(/^@/, "")}\n` : ""}${profile.voice}
Tone: ${profile.tone.join(", ") || "unspecified"}
Audience: ${profile.audience || "unspecified"}
Capitalization: ${profile.capitalization}
Emoji: ${profile.emoji}. Hashtags: ${profile.hashtags}.
Character budget per post: ${profile.max_chars}.`);

  if (profile.do.length) parts.push(`# Do\n${profile.do.map((d) => `- ${d}`).join("\n")}`);
  if (profile.dont.length) parts.push(`# Don't\n${profile.dont.map((d) => `- ${d}`).join("\n")}`);
  if (profile.signature_moves.length) {
    parts.push(`# Habits worth keeping\n${profile.signature_moves.map((d) => `- ${d}`).join("\n")}`);
  }

  if (prefs.length) {
    parts.push(
      `# Standing rules from the user\nThese come from explicit feedback. Follow them.\n${prefs
        .map((p) => `- ${p.rule}`)
        .join("\n")}`,
    );
  }

  if (samples.length) {
    parts.push(
      `# Posts they actually wrote\nMatch the rhythm, sentence length, and vocabulary of these. Do not reuse their content.\n\n${samples
        .map((s, i) => `[${i + 1}]${s.format ? ` (${s.format})` : ""}\n${s.text}`)
        .join("\n\n")}`,
    );
  } else {
    parts.push(
      `# Posts they actually wrote\nNone recorded yet. Work from the voice description above, and lean plain and specific rather than clever.`,
    );
  }

  return parts.join("\n\n");
}

function sourceBlock(sources: SourceDoc[]): string {
  if (!sources.length) return "";
  return `\n\n# Context gathered
Use these for facts and specifics. Never state something as fact that isn't supported here or in the user's own input.

${sources
  .map(
    (s, i) =>
      `[S${i + 1}] ${s.kind === "x_post" ? "X post" : s.kind === "search" ? "Search result" : "Web page"}: ${s.title}
URL: ${s.url}${s.author ? `\nAuthor: ${s.author}` : ""}
${s.text.slice(0, 2000)}`,
  )
  .join("\n\n")}`;
}

/* ------------------------------ 1. understand ---------------------------- */

export const UNDERSTAND_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["idea", "link", "x_post", "mixed"] },
    intent: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    claims: { type: "array", items: { type: "string" } },
    urls: { type: "array", items: { type: "string" } },
    needs_research: { type: "boolean" },
    research_queries: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "intent", "topics", "claims", "urls", "needs_research", "research_queries"],
  additionalProperties: false,
} as const;

export function understandPrompt(input: string): string {
  return `Read what the user sent and work out what they want to post about.

<input>
${input}
</input>

Return JSON:
- kind: "idea" if it's their own thought, "link" if it's a web link, "x_post" if it's an X/Twitter post, "mixed" if both.
- intent: one line on what they're trying to say. Their angle, not a summary of the input.
- topics: 2-5 lowercase topic tags.
- claims: any factual claims in the input that a post would rest on. Empty array if none.
- urls: every URL in the input, verbatim.
- needs_research: true only if the post would be weak or wrong without current outside information. An opinion about their own work does not need research.
- research_queries: 1-3 search queries if needs_research, otherwise an empty array.

Return only the JSON object.`;
}

/* ------------------------------ 2. format -------------------------------- */

export const FORMAT_SCHEMA = {
  type: "object",
  properties: {
    format: { type: "string" },
    alternate: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["format", "alternate", "rationale"],
  additionalProperties: false,
} as const;

export function formatPrompt(
  input: string,
  understanding: Understanding,
  variety: string,
): string {
  return `Choose the format for this post.

<input>
${input}
</input>

What they're getting at: ${understanding.intent}
Input type: ${understanding.kind}
Topics: ${understanding.topics.join(", ") || "none"}

# Formats
${formatCatalogue()}

# Variety
${variety}

Fit to the input comes first; variety is a tiebreak between formats that fit equally well. Threads are the exception -- only choose one when the idea genuinely cannot be one post.

Return JSON with:
- format: the id of your choice
- alternate: the id of the next best choice
- rationale: one sentence, addressed to the user, on why this shape suits this idea

Return only the JSON object.`;
}

/* ------------------------------- 3. draft -------------------------------- */

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          parts: { type: "array", items: { type: "string" } },
          angle: { type: "string" },
        },
        required: ["parts", "angle"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
} as const;

export function draftPrompt(
  input: string,
  understanding: Understanding,
  formatId: string,
  brief: string,
  sources: SourceDoc[],
  maxChars: number,
): string {
  const format = formatById(formatId);
  return `${brief}${sourceBlock(sources)}

# This post
Format: ${format?.label ?? formatId}
Shape: ${format?.structure ?? "Use your judgement."}
Length: ${format ? (format.parts[0] === format.parts[1] ? `${format.parts[0]} post` : `${format.parts[0]}-${format.parts[1]} posts`) : "1 post"}
Hard limit: ${maxChars} characters per post.

What the user sent:
<input>
${input}
</input>

Their angle: ${understanding.intent}

Write two variants that take genuinely different approaches to the same idea -- not the same post reworded. Each is finished text, ready to post: no placeholders, no "[link]", no meta-commentary.

Return JSON with:
- variants: array of exactly 2 objects, each with
  - parts: array of post texts (one element for a single post, more for a thread)
  - angle: one short line telling the user how this variant differs from the other

Return only the JSON object.`;
}

/* ------------------------------ 4. critique ------------------------------ */

export const CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: ["array", "null"],
      items: {
        type: "object",
        properties: {
          parts: { type: "array", items: { type: "string" } },
          angle: { type: "string" },
        },
        required: ["parts", "angle"],
        additionalProperties: false,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["variants", "warnings"],
  additionalProperties: false,
} as const;

export function critiquePrompt(brief: string, draftsJson: string, maxChars: number): string {
  return `${brief}

# Drafts to check
${draftsJson}

Check each draft against the voice above and against these:
- Every post is within ${maxChars} characters.
- No stated fact that wasn't in the user's input or the gathered context.
- No engagement bait, no throat-clearing opener, no CTA the user didn't ask for.
- Emoji and hashtag policy respected.
- It reads like the sample posts, not like a model.

Return JSON with:
- variants: the corrected drafts in the same shape, or null if nothing needed changing. Fix problems rather than flagging them.
- warnings: short notes for the user about anything they should verify themselves -- unsupported claims, a link that may be paywalled, a factual detail worth double-checking. Empty array if there's nothing.

Return only the JSON object.`;
}

/* ------------------------------- 5. learn -------------------------------- */

export const LEARN_SCHEMA = {
  type: "object",
  properties: { rules: { type: "array", items: { type: "string" } } },
  required: ["rules"],
  additionalProperties: false,
} as const;

export function learnPrompt(original: string, edited: string): string {
  return `The user edited a draft before posting it. Work out what that says about their preferences.

Draft you wrote:
<input>
${original}
</input>

What they actually posted:
<input>
${edited}
</input>

Return JSON with:
- rules: 0-3 short, general style rules that would have produced their version. Each must be a durable preference, not a fact about this one post. If the edit was purely about this post's content, return an empty array.

Examples of good rules: "Cut the opening clause and start on the verb." "Never use the word 'leverage'."
Examples of bad rules: "Mention the pricing change." "Write about Cloudflare."

Return only the JSON object.`;
}


/* ------------------------------- 6. refine ------------------------------- */

export const REFINE_SCHEMA = {
  type: "object",
  properties: {
    format: { type: "string" },
    changed: { type: "string" },
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          parts: { type: "array", items: { type: "string" } },
          angle: { type: "string" },
        },
        required: ["parts", "angle"],
        additionalProperties: false,
      },
    },
  },
  required: ["format", "changed", "variants"],
  additionalProperties: false,
} as const;

export interface RefineTurn {
  instruction: string;
  format: string;
  variants: { parts: { text: string }[] }[];
}

/**
 * A follow-up inside a session.
 *
 * The prior drafts are the starting point, not a reference -- the user is
 * asking for a change to something specific, so the job is to make that change
 * and leave the rest alone.
 */
export function refinePrompt(
  brief: string,
  history: RefineTurn[],
  instruction: string,
  sources: SourceDoc[],
  maxChars: number,
): string {
  const transcript = history
    .map((turn, i) => {
      const drafts = turn.variants
        .map((v, n) => `  Option ${n + 1}:\n${v.parts.map((p) => `    ${p.text}`).join("\n")}`)
        .join("\n");
      return `Turn ${i + 1}
They said: ${turn.instruction}
You wrote (format: ${turn.format}):
${drafts}`;
    })
    .join("\n\n");

  return `${brief}${sourceBlock(sources)}

# The conversation so far
${transcript}

# What they want now
<input>
${instruction}
</input>

Apply this change to the most recent drafts. Keep everything they did not ask you
to change -- this is a revision, not a fresh attempt. If the request implies a
different format (a thread, a one-liner, a list), switch to it; otherwise keep
the format you were using.

Hard limit: ${maxChars} characters per post.

Return JSON with:
- format: the format id you used, whether or not it changed
- changed: one short line, addressed to the user, saying what you did
- variants: array of exactly 2 objects, each with
  - parts: array of post texts (one element for a single post, more for a thread)
  - angle: one short line on how this variant differs from the other

Return only the JSON object.`;
}

/** Available to the refine stage so it can name a format it switches to. */
export { formatCatalogue };


/* ---------------------------- 7. learn from talk -------------------------- */

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rule: { type: "string" },
          durable: { type: "boolean" },
          confidence: { type: "number" },
        },
        required: ["rule", "durable", "confidence"],
        additionalProperties: false,
      },
    },
    profile: {
      type: ["object", "null"],
      properties: {
        emoji: { type: "string", enum: ["never", "sparingly", "freely"] },
        hashtags: { type: "string", enum: ["never", "sparingly", "freely"] },
        capitalization: { type: "string", enum: ["sentence", "lowercase", "title"] },
        max_chars: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  required: ["rules", "profile"],
  additionalProperties: false,
} as const;

/**
 * Pull durable preferences out of what the user said while refining.
 *
 * The whole difficulty is telling a standing preference from a one-off note
 * about this particular post. Getting it wrong fills their rule list with
 * instructions that were never meant to outlive the draft, so the prompt errs
 * toward one-off and the caller only keeps high-confidence durable results.
 */
export function extractPrefsPrompt(instruction: string, existingRules: string[]): string {
  return `While working on a post, the user said this:

<input>
${instruction}
</input>

Decide whether it tells you something about how they want you to write **in
general**, or whether it is a change to **this post only**.

Durable — a standing preference:
- "never use em dashes"
- "stop opening with a question"
- "you keep writing like a brand, cut that out"
- "I don't want hashtags, ever"

One-off — about this post:
- "focus on the pricing angle"
- "mention that it shipped Tuesday"
- "make this one shorter"
- "cut the second sentence"

Default to one-off. Only call something durable when they generalise -- "always",
"never", "from now on", "stop doing X", "you keep doing X" -- or state a
preference about style rather than content. A request to change this post's
subject, facts, or emphasis is never durable.

${existingRules.length ? `They already have these rules. Do not restate them:\n${existingRules.map((r) => `- ${r}`).join("\n")}\n` : ""}
Return JSON with:
- rules: 0-2 objects, each { rule, durable, confidence }.
  - rule: phrased as a short instruction to you, general enough to apply to future posts
  - durable: true only if it should outlive this post
  - confidence: 0 to 1, how sure you are it was meant as a standing preference
- profile: null, or a patch when they clearly stated a global policy. Only these
  keys, only when explicitly stated: emoji, hashtags, capitalization, max_chars.

If it was a one-off, return an empty rules array and null profile. That is the
common case and the right answer most of the time.

Return only the JSON object.`;
}
