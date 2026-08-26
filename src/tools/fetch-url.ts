/**
 * Read a web page into plain text using HTMLRewriter (native in Workers, so no
 * DOM parser dependency).
 */

import type { SourceDoc } from "../types";

const UA =
  "Mozilla/5.0 (compatible; x-post-agent/0.1; +https://github.com/Henry-fan88/x-post-agent)";
const MAX_CHARS = 6000;
const TIMEOUT_MS = 8000;

/** Tags whose text is navigation furniture rather than content. */
const DROP = "script,style,noscript,nav,header,footer,aside,form,svg,iframe";
/** Tags that carry the readable body. */
const KEEP = "article p,article li,article h1,article h2,main p,main li,main h1,main h2,p,li,h1,h2,h3,blockquote";

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
  const chunks: string[] = [];
  let budget = MAX_CHARS;

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
        el.remove();
      },
    })
    .on(KEEP, {
      text(t) {
        if (budget <= 0) return;
        const s = t.text.replace(/\s+/g, " ");
        if (!s.trim()) return;
        chunks.push(s);
        budget -= s.length;
        if (t.lastInTextNode) chunks.push("\n");
      },
    });

  // The rewriter only runs as the body is consumed.
  await rewriter.transform(res).arrayBuffer();

  const body = chunks
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_CHARS);

  const text = [description.trim(), body].filter(Boolean).join("\n\n");
  if (!text) return null;

  return { kind: "web", url, title: title.trim() || url, text };
}
