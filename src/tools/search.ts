/**
 * Web search, behind one interface so the provider is a config change.
 *
 * SEARCH_PROVIDER=none is the default: the agent then works purely from the
 * user's input and any links in it, which is the right behaviour for an idea
 * the user already knows more about than the web does.
 */

import type { SourceDoc } from "../types";

const TIMEOUT_MS = 8000;
const SNIPPET_CHARS = 700;

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SourceDoc[]>;
}

export function createSearchProvider(env: Env): SearchProvider | null {
  const provider = (env.SEARCH_PROVIDER || "none").toLowerCase();
  const key = env.SEARCH_API_KEY?.trim();
  if (provider === "none" || !provider) return null;
  if (!key) return null;

  switch (provider) {
    case "brave":
      return braveSearch(key);
    case "tavily":
      return tavilySearch(key);
    case "exa":
      return exaSearch(key);
    default:
      return null;
  }
}

function braveSearch(key: string): SearchProvider {
  return {
    name: "brave",
    async search(query, limit) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(limit));
      const res = await fetch(url, {
        headers: { accept: "application/json", "x-subscription-token": key },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] };
      };
      return (json.web?.results ?? []).slice(0, limit).map((r) => ({
        kind: "search" as const,
        url: r.url ?? "",
        title: r.title ?? r.url ?? "",
        text: clean(r.description ?? ""),
        publishedAt: r.age,
      }));
    },
  };
}

function tavilySearch(key: string): SearchProvider {
  return {
    name: "tavily",
    async search(query, limit) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: "basic" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        results?: { title?: string; url?: string; content?: string; published_date?: string }[];
      };
      return (json.results ?? []).slice(0, limit).map((r) => ({
        kind: "search" as const,
        url: r.url ?? "",
        title: r.title ?? r.url ?? "",
        text: clean(r.content ?? ""),
        publishedAt: r.published_date,
      }));
    },
  };
}

function exaSearch(key: string): SearchProvider {
  return {
    name: "exa",
    async search(query, limit) {
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          query,
          numResults: limit,
          contents: { text: { maxCharacters: SNIPPET_CHARS } },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        results?: { title?: string; url?: string; text?: string; publishedDate?: string }[];
      };
      return (json.results ?? []).slice(0, limit).map((r) => ({
        kind: "search" as const,
        url: r.url ?? "",
        title: r.title ?? r.url ?? "",
        text: clean(r.text ?? ""),
        publishedAt: r.publishedDate,
      }));
    },
  };
}

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}
