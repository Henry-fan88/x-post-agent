/**
 * Reading text the way X does: how long it counts, and what language it is in.
 *
 * Both questions come down to the same scan over code points, which is why they
 * live together.
 *
 * # Length
 *
 * Not code points. X applies a weighted count: characters in the Latin-ish
 * ranges cost 1, everything else -- CJK, most emoji, Cyrillic, Arabic -- costs
 * 2, and every URL is replaced by a t.co link of fixed length however long it
 * actually is. So 140 Chinese characters is a full 280-character post, and a
 * 200-character URL costs 23.
 *
 * Counting code points overstates what fits for a link-heavy post and
 * understates it by half for a Chinese one, which is the difference between a
 * draft the user can post and one X rejects. Implemented locally rather than
 * pulled from twitter-text: the rule is a handful of ranges, and a Worker should
 * not carry a dependency for it.
 *
 * Reference: X's configuration v3 weighted-length rules.
 */

/** Every URL becomes a t.co link of this length, https or not. */
export const URL_WEIGHT = 23;

const DEFAULT_WEIGHT = 2;
const LIGHT_WEIGHT = 1;

/**
 * Ranges that cost 1. Everything outside them costs 2.
 *
 * Straight from X's published ranges: Latin and its supplements, general
 * punctuation for the quotes and dashes people actually type, and nothing else.
 */
const LIGHT_RANGES: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

/** Matches what X's extractor treats as a link. Deliberately generous. */
const URL_RE = /https?:\/\/[^\s<>()"']+|(?:^|\s)(?:www\.)[^\s<>()"']+/gi;

function weightOf(codePoint: number): number {
  for (const [lo, hi] of LIGHT_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return LIGHT_WEIGHT;
  }
  return DEFAULT_WEIGHT;
}

/**
 * What X will count this text as.
 *
 * Emoji land on the 2-weight path by falling outside the light ranges, and
 * because this iterates code points rather than UTF-16 units a surrogate pair
 * costs 2 in total rather than 2 per half.
 */
export function weightedLength(text: string): number {
  let total = 0;
  let cursor = 0;

  URL_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    // A leading space captured by the www. branch is ordinary text, not the link.
    const lead = match[0].length - match[0].trimStart().length;
    total += weighUnlinked(text.slice(cursor, start + lead));
    total += URL_WEIGHT;
    cursor = start + match[0].length;
  }
  total += weighUnlinked(text.slice(cursor));

  return total;
}

function weighUnlinked(text: string): number {
  let total = 0;
  for (const char of text) total += weightOf(char.codePointAt(0) ?? 0);
  return total;
}

/** True when the post is over budget by X's own count. */
export function overBudget(text: string, maxChars: number): boolean {
  return weightedLength(text) > maxChars;
}

/* -------------------------------- language ------------------------------- */

export type Script = "cjk" | "latin" | "cyrillic" | "arabic" | "other";

/**
 * Which script the text is mostly written in.
 *
 * Not language detection -- it cannot tell Chinese from Japanese, and does not
 * need to. It exists so a prompt can say "the post you are replying to is
 * written in Chinese; reply in Chinese", which is the whole of the language
 * requirement: match what is in front of you. Anything finer is a job for the
 * model, which reads the source text anyway.
 *
 * URLs and handles are stripped first, since a Chinese post carrying an English
 * link is still a Chinese post.
 */
export function dominantScript(text: string): Script {
  const stripped = text
    .replace(URL_RE, " ")
    .replace(/[@#][\w\u4e00-\u9fff]+/g, " ");

  const counts: Record<Script, number> = { cjk: 0, latin: 0, cyrillic: 0, arabic: 0, other: 0 };
  for (const char of stripped) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x0041) continue; // digits, spaces and punctuation belong to no script
    const script = scriptOf(cp);
    if (script) counts[script] += 1;
  }

  let best: Script = "latin";
  let bestCount = 0;
  for (const [script, count] of Object.entries(counts) as [Script, number][]) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return bestCount === 0 ? "latin" : best;
}

function scriptOf(cp: number): Script | null {
  if (
    (cp >= 0x3040 && cp <= 0x30ff) || // kana
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || // unified ideographs
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xac00 && cp <= 0xd7af) // hangul
  ) {
    return "cjk";
  }
  if (cp >= 0x0400 && cp <= 0x04ff) return "cyrillic";
  if (cp >= 0x0600 && cp <= 0x06ff) return "arabic";
  if ((cp >= 0x0041 && cp <= 0x024f) || (cp >= 0x1e00 && cp <= 0x1eff)) return "latin";
  return null;
}

/** How to name the script in a prompt. */
export function scriptName(script: Script): string {
  switch (script) {
    case "cjk":
      return "Chinese/Japanese/Korean";
    case "cyrillic":
      return "Cyrillic";
    case "arabic":
      return "Arabic";
    default:
      return "Latin-script";
  }
}
