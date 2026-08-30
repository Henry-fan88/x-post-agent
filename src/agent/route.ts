/**
 * Post or reply. Decided once, before anything else runs.
 *
 * One request produces one output type. The same message shape -- some words and
 * an x.com link -- can mean "reply to this" or "write a post about this", and
 * the two are not interchangeable: a reply lands under someone else's post and
 * is read next to it, while a post has to stand on its own. Guessing wrong
 * produces text that is wrong for where it goes, so this is a deterministic
 * router rather than a model call, and the UI can always override it.
 *
 * The default when an X status link is present is `reply`. That is the
 * asymmetry worth having: at a small follower count the reply is the thing that
 * gets read, and a user who wanted a post says so in the words they already use
 * ("write a post about this", "quote this", "riff on this").
 */

import { type XRef, extractUrls, parseXUrl } from "../tools/x";
import type { OutputMode } from "../types";

/**
 * They asked for something that stands on its own. Turns an X link from a reply
 * target into a source to write about.
 */
const WRITE_A_POST =
  /\b(?:write|draft|make|compose|give me|turn (?:this|it|that) into)\s+(?:me\s+)?(?:an?\s+|some\s+|a couple of\s+|two\s+)?(?:new\s+|short\s+|quick\s+|long\s+)?(?:post|posts|tweet|tweets|thread|threads|take|takes|banger)\b|\bpost about\b|\bpost on this\b|\bquote(?:\s+tweet)?\s+(?:this|it|that)\b|\briff(?:\s+on)?\b|\bwrite about\b|\bmy own post\b|\bstandalone\b/i;

/**
 * The same thing in Chinese.
 *
 * Kept as its own pattern because JavaScript's `\b` is defined on ASCII word
 * characters, so every boundary in a CJK alternation silently never matches --
 * the kind of bug that leaves the feature looking implemented and behaving as
 * if it were not.
 */
const WRITE_A_POST_ZH =
  /(?:发|写|来)\s*(?:一\s*)?[条篇个则]?\s*(?:帖子?|贴子?|推文|推特|推(?![\u4e00-\u9fff])|post)/i;

/** They asked to answer someone. Wins over the write-a-post veto. */
const REPLY_TO =
  /\breply(?:ing)?\s+(?:to|under|below)?\b|\brespond(?:ing)?\s+to\b|\banswer\s+(?:this|him|her|them|it)\b|\bcomment (?:on|under)\b|\bget in (?:the )?(?:replies|comments)\b/i;

/** Reply, in Chinese. Same boundary problem as above. */
const REPLY_TO_ZH = /(?:回复|回覆|评论|回他|回她|回一?下)/;

export interface RouteDecision {
  mode: OutputMode;
  /** The status id being replied to. Always null for a post. */
  inReplyToId: string | null;
  /** The parsed target, so the pipeline can find its fetched copy among the sources. */
  target: XRef | null;
  /** One line for the trace, and for the reason a post beat a reply. */
  why: string;
}

/** Explicit `reply` with nothing to reply to. Surfaced to the user, never silently posted. */
export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

/**
 * @param explicit A mode chosen in the UI or passed to the API. Always wins.
 */
export function detectMode(input: string, explicit?: OutputMode | null): RouteDecision {
  const targets = xTargets(input);
  const first = targets[0] ?? null;

  if (explicit === "reply") {
    if (!first) {
      throw new RouteError(
        "You asked for a reply, but there's no X post link to reply to. Paste the post's URL.",
      );
    }
    return { mode: "reply", inReplyToId: first.id, target: first, why: "You asked for a reply." };
  }

  if (explicit === "post") {
    return {
      mode: "post",
      inReplyToId: null,
      target: null,
      why: first ? "You asked for a post, so the X link is a source." : "You asked for a post.",
    };
  }

  // An article, a bare idea, or anything else with no status link: a post. This
  // is also why "mixed article + X link" replies -- only the X link decides.
  if (!first) {
    return { mode: "post", inReplyToId: null, target: null, why: "No X post to reply to." };
  }

  if (REPLY_TO.test(input) || REPLY_TO_ZH.test(input)) {
    return { mode: "reply", inReplyToId: first.id, target: first, why: "You asked to reply to it." };
  }

  if (WRITE_A_POST.test(input) || WRITE_A_POST_ZH.test(input)) {
    return {
      mode: "post",
      inReplyToId: null,
      target: null,
      why: "You asked for a post, so the X link is a source rather than a reply target.",
    };
  }

  return {
    mode: "reply",
    inReplyToId: first.id,
    target: first,
    why: "An X post on its own is something to reply to. Ask for a post to write about it instead.",
  };
}

/** Every X status link in the input, in the order they appear. */
export function xTargets(input: string): XRef[] {
  const refs: XRef[] = [];
  for (const url of extractUrls(input)) {
    const ref = parseXUrl(url);
    if (ref && !refs.some((r) => r.id === ref.id)) refs.push(ref);
  }
  return refs;
}
