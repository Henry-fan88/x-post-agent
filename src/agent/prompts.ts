/**
 * Prompts for each pipeline stage, plus the JSON schemas providers can enforce.
 *
 * The voice brief is the important part: it is assembled from memory and is
 * what makes drafts sound like the user rather than like a model.
 */

import type {
  InputKind,
  Note,
  OutputMode,
  Preference,
  Sample,
  SourceDoc,
  StudyMode,
  StyleProfile,
  Understanding,
} from "../types";
import { fitVideoText } from "../tools/youtube";
import { dominantScript, scriptName } from "./chars";
import { formatById, formatCatalogue } from "./formats";

export const AGENT_ROLE =
  "You are a ghostwriter for one person's X account. You write in their voice, not yours, and you never write like a brand.";

/**
 * How to weigh this turn's request against everything the agent remembers.
 *
 * Memory used to win by default. The standing rules arrived under a "follow
 * them" heading while the user's actual request sat further down inside the
 * input block, so "make it sophisticated, long, complex sentences" lost to an
 * inferred rule about writing in lowercase. The order is stated now, and the
 * rules are framed as defaults for the gaps rather than a checklist to satisfy.
 */
export const PRECEDENCE = `# What wins when these disagree
1. What the user asked for on this turn. Where they specified something -- length, register, structure, what to include -- do that, even where it contradicts the voice profile or a standing rule.
2. Rules the user set themselves, for anything this turn left unspecified.
3. Inferred habits and the voice profile. These are guesses from past posts, and they are the weakest of the three.

None of it is a checklist. The rules describe how this person usually writes,
not a debt every post owes them. Judge which ones actually serve this post and
this request, apply those, and leave the rest alone. A rule followed into a
worse post was misread.`;

/**
 * Stages that have to weigh memory against the request.
 *
 * The rest -- classifying the input, choosing a format, distilling a rule from
 * an edit -- have no such conflict to resolve, and the precedence rules would
 * be noise in front of them. Two stable system messages rather than one per
 * call: both stay byte-identical across runs, so a provider that caches a
 * prompt prefix can still do so.
 */
const WEIGHS_MEMORY = new Set(["draft", "refine", "critique"]);

/**
 * What the account is trying to do, as writing instructions.
 *
 * Two working ideas underneath it, both from operators who grew accounts from
 * nothing rather than from advice about growing accounts:
 *
 *   X is a party, not a stage. You join a circle that already exists instead of
 *   giving a speech in the corner of the room.
 *
 *   Below roughly a thousand followers, posting into the void is a poor growth
 *   vector. Discovery is replies and the people who already half-know you.
 *
 * Both are here because they change the *writing*, not because they are
 * strategy: they are why a reply may not open with a hook, why a post is
 * saveable rather than clever, and why nothing opens by selling a product.
 *
 * The "never write" list is the concrete half. Every item on it is a shape that
 * an LLM produces readily and that a reader recognises instantly as not-human,
 * which makes it more expensive than posting nothing.
 *
 * Deliberately free of proper nouns. Whatever is hot this week belongs in the
 * turn's sources, not frozen into a prompt that will still be running in six
 * months.
 */
export const STRATEGY = `# What you are writing into
X is a party, not a stage. A post is the user walking into a room they already
belong in -- builders, labs, agents, startups -- and saying one useful thing. A
reply is them putting their head into someone else's circle and adding something
specific enough that they get welcomed in.

Until the account is large, the reply is what gets read. Originals exist to be
worth pinning, to give the people who already half-know them something to like,
and to practise three reflexes: learning in public, giving product feedback in
public, building in public. Do not write a keynote into an empty room.

# Never write
- Free-course spam: "don't waste 2 years", a cloned curriculum, "here's the roadmap".
- An alarm with no number and no name in it.
- Bait that holds the useful part back until someone replies or comments.
- A generic take on AI with no object in it -- no company, model, file, person or number.
- A question asked to farm replies rather than to get an answer.
- A thread announced as a thread, or posts numbered 1/, 2/, 3/.
- Reply slop: restating the post above, complimenting it, piling on emoji.
- A scoop that is not one. Name a leak or a launch only if this turn's sources name it.
- Selling the user's employer or product in the first line, unless they asked to announce something.
- A "how I grew on X" retrospective, unless they asked for one and gave you the real numbers.

# Value before promotion
Do not open by promoting a company or a product. Nobody cares what someone ships
until they have seen that person think. When the idea itself is a fact about the
user's own work, write it as a builder's note -- a number, a constraint, a
surprise -- rather than as a brand post.

# Ride the object that is already there
If this turn's sources name a live proper noun, use it; that is what makes a
post land this week rather than in general. If they do not, do not import one.
Write the user's own idea in a concrete or saveable form instead. A trending
name grafted onto an idea that never mentioned it reads as exactly what it is.

# Raw beats polished
Write the way they talk. A sentence with their rhythm and slightly rough grammar
is closer to them than a clean one that could have come from any growth account.`;

/** Role alone for the mechanical stages, role plus precedence for the writing ones. */
export const WRITER_SYSTEM = `${AGENT_ROLE}\n\n${PRECEDENCE}`;

export function systemFor(task: string): string {
  return WEIGHS_MEMORY.has(task) ? WRITER_SYSTEM : AGENT_ROLE;
}

/**
 * What the user asked for on this turn, stated as instructions rather than
 * buried in the material they pasted.
 *
 * Sits late in the prompt and close to the input on purpose -- it is the thing
 * most likely to be overridden by a confident-sounding memory block above it.
 */
export function directionsBlock(directions: string[]): string {
  const clean = directions.map((d) => d.trim()).filter(Boolean);
  if (!clean.length) return "";
  return `\n\n# What they asked for this time
Their own instructions for this post. On anything these cover, they outrank the
voice profile and every standing rule.

${clean.map((d) => `- ${d}`).join("\n")}`;
}

/**
 * Which language to write in.
 *
 * The rule is simply "match what is in front of you" -- Chinese in, Chinese out
 * -- and for a reply the thing in front of you is the post being answered, not
 * the user's one-line instruction about it. Left implicit, a model asked in
 * English to reply to a Chinese post will happily answer in English, which
 * lands under that post as an obvious import.
 *
 * The script is named only when it is not Latin, because that is the case where
 * the drift actually happens and the extra sentence is otherwise noise.
 */
export function languageBlock(sample: string, subject: string): string {
  const script = dominantScript(sample);
  const note =
    script === "latin"
      ? ""
      : ` It is written in ${scriptName(script)} characters, so write in that same language -- do not answer in English.`;
  return `\n\n# Language
Write in the same language as ${subject}.${note} Match it exactly: if they mix
two languages, mix them the same way.`;
}

/** Everything the agent remembers about how this person writes. */
export function voiceBrief(
  profile: StyleProfile,
  prefs: Preference[],
  samples: Sample[],
  handle: string,
): string {
  const parts: string[] = [];

  parts.push(`# Voice
Defaults drawn from how they usually write. They hold wherever this turn's
request is silent, and yield wherever it is not.

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

  const stated = prefs.filter((p) => p.source === "user");
  const inferred = prefs.filter((p) => p.source !== "user");

  if (stated.length) {
    parts.push(
      `# Rules they set themselves\nThe user wrote these. Follow them unless this turn's request asks for something different.\n${stated
        .map((p) => `- ${p.rule}`)
        .join("\n")}`,
    );
  }

  // Guessed from an edit and never confirmed, so an over-general one ("write in
  // all lowercase", learned from a single rewrite) should not be able to
  // outvote the post in front of you.
  if (inferred.length) {
    parts.push(
      `# Habits guessed from their edits\nInferred from posts they rewrote, never confirmed. Weak defaults: follow one only where it suits this post, and drop it the moment it fights the request or the material.\n${inferred
        .map((p) => `- ${p.rule}`)
        .join("\n")}`,
    );
  }

  if (samples.length) {
    parts.push(
      `# Posts they actually wrote\nWhere this turn's request leaves the shape open, match the rhythm, sentence length, and vocabulary of these. Where it asks for something else, follow the request and let these go. Do not reuse their content.\n\n${samples
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

/**
 * Characters of source text a prompt will carry, shared across every source.
 *
 * A budget rather than a fixed slice per source: one long essay deserves most of
 * the window, while four search snippets should not crowd out the voice brief.
 */
const SOURCE_BUDGET = 9000;
const MIN_PER_SOURCE = 1200;

function sourceText(doc: SourceDoc, limit: number): string {
  if (doc.text.length <= limit) return doc.text;
  // A transcript is re-spread rather than cut. Slicing one would throw away the
  // end of the video, which is where a talk says what it was for.
  if (doc.kind === "video") return fitVideoText(doc.text, limit);
  // Say so, or the model treats a cut-off paragraph as the end of the argument.
  return `${doc.text.slice(0, limit)}\n[...truncated]`;
}

/**
 * How a source is announced to the model.
 *
 * A video is called a video because the model writes about it differently: you
 * quote a page, but you say what someone said in a talk, and a timestamp is a
 * citation a reader can click.
 */
const SOURCE_LABEL: Record<SourceDoc["kind"], string> = {
  x_post: "X post",
  search: "Search result",
  video: "Video transcript",
  web: "Web page",
};

function sourceBlock(sources: SourceDoc[]): string {
  if (!sources.length) return "";
  const per = Math.max(MIN_PER_SOURCE, Math.floor(SOURCE_BUDGET / sources.length));

  return `\n\n# Context gathered
Use these for facts and specifics. Never state something as fact that isn't supported here or in the user's own input.

${sources
  .map(
    (s, i) =>
      `[S${i + 1}] ${SOURCE_LABEL[s.kind] ?? "Source"}: ${s.title}
URL: ${s.url}${s.author ? `\nAuthor: ${s.author}` : ""}
${sourceText(s, per)}`,
  )
  .join("\n\n")}`;
}

/**
 * What the user has had the agent learn, filtered to this post's topics.
 *
 * Kept apart from the voice brief on purpose. The brief says how to write; this
 * says what is already known, and the prompt has to be explicit that knowing
 * something is not a reason to put it in the post.
 */
function knowledgeBlock(notes: Note[]): string {
  if (!notes.length) return "";
  return `\n\n# What you've learned for them
Background the user asked you to remember. Use it to get details right and to avoid
saying something they already know is wrong. It is context, not material -- do not
work a note into the post unless it earns its place.

${notes.map((n) => `- ${n.note}${n.source_title ? ` (${n.source_title})` : ""}`).join("\n")}`;
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
    directions: { type: "array", items: { type: "string" } },
    needs_research: { type: "boolean" },
    research_queries: { type: "array", items: { type: "string" } },
  },
  required: [
    "kind",
    "intent",
    "topics",
    "claims",
    "urls",
    "directions",
    "needs_research",
    "research_queries",
  ],
  additionalProperties: false,
} as const;

export function understandPrompt(input: string): string {
  return `Read what the user sent and work out what they want to write about.

<input>
${input}
</input>

Return JSON:
- kind: what they **sent you**, not what you should produce. "idea" if it's their
  own thought, "link" if it's a web link, "x_post" if it's an X/Twitter post,
  "mixed" if both. Whether this turn produces a post or a reply has already been
  decided elsewhere -- do not try to decide it here, and do not let an X link
  change your answer to anything other than "x_post" or "mixed".
- intent: one line on what they're trying to say. Their angle, not a summary of the input.
- topics: 2-5 lowercase topic tags.
- claims: any factual claims in the input that a post would rest on. Empty array if none.
- urls: every URL in the input, verbatim.
- directions: instructions the user gave about how to write it -- length, tone, register, sentence style, structure, something to include or leave out. One instruction per entry, in their words. This is the half of the message addressed to you; the rest is material to write about. A pasted article is material even when it is most of the message. Empty array if they only handed you material.
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
</input>${directionsBlock(understanding.directions)}

What they're getting at: ${understanding.intent}
Input type: ${understanding.kind}
Topics: ${understanding.topics.join(", ") || "none"}

# Formats
${formatCatalogue()}

# What the idea usually wants
A starting policy, not a rule. The voice profile and the user's own samples
outrank it wherever they disagree.

- Tools, alternatives, steps, a curriculum, anything countable -> numbered_list. The first line names the count and what the reader gets. Built to be bookmarked.
- A metric, a benchmark, a cost, a throughput number -> the number is the post. one_liner or build_log, not an essay around it.
- A launch or a leak that the sources actually name -> announcement or quote_reaction. A proper noun is required; "AI is accelerating" is not a leak.
- The user taking a side on a named company, file, model or person -> hot_take. One concrete claim, not a survey of the debate.
- They shipped, demoed, or have numbers from before and after -> build_log or before_after. What it does, on what stack, one metric. Link last or not at all.
- They learned something and can name who said it -> quote_reaction, or a post that carries the source. The attribution is the point, not decoration.
- They used a product and have real feedback -> quote_reaction or observation, written as a user of the thing. Not a recap of its launch, and not an advert.
- Already one sharp sentence -> one_liner or hot_take. Do not inflate it.
- Genuinely three or more steps the reader must take in order -> insight_thread. Rare.
- An article or blog URL as the source -> a post that carries the source, usually quote_reaction or resource_drop.

Bookmarks are worth more than likes for most of these, so favour the shape
someone would save. The exception is a named disagreement, where replies and
likes are the point. Pick for what the idea is, not for the biggest number.

# Variety
${variety}

Fit to the input comes first; variety is a tiebreak between formats that fit equally well. Threads are the exception -- only choose one when the idea genuinely cannot be one post.

If the user asked for something that implies a shape -- a one-liner, a list, a
long and comprehensive piece -- that settles it, over the variety bias.

Length and post count are separate decisions, and asking for one is not asking
for the other. "Long", "comprehensive", "detailed", "in depth" is a request for
a bigger single post, not for a thread: answer it with long_post. Only reach for
insight_thread when the material is genuinely sequential -- the reader has to
absorb one step before the next one means anything -- or when they asked for a
thread in those words. If you are choosing a thread, your rationale has to say
what breaks if it is read as one post. If you cannot name that, it is one post.

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
  notes: Note[],
  maxChars: number,
  /** From the variant lock, which is enforced again on the way out. */
  variants: 1 | 2,
): string {
  const format = formatById(formatId);
  return `${brief}${knowledgeBlock(notes)}${sourceBlock(sources)}

${STRATEGY}

# This post
Format: ${format?.label ?? formatId}
Shape: ${format?.structure ?? "Use your judgement."}
Length: ${format ? (format.parts[0] === format.parts[1] ? `${format.parts[0]} post` : `${format.parts[0]}-${format.parts[1]} posts`) : "1 post"}
Hard limit: ${maxChars} characters per post, counted the way X counts: a CJK
character or an emoji costs two, and any URL costs 23 however long it is. This is
a ceiling, not a target. Write what the idea needs and stop; padding a post out
toward the limit is worse than ending early.

The first line has to stand on its own. It is the whole post for most of the
people who will see it.${directionsBlock(understanding.directions)}${languageBlock(input, "the user's own message")}

What the user sent:
<input>
${input}
</input>

Their angle: ${understanding.intent}

${
    variants === 1
      ? `Write one draft. This format is a single sharp line -- a second version
would be the same post with the words moved, and making the user read both to
discover that is worse than giving them one.`
      : `Write two drafts that take genuinely different angles on the same idea.
Different angle means a different thing said, not the same thing reworded: a
different opening claim, a different piece of evidence, a different consequence.
If you cannot find a second angle that is actually different, return one draft
rather than a paraphrase.`
  }

Each draft is finished text, ready to post: no placeholders, no "[link]", no meta-commentary.

Return JSON with:
- variants: array of ${variants === 1 ? "exactly 1 object" : "1 or 2 objects"}, each with
  - parts: array of post texts (one element for a single post, more for a thread)
  - angle: one short line telling the user what this draft's angle is

Return only the JSON object.`;
}

/* ------------------------------ 3b. reply -------------------------------- */

export interface ReplyTarget {
  /** Author of the post being replied to, without the @. Empty if unknown. */
  handle: string;
  id: string;
  /** The parent's text. Empty when it could not be read. */
  text: string;
}

/**
 * One reply, to one post.
 *
 * A different job from drafting a post, which is why it is a different prompt
 * rather than a flag on the last one. A reply is read immediately under the
 * thing it answers, so everything a standalone post does to earn attention --
 * the hook, the setup, the restatement of the premise -- actively works against
 * it here. The reader has the context already; the only thing they do not have
 * is the user's point.
 *
 * The payoff for getting this right is not the reply itself. It is that the
 * author might like, answer, or follow, which is what starts putting the user's
 * own posts in front of that author's audience. A reply that reads as
 * mass-produced does the reverse, so the failure modes are named explicitly
 * rather than left to taste.
 */
export function replyPrompt(
  input: string,
  understanding: Understanding,
  brief: string,
  target: ReplyTarget,
  sources: SourceDoc[],
  notes: Note[],
  maxChars: number,
): string {
  const author = target.handle ? `@${target.handle.replace(/^@/, "")}` : "the author";

  return `${brief}${knowledgeBlock(notes)}${sourceBlock(sources)}

${STRATEGY}

# The post you are replying to
By ${author}, status ${target.id}. Your reply appears directly underneath it, and
is read with it already on screen.

${target.text ? `<parent>\n${target.text}\n</parent>` : "(The post could not be read. Do not invent what it said -- stay on what the user told you, and keep it general enough to be safe.)"}

# How to write it
Add one specific thing: an agreement with a reason, a disagreement with a reason,
a number, or something you know that they do not. That is the whole reply.

Do not write a standalone post. Do not recap or paraphrase what they said -- the
reader just read it. Do not open with their handle; X threads it already. Do not
compliment the post as the payload; "great thread" is not a reply. Do not add a
call to action, and do not end on a question you do not want answered.

Short and conversational, in the user's voice. Facts only from the post above,
the user's instruction, and the sources on this turn -- nothing you merely
remember about the subject.

Hard limit: ${maxChars} characters, counted the way X counts (CJK and emoji cost
two, a URL costs 23). Well under it is better.

Test before you answer: if this could be posted on its own as a new post and
still make sense, it is not a reply yet.${directionsBlock(understanding.directions)}${languageBlock(target.text || input, "the post you are replying to")}

What the user told you:
<input>
${input}
</input>

Return JSON with:
- variants: array of exactly 1 object, with
  - parts: array containing exactly one reply text
  - angle: one short line on what your reply adds

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

export interface CritiqueContext {
  brief: string;
  directions: string[];
  draftsJson: string;
  maxChars: number;
  mode: OutputMode;
  /** For a reply: the post it sits under, so "does this recap it" is answerable. */
  parentText?: string;
  /**
   * Faults already found mechanically, phrased as fixes.
   *
   * Handed over rather than left to be rediscovered: the model is much better at
   * rewriting a named problem than at noticing it in its own output.
   */
  problems?: string[];
}

/**
 * The self-check.
 *
 * A reply is checked *as a reply*, against the post it will appear under, which
 * is a different standard from a post checked against a timeline. The one test
 * that matters for a reply -- could this stand alone as a new post? -- is a
 * failure here and a success there.
 */
export function critiquePrompt(ctx: CritiqueContext): string {
  const reply = ctx.mode === "reply";

  return `${ctx.brief}${directionsBlock(ctx.directions)}

# ${reply ? "Reply to check" : "Drafts to check"}
${ctx.draftsJson}
${
    reply && ctx.parentText
      ? `\n# The post it will appear under\n<parent>\n${ctx.parentText}\n</parent>\n`
      : ""
  }${
    ctx.problems?.length
      ? `\n# Already found wrong with it\nFix every one of these. They were detected mechanically, so they are not matters of taste.\n${ctx.problems
          .map((p) => `- ${p}`)
          .join("\n")}\n`
      : ""
  }
Check ${reply ? "the reply" : "each draft"}, in this order:
- Within ${ctx.maxChars} characters, counted the way X counts: CJK characters and emoji cost two each, and any URL costs 23 however long it is. A post that is 200 code points of Chinese is 400 by this count.
- Same language as ${reply ? "the post above" : "the user's own message"}. Never translated into English.
- No stated fact that wasn't in the user's input or the gathered context.
- It does what the user asked for this turn. A draft that drifted back toward their usual voice on something they specified is a draft to fix, not a request to overrule.
${
    reply
      ? `- It is a reply, not a post. It does not recap or paraphrase the parent, does not open with the author's handle, is not a compliment with nothing under it, carries no call to action, and does not end on a question asked for engagement.
- The hard test: if it would work posted on its own, with a hook and no parent above it, it has failed. Rewrite it as an answer to that specific post.
- It says one concrete thing -- an agreement or a disagreement with a reason, a number, or something the author does not know.`
      : `- The first line stands on its own.
- No engagement bait, no throat-clearing opener, no CTA they didn't ask for, no proper noun that is not in the input or the sources, emoji and hashtag policy respected, and it reads like a person rather than a model.
- It does not open by selling a company or product, unless the user asked to announce something.`
  }

Do not correct a draft toward the profile or the sample posts on any point the
user specified this turn. A draft that reads unlike their usual posts because
that is what they asked for is correct, and making it sound familiar again is
the failure this check exists to catch.

Return JSON with:
- variants: the corrected drafts in the same shape, or null if nothing needed changing. Fix problems rather than flagging them.${reply ? " Return exactly one." : ""}
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
  /** What that turn produced. A session does not change its mind about this. */
  mode: OutputMode;
  inReplyToId: string | null;
  kind: InputKind;
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
  notes: Note[],
  maxChars: number,
  mode: OutputMode,
  /** Present when refining a reply, so the revision is still checked against the parent. */
  target: ReplyTarget | null,
  variants: 1 | 2,
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

  const reply = mode === "reply";

  return `${brief}${knowledgeBlock(notes)}${sourceBlock(sources)}

${STRATEGY}

# The conversation so far
${transcript}
${
    reply && target
      ? `\n# This session is writing a reply
Everything here is a revision of one reply to ${target.handle ? `@${target.handle.replace(/^@/, "")}` : "someone"}'s post (status ${target.id}). It stays a reply. Do not turn it into a standalone post, whatever the instruction below asks for -- if they want a post about it, they will start a new one.
${target.text ? `\n<parent>\n${target.text}\n</parent>\n` : ""}
Every reply rule still applies: no recap of the parent, no leading handle, no
compliment as the payload, no CTA, no question asked for engagement.\n`
      : ""
  }
# What they want now
This is the instruction that outranks the profile and the standing rules. If it
asks for something those would not have produced, that is the point of asking.

<input>
${instruction}
</input>

Apply this change to the most recent ${reply ? "reply" : "drafts"}. Keep everything they did not ask you
to change -- this is a revision, not a fresh attempt.${
    reply
      ? ""
      : ` If the request implies a
different format (a thread, a one-liner, a list), switch to it; otherwise keep
the format you were using.`
  }

Hard limit: ${maxChars} characters per post, counted the way X counts (CJK and
emoji cost two, a URL costs 23).${languageBlock(reply && target?.text ? target.text : instruction, reply ? "the post being replied to" : "the drafts above")}

Return JSON with:
- format: the format id you used, whether or not it changed${reply ? ' (keep it as "reply")' : ""}
- changed: one short line, addressed to the user, saying what you did
- variants: array of ${variants === 1 ? "exactly 1 object" : "1 or 2 objects"}, each with
  - parts: array of post texts (one element for a single post, more for a thread)
  - angle: one short line on this draft's angle

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


/* ---------------------------- 8. study a source --------------------------- */

export const DISTILL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    takeaways: { type: "array", items: { type: "string" } },
    angles: { type: "array", items: { type: "string" } },
    topics: { type: "array", items: { type: "string" } },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          note: { type: "string" },
          topics: { type: "array", items: { type: "string" } },
          durable: { type: "boolean" },
          confidence: { type: "number" },
        },
        required: ["note", "topics", "durable", "confidence"],
        additionalProperties: false,
      },
    },
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
        voice: { type: "string" },
        tone: { type: "array", items: { type: "string" } },
        audience: { type: "string" },
        do: { type: "array", items: { type: "string" } },
        dont: { type: "array", items: { type: "string" } },
        signature_moves: { type: "array", items: { type: "string" } },
        emoji: { type: "string", enum: ["never", "sparingly", "freely"] },
        hashtags: { type: "string", enum: ["never", "sparingly", "freely"] },
        capitalization: { type: "string", enum: ["sentence", "lowercase", "title"] },
        max_chars: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  required: ["summary", "takeaways", "angles", "topics", "notes", "rules", "profile"],
  additionalProperties: false,
} as const;

export interface DistillContext {
  /** What the user said when they handed the source over. Steers what to keep. */
  instruction: string;
  sources: SourceDoc[];
  /** Notes already stored, so the same fact isn't recorded twice. */
  existingNotes: string[];
  existingRules: string[];
  profile: StyleProfile;
  /** In "read" mode nothing is written, so the memory fields are not asked for. */
  mode: StudyMode;
}

/**
 * Read a source properly, and work out what -- if anything -- should outlive the
 * session.
 *
 * The hard judgement is the same one the conversational extractor makes, in a
 * different disguise: an article is full of true statements, and almost none of
 * them are worth remembering. So the bar is not "is this correct" but "would the
 * user want this in front of me the next time they post on this subject".
 *
 * The second judgement is which memory a thing belongs in. What an article
 * *says* is a note. How it is *written* is a rule, and only when the user has
 * said they want to write that way -- an essayist's habits are not the user's
 * preferences just because they read the essay.
 */
export function distillPrompt(ctx: DistillContext): string {
  const learning = ctx.mode === "learn";

  return `The user gave you a source to take in rather than to post about.

What they said:
<input>
${ctx.instruction || "(no instruction -- they just handed it over)"}
</input>
${sourceBlock(ctx.sources)}

# Their voice, for reference
${ctx.profile.voice}
Audience: ${ctx.profile.audience || "unspecified"}

Read the source and report on it. Be concrete: name the specifics, numbers and
claims that make it worth reading. If the text looks truncated, work with what is
there and do not guess at the rest.

Return JSON with:
- summary: 2-3 sentences on what it actually says. Its argument, not its subject.
- takeaways: 3-5 short points a reader would want to keep. Each one standalone.
- angles: 0-3 posts this source could support, one line each, phrased as an angle
  rather than a draft. Empty if it is background rather than material.
- topics: 2-5 lowercase topic tags for this source.
${
  learning
    ? `
They asked you to learn this, so also decide what goes into long-term memory.

- notes: 0-6 things worth remembering. A note is a fact, position, number, name
  or piece of vocabulary the user would want you to have the next time they post
  on this subject.
  - Write each as a standalone statement, not as reportage. "Cloudflare Workers
    bill by CPU time, not wall clock" -- not "the article explains that Workers
    bill by CPU time".
  - Keep what is durable. Skip what expires: today's stock move, a headline
    count, who was in the room. A dated fact is fine if you date it in the note.
  - Skip anything the user obviously already knows, and anything already listed
    below.
  - durable: false for anything tied to this week's news cycle.
  - confidence: 0 to 1, how sure you are it is both true per the source and worth
    keeping.
  - topics: 1-3 lowercase tags, used later to decide when to surface the note.

- rules: 0-3 style rules, and **only** if the user's instruction says this source
  represents how they want to write -- their own writing, or a style they said to
  adopt. Reading an essay is not consent to write like its author. If the
  instruction is about the subject rather than the prose, return an empty array.
  - durable: true only if it should apply to every future post.
  - confidence: 0 to 1.

- profile: null, unless the instruction says this source is their own voice or a
  voice to take on. Then a patch of only the fields the source genuinely
  evidences. Never guess emoji, hashtags, capitalization or max_chars from an
  article -- those are policies the user states, not habits you infer from prose.
${ctx.existingNotes.length ? `\nAlready in memory, do not repeat:\n${ctx.existingNotes.map((n) => `- ${n}`).join("\n")}` : ""}
${ctx.existingRules.length ? `\nExisting rules, do not restate:\n${ctx.existingRules.map((r) => `- ${r}`).join("\n")}` : ""}

An empty notes array is a fine answer for a source that is interesting but tells
you nothing you need to carry forward.`
    : `
They only asked you to read it, so nothing is being written to memory. Return an
empty array for notes, an empty array for rules, and null for profile.`
}

Return only the JSON object.`;
}
