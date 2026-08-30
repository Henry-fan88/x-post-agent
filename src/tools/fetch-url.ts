/**
 * Read a web page into plain text using HTMLRewriter (native in Workers, so no
 * DOM parser dependency).
 */

import type { SourceDoc } from "../types";

const UA =
  "Mozilla/5.0 (compatible; x-post-agent/0.1; +https://github.com/Henry-fan88/x-post-agent)";
/**
 * How much of a page to keep.
 *
 * Generous enough for a long-form essay, because a source the user asked the
 * agent to *learn* has to be read whole rather than skimmed. What reaches any
 * one prompt is capped separately, in `prompts.ts`.
 */
const MAX_CHARS = 12_000;
const TIMEOUT_MS = 10_000;

/**
 * Tags whose text is furniture rather than content.
 *
 * These are skipped by depth rather than by `element.remove()`. Removing an
 * element only takes it out of the transformed output, which this function
 * throws away -- text handlers still fire for everything inside it. That is why
 * a page's stylesheet used to end up in the middle of its first paragraph.
 */
const DROP = "script,style,noscript,nav,header,footer,aside,form,svg,iframe,figcaption";

/**
 * Where the article lives, on a page that says.
 *
 * Text inside these is collected separately, and preferred when there is enough
 * of it -- the difference between reading a Wikipedia article and reading its
 * sidebar, table of contents and language list as well.
 */
const BODY = 'article,main,[role="main"]';
/**
 * Tags that carry the readable body.
 *
 * Kept free of overlap on purpose. A selector list registers the handler once
 * per selector, so `article p, p` would capture every paragraph inside an
 * `<article>` twice and spend the budget on duplicates. `DROP` has already taken
 * out the furniture, so the bare tags are enough.
 */
const KEEP = "p,li,h1,h2,h3,blockquote,pre";

/**
 * Rejects URLs that aren't public http(s). The agent fetches links that arrive
 * in user input and in search results, so this keeps it from being pointed at
 * loopback or private-range addresses.
 */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return false;
  }
  // IPv4 literals in private / loopback / link-local ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
  }
  if (host === "::1" || host.startsWith("[")) return false;
  return true;
}

export async function fetchUrlAsText(url: string): Promise<SourceDoc | null> {
  if (!isFetchableUrl(url)) return null;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text/plain")) {
    return null;
  }

  if (contentType.includes("text/plain")) {
    const text = (await res.text()).slice(0, MAX_CHARS);
    return { kind: "web", url, title: url, text };
  }

  let title = "";
  let description = "";

  // Two collectors, one pass: what is inside the marked-up article, and
  // everything, for the many pages that mark up nothing.
  const scoped = collector();
  const whole = collector();

  // Depth counters rather than removals -- see the note on DROP.
  let dropDepth = 0;
  let bodyDepth = 0;

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(t) {
        if (title.length < 200) title += t.text;
      },
    })
    .on('meta[property="og:description"], meta[name="description"]', {
      element(el) {
        if (!description) description = el.getAttribute("content") ?? "";
      },
    })
    .on(DROP, {
      element(el) {
        dropDepth++;
        onEndTag(el, () => {
          dropDepth--;
        });
      },
    })
    .on(BODY, {
      element(el) {
        bodyDepth++;
        onEndTag(el, () => {
          bodyDepth--;
        });
      },
    })
    .on(KEEP, {
      text(t) {
        if (dropDepth > 0) return;
        const s = t.text.replace(/\s+/g, " ");
        if (!s.trim()) return;
        whole.push(s, t.lastInTextNode);
        if (bodyDepth > 0) scoped.push(s, t.lastInTextNode);
      },
    });

  // The rewriter only runs as the body is consumed.
  await rewriter.transform(res).arrayBuffer();

  // A <main> holding a heading and a byline means the content is elsewhere, so
  // only trust the scoped read when there is an article's worth of it.
  const inArticle = scoped.text();
  const body = inArticle.length >= MIN_ARTICLE_CHARS ? inArticle : whole.text();

  const text = [description.trim(), body].filter(Boolean).join("\n\n");
  if (!text) return null;

  return { kind: "web", url, title: title.trim() || url, text };
}

/** Below this, a page's <article>/<main> is a wrapper rather than the article. */
const MIN_ARTICLE_CHARS = 400;

/** Accumulates text within a character budget, joining text nodes into lines. */
function collector() {
  const chunks: string[] = [];
  let budget = MAX_CHARS;

  return {
    push(s: string, lastInTextNode: boolean): void {
      if (budget <= 0) return;
      chunks.push(s);
      budget -= s.length;
      if (lastInTextNode) chunks.push("\n");
    },
    text(): string {
      return chunks
        .join("")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
        .slice(0, MAX_CHARS);
    },
  };
}

/**
 * Run `fn` when the element closes.
 *
 * An element with no end tag -- self-closing, or void -- was entered and left in
 * the same breath, so the fallback runs immediately and keeps the depth counters
 * balanced.
 */
function onEndTag(el: Element, fn: () => void): void {
  try {
    el.onEndTag(fn);
  } catch {
    fn();
  }
}
