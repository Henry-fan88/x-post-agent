/**
 * What makes a reply a reply.
 *
 * A reply is read directly under the post it answers, so the failure modes are
 * specific and mechanical: restating what the reader just read, complimenting
 * instead of saying something, opening with the handle, tacking on a call to
 * action, or writing a standalone post with a hook that makes no sense under
 * someone else's words.
 *
 * The critique stage catches these when it is paying attention. This catches
 * them every time, before the model gets a second pass, because they are the
 * exact shapes an AI reply-bot produces -- and a reply that reads like a bot
 * costs the user more than no reply at all.
 *
 * Deliberately conservative: everything here is a shape you can check without
 * judgement. Whether a take is *good* is not this file's business.
 */

import { weightedLength } from "./chars";

export interface ReplyContext {
  /** The post being replied to. Empty when it could not be read. */
  parentText: string;
  maxChars: number;
}

/** Compliment as the payload, rather than as a clause in front of a point. */
const COMPLIMENT =
  /\b(?:great|good|nice|excellent|amazing|awesome|brilliant|solid|fantastic|incredible|insightful|underrated)\s+(?:post|thread|point|take|read|write-?up|analysis|work|stuff|breakdown)\b|\blove (?:this|it|that)\b|\bthis is (?:so )?(?:good|great|it|gold|fire)\b|\bwell said\b|\bcouldn'?t agree more\b|\bso true\b|\b(?:congrats|congratulations)\b|\bthanks for sharing\b|\bfacts\b|\bbased\b|\bthis\.?$/i;

/** A question asked to farm a reply rather than to get an answer. */
const FAKE_QUESTION =
  /\b(?:what (?:do you|are your)|any) (?:think|thoughts|takes?)\b|\bthoughts\?|\bagree\?|\bam i wrong\?|\bwho else\b|\bright\?$/i;

/** Nothing under someone else's post should be selling. */
const CTA =
  /\b(?:follow me|following me|check out my|link in bio|dm me|drop a follow|retweet|rt if|i built|i'?m building)\b.*\b(?:link|here|below|bio)\b|\bfollow (?:me|us) for\b|\blink in bio\b|\bdm me\b/i;

/** Openers that only work at the top of a timeline, not under a post. */
const STANDALONE_HOOK =
  /^\s*(?:thread|🧵|a thread)\b|^\s*(?:most people|nobody|everyone) (?:don'?t|doesn'?t|does not|is|are|thinks?)\b|^\s*here'?s (?:the thing|why|how|what)\b|^\s*\d+\s*(?:\/|\.)\s|^\s*unpopular opinion\b|^\s*hot take\b/i;

const EMOJI = /\p{Extended_Pictographic}/gu;

/** Words that carry meaning, for measuring how much of the parent got parroted. */
function contentWords(text: string): Set<string> {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "to", "of",
    "in", "on", "for", "with", "that", "this", "it", "its", "as", "at", "by", "from", "you",
    "your", "i", "we", "they", "he", "she", "not", "no", "so", "if", "then", "than", "just",
    "can", "will", "would", "about", "have", "has", "had", "do", "does", "did", "what", "how",
  ]);
  const latin = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
  // CJK has no spaces, so bigrams stand in for words.
  const cjk = text.match(/[぀-ヿ一-鿿]/g) ?? [];
  const bigrams = cjk.slice(0, -1).map((c, i) => c + cjk[i + 1]);
  return new Set([...latin.filter((w) => !stop.has(w)), ...bigrams]);
}

/** How much of the reply is words the parent already used. */
function overlapRatio(reply: string, parent: string): number {
  const replyWords = contentWords(reply);
  const parentWords = contentWords(parent);
  if (!replyWords.size || !parentWords.size) return 0;
  let shared = 0;
  for (const word of replyWords) if (parentWords.has(word)) shared += 1;
  return shared / replyWords.size;
}

/** A number, a proper noun, or a name -- the things that make a take concrete. */
function hasSpecifics(text: string): boolean {
  return (
    /\d/.test(text) ||
    /\b[A-Z][a-zA-Z0-9.+-]{2,}\b/.test(text.replace(/^[^a-zA-Z]*/, "").slice(1)) ||
    /[一-鿿]{4,}/.test(text)
  );
}

/**
 * Everything mechanically wrong with this reply, phrased as an instruction to fix it.
 *
 * An empty array does not mean the reply is good -- only that it is not one of
 * the shapes that is reliably bad.
 */
export function replyProblems(text: string, ctx: ReplyContext): string[] {
  const problems: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return ["The reply is empty."];

  const length = weightedLength(trimmed);
  if (length > ctx.maxChars) {
    problems.push(
      `The reply is ${length} characters by X's weighted count, over the ${ctx.maxChars} limit. Cut it.`,
    );
  }

  if (/^\s*@\w/.test(trimmed)) {
    problems.push("It opens with the author's handle. X already threads the reply; drop it.");
  }

  const emojiCount = (trimmed.match(EMOJI) ?? []).length;
  const withoutCompliment = trimmed.replace(COMPLIMENT, " ").replace(EMOJI, " ").trim();

  if (COMPLIMENT.test(trimmed) && weightedLength(withoutCompliment) < 40) {
    problems.push(
      "The whole reply is a compliment. Replace it with one concrete agreement or disagreement and the reason for it.",
    );
  } else if (!hasSpecifics(trimmed) && weightedLength(trimmed) < 40 && emojiCount > 0) {
    problems.push("It's a reaction, not a reply. Say something with a claim in it.");
  }

  if (emojiCount >= 3) {
    problems.push("Too many emoji for a reply. One at most, and only if it is doing work.");
  }

  if (ctx.parentText.trim()) {
    const overlap = overlapRatio(trimmed, ctx.parentText);
    if (overlap >= 0.6) {
      problems.push(
        "It restates the post it is replying to. The reader just read that. Cut the recap and lead with what you are adding.",
      );
    }
  }

  if (FAKE_QUESTION.test(trimmed)) {
    problems.push("It ends on a question asked for engagement. Delete it and end on the point.");
  }

  if (CTA.test(trimmed)) {
    problems.push("It contains a call to action. A reply promotes nothing.");
  }

  if (STANDALONE_HOOK.test(trimmed)) {
    problems.push(
      "It opens like a standalone post. Under someone else's words a hook reads as a hijack -- start on the substance.",
    );
  }

  return problems;
}
