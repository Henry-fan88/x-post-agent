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

export interface FormatStat {
  format: string;
  used: number;
  accepted: number;
  rejected: number;
  last_used_at: string | null;
}

export type InputKind = "idea" | "link" | "x_post" | "mixed";

/** A resolved piece of external context the draft is allowed to rely on. */
export interface SourceDoc {
  kind: "x_post" | "web" | "search";
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
  kind: InputKind;
  intent: string;
  topics: string[];
  claims: string[];
  urls: string[];
  needs_research: boolean;
  research_queries: string[];
}

export interface GenerateResult {
  draftId: string;
  sessionId: string;
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

/** Progress events streamed to the UI over SSE. */
export type AgentEvent =
  | { type: "session"; sessionId: string; isNew: boolean; title: string }
  | { type: "step"; step: string; label: string; detail?: string }
  | { type: "sources"; sources: SourceDoc[] }
  | { type: "format"; format: string; label: string; rationale: string }
  | { type: "result"; result: GenerateResult }
  | { type: "error"; message: string };
