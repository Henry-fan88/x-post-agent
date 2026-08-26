/**
 * Reading X posts.
 *
 * Two paths, in preference order:
 *   1. X API v2, when X_BEARER_TOKEN is set -- full text plus author and metrics.
 *   2. Public oEmbed, which needs no credentials and returns the post text.
 *
 * Nothing here writes to X. Drafts are handed to the user, who posts them.
 */

import type { SourceDoc } from "../types";

const TIMEOUT_MS = 8000;

export interface XRef {
  id: string;
  handle: string;
  url: string;
}

/** Recognises x.com / twitter.com status links, including /i/web/status/ and query strings. */
export function parseXUrl(raw: string): XRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (!["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com", "vxtwitter.com", "fxtwitter.com"].includes(host)) {
    return null;
  }
  const m = url.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/);
  if (m) return { handle: m[1], id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` };

  const web = url.pathname.match(/^\/i\/web\/status\/(\d+)/);
  if (web) return { handle: "", id: web[1], url: `https://x.com/i/web/status/${web[1]}` };

  return null;
}

export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>()"']+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:)\]]+$/, "")))];
}

export async function readXPost(ref: XRef, bearerToken?: string): Promise<SourceDoc | null> {
  if (bearerToken) {
    const viaApi = await readViaApi(ref, bearerToken);
    if (viaApi) return viaApi;
  }
  return await readViaOembed(ref);
}

async function readViaApi(ref: XRef, token: string): Promise<SourceDoc | null> {
  const url = new URL(`https://api.x.com/2/tweets/${ref.id}`);
  url.searchParams.set("tweet.fields", "created_at,public_metrics,note_tweet,lang");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,description");

  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: {
        text?: string;
        created_at?: string;
        note_tweet?: { text?: string };
        public_metrics?: Record<string, number>;
      };
      includes?: { users?: { username?: string; name?: string }[] };
    };
    const data = json.data;
    if (!data) return null;

    const author = json.includes?.users?.[0];
    // note_tweet holds the full text of posts over the classic length limit.
    const text = data.note_tweet?.text || data.text || "";
    const metrics = data.public_metrics
      ? ` (${data.public_metrics.like_count ?? 0} likes, ${data.public_metrics.reply_count ?? 0} replies)`
      : "";

    return {
      kind: "x_post",
      url: ref.url,
      title: `Post by @${author?.username ?? ref.handle}${metrics}`,
      text,
      author: author?.username ? `@${author.username}` : undefined,
      publishedAt: data.created_at,
    };
  } catch {
    return null;
  }
}

async function readViaOembed(ref: XRef): Promise<SourceDoc | null> {
  const url = new URL("https://publish.twitter.com/oembed");
  url.searchParams.set("url", ref.url);
  url.searchParams.set("omit_script", "1");
  url.searchParams.set("dnt", "true");

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;

    const json = (await res.json()) as { html?: string; author_name?: string; author_url?: string };
    if (!json.html) return null;

    const text = stripHtml(json.html);
    if (!text) return null;

    const handle = json.author_url?.split("/").filter(Boolean).pop() ?? ref.handle;
    return {
      kind: "x_post",
      url: ref.url,
      title: `Post by ${json.author_name ?? `@${handle}`}`,
      text,
      author: handle ? `@${handle}` : undefined,
    };
  } catch {
    return null;
  }
}

/** oEmbed returns a blockquote; we want just the post text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "--")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    // oEmbed appends an attribution line: "— Name (@handle) March 21, 2006".
    // Matches "--" too, since &mdash; is decoded above before we get here.
    .replace(/\s*(?:\u2014|--)\s*[^\n]*\(@[^)]+\)\s*\w+\s+\d{1,2},\s*\d{4}\s*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
