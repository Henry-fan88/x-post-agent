/**
 * Telling "post about this" from "take this in".
 *
 * The same message shape -- some words and a link -- can mean write me a post,
 * read this so we can talk about it, or learn this permanently. Getting it wrong
 * is cheap in one direction (an unwanted draft) and expensive in the other (a
 * silent write to memory), so this errs toward drafting: it only claims a study
 * intent when the user used a study verb *and* there is a source for it to
 * apply to.
 *
 * Deliberately deterministic. Classifying with the model would cost a round trip
 * on every message to resolve phrasing that is, in practice, formulaic -- and the
 * UI offers an explicit "Learn from this" button for anything this misses.
 */

import type { StudyMode } from "../types";

/** Asking for something written. Vetoes a pure study read. */
const WRITE =
  /\b(?:write|draft|compose|rewrite|tweet it|post about|make (?:me )?an? (?:post|thread|tweet|draft)|turn (?:this|it|that|these) into|hot take|give me (?:a|an|two|some|another) (?:post|draft|option|take|version|thread))\b/i;

/** Asking for it to stick. */
const LEARN =
  /\b(?:learn (?:from|this|it|that|my|the)|remember (?:this|it|that|these)|save (?:this|it|that|these)|add (?:this|it|that|these) to (?:your )?(?:memory|notes|preferences|rules)|study (?:this|it|that|these)|take notes|note this|internali[sz]e|memori[sz]e|pick up (?:the|this|my) (?:style|voice|tone))\b/i;

/** Asking it to have the source in mind, for now. */
const READ =
  /\b(?:read (?:this|it|that|these|the)|have a (?:read|look)|take a look|look at (?:this|it|that|these)|check (?:this|it|that) out|digest|skim|go through (?:this|it|that)|for context|just read|ingest|what does (?:this|it) say|summari[sz]e (?:this|it|that))\b/i;

/**
 * A reference to something already in the session, so "learn from it" works on a
 * later turn without the user pasting the link again. Also what keeps
 * "remember that I hate em dashes" out of this path -- that is a preference
 * about writing, not an instruction about a source.
 */
const SOURCE_REF =
  /\b(?:this|that|the|these) (?:articles?|pieces?|posts?|pages?|links?|essays?|blogs?|write-?ups?|papers?|stories|story|sources?|reads?)\b|\bfrom (?:this|that|it|them)\b|\bthis one\b/i;

export interface StudyIntent {
  mode: StudyMode;
  /**
   * They asked for a post as well. The pipeline drafts as usual, and learning
   * happens alongside rather than instead.
   */
  alsoWrite: boolean;
}

export function detectStudyIntent(
  input: string,
  opts: { hasUrl: boolean; hasSources: boolean },
): StudyIntent | null {
  const text = input.trim();
  if (!text) return null;

  // Nothing to study. A bare link with no verb is the ordinary "post about this".
  const anchored = opts.hasUrl || (opts.hasSources && SOURCE_REF.test(text));
  if (!anchored) return null;

  const learn = LEARN.test(text);
  const read = READ.test(text);
  if (!learn && !read) return null;

  const alsoWrite = WRITE.test(text);

  // "read this and write a thread" is a normal draft; the read is implied by the
  // pipeline anyway. "learn this and write a thread" is both, and worth honouring.
  if (alsoWrite && !learn) return null;

  return { mode: learn ? "learn" : "read", alsoWrite };
}
