/** Shared domain types. */

export type EmojiPolicy = "never" | "sparingly" | "freely";
export type HashtagPolicy = "never" | "sparingly" | "freely";
export type Capitalization = "sentence" | "lowercase" | "title";

/** The evolving model of how the user writes. Stored as JSON in style_profile. */
export interface StyleProfile {
  voice: string;
  tone: string[];
  do: string[];
  dont: string[];
  emoji: EmojiPolicy;
  hashtags: HashtagPolicy;
  capitalization: Capitalization;
  /** Character budget for a single post. 280 free, 25000 premium. */
  max_chars: number;
  audience: string;
  topics: string[];
  signature_moves: string[];
}

export interface Sample {
  id: number;
  text: string;
  format: string | null;
  topics: string;
  source: "pasted" | "imported" | "accepted_draft";
  engagement: number;
  created_at: string;
}

export interface Preference {
  id: number;
  rule: string;
  scope: string;
  weight: number;
  source: "user" | "inferred";
  active: number;
  created_at: string;
}

/**
 * A durable fact the agent distilled from a source the user told it to learn.
 *
 * Deliberately not a Preference: a rule shapes *how* a post is written and is
 * injected into every draft, while a note is something the user now knows and
 * is only worth surfacing when a post touches the same topic.
 */
export interface Note {
  id: number;
  note: string;
  /** Comma-separated tags, matched against a draft's topics to decide relevance. */
  topics: string;
  source_url: string;
  source_title: string;
  active: number;
  created_at: string;
}

export interface FormatStat {
  format: string;
  used: number;
  accepted: number;
  rejected: number;
  last_used_at: string | null;
}

export type InputKind = "idea" | "link" | "x_post" | "mixed";

/**
 * What a turn produces. One request makes one of these, never both.
 *
 * A post stands on its own in a timeline; a reply is read directly under
 * someone else's words. They are written differently, checked differently, and
 * leave the app through different X intent URLs, so the distinction is carried
 * end to end rather than inferred at the last moment.
 */
export type OutputMode = "post" | "reply";

/** A resolved piece of external context the draft is allowed to rely on. */
export interface SourceDoc {
  kind: "x_post" | "web" | "search" | "video";
  url: string;
  title: string;
  text: string;
  author?: string;
  publishedAt?: string;
}

/** One tweet in a post. Single posts have exactly one part. */
export interface PostPart {
  text: string;
  chars: number;
}

export interface Variant {
  parts: PostPart[];
  /** Why this angle, in one line. Shown under the draft in the UI. */
  angle: string;
}

export interface Understanding {
  /** What the user sent. Separate from `mode`, which is what we send back. */
  kind: InputKind;
  /** Set by the router, not the model. */
  mode: OutputMode;
  /** The status being replied to. Non-null only when mode is "reply". */
  inReplyToId: string | null;
  intent: string;
  topics: string[];
  claims: string[];
  urls: string[];
  /**
   * What the user told the agent about how to write it, separated from the
   * material they pasted. Empty when they only handed over a link or an idea.
   *
   * Carried through every later stage because these outrank the voice profile
   * and the standing rules: memory describes how they usually write, and this
   * is them saying that this post is different.
   */
  directions: string[];
  needs_research: boolean;
  research_queries: string[];
}

export interface GenerateResult {
  draftId: string;
  sessionId: string;
  mode: OutputMode;
  /**
   * The status this reply belongs under. Null for a post.
   *
   * The UI needs it to build the right intent URL, and a reply without one is
   * an error rather than something to quietly open as a new post.
   */
  inReplyToId: string | null;
  /** True when this turn refined an earlier draft rather than starting fresh. */
  refined: boolean;
  format: string;
  formatLabel: string;
  formatRationale: string;
  alternateFormat: string | null;
  variants: Variant[];
  sources: SourceDoc[];
  understanding: Understanding;
  warnings: string[];
}

export type Verdict = "posted" | "edited" | "rejected";

/* ------------------------------- learning -------------------------------- */

export interface LearnedRule {
  id: number;
  rule: string;
}

export interface LearnedNote {
  id: number;
  note: string;
}

/** A profile field the agent changed. `from` is kept so the UI can put it back. */
export interface ProfileChange {
  field: keyof StyleProfile;
  from: unknown;
  to: unknown;
  /** Human-readable, e.g. `emoji: never -> sparingly`. */
  label: string;
}

/** Everything one learning pass wrote, in a shape the UI can undo item by item. */
export interface LearnedMemory {
  rules: LearnedRule[];
  notes: LearnedNote[];
  profile: ProfileChange[];
}

export function emptyLearned(): LearnedMemory {
  return { rules: [], notes: [], profile: [] };
}

/* --------------------------------- study --------------------------------- */

/**
 * Whether a message is asking for a post or asking the agent to take something
 * in. `read` keeps the source for this session only; `learn` also writes memory.
 */
export type StudyMode = "read" | "learn";

/** What a "read this" / "learn from this" turn produced instead of drafts. */
export interface StudyResult {
  turnId: string;
  sessionId: string;
  mode: StudyMode;
  sources: SourceDoc[];
  /** Two or three sentences on what the source actually says. */
  summary: string;
  takeaways: string[];
  /** Angles from the source that would make a post, offered rather than written. */
  angles: string[];
  topics: string[];
  /** Empty for `read`: nothing was written to memory. */
  learned: LearnedMemory;
  warnings: string[];
}

/** Progress events streamed to the UI over SSE. */
export type AgentEvent =
  | { type: "session"; sessionId: string; isNew: boolean; title: string }
  | { type: "step"; step: string; label: string; detail?: string }
  | { type: "sources"; sources: SourceDoc[] }
  | { type: "format"; format: string; label: string; rationale: string }
  | { type: "result"; result: GenerateResult }
  | { type: "studied"; result: StudyResult }
  | { type: "learned"; learned: LearnedMemory }
  | { type: "error"; message: string };
