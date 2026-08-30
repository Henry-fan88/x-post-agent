/**
 * Transcript providers -- reading a video's captions through someone else.
 *
 * The direct reader in `youtube.ts` works from a residential IP and not from a
 * datacenter one. Measured from this Worker's own egress, every InnerTube client
 * comes back with "Sign in to confirm you're not a bot" and no caption tracks,
 * while the identical request from a laptop returns the tracks. Public front-end
 * instances (Invidious, Piped) are blocked the same way, and the keyless
 * transcript services rate-limit Cloudflare's shared egress as one huge caller.
 *
 * So a deployed instance needs an account somewhere: a key moves the rate limit
 * from "every Worker on this IP" to "this user". That is the whole reason this
 * layer exists.
 *
 * Shaped like `search.ts` on purpose -- one interface, a provider chosen by
 * config, and a key that can be stored from the UI rather than redeployed.
 */

import type { ResolvedConfig } from "../config/settings";
import type { Cue } from "./youtube";

export interface TranscriptProvider {
  name: string;
  /** Cues in video order, or null when this video has no transcript to give. */
  fetch(videoUrl: string): Promise<Cue[] | null>;
}

const TIMEOUT_MS = 30_000;
/**
 * How long to wait on a provider that queues long videos.
 *
 * A three-hour talk is exactly the case this whole feature exists for, and it is
 * also the case a provider is most likely to hand back a job id. Bounded well
 * inside the Worker's request budget: giving up here costs a warning, while
 * hanging costs the user their turn.
 */
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 1500;

export function createTranscriptProvider(cfg: ResolvedConfig): TranscriptProvider | null {
  const key = cfg.transcriptApiKey;

  switch (cfg.transcriptProvider) {
    case "supadata":
      return key ? supadata(key) : null;
    default:
      return null;
  }
}

/**
 * Supadata's transcript endpoint.
 *
 * `mode=native` on purpose: it fetches captions the video already has and never
 * falls back to paid AI transcription. A video with no captions should come back
 * empty and cost nothing, not silently bill for generating one.
 */
function supadata(apiKey: string): TranscriptProvider {
  const base = "https://api.supadata.ai/v1/transcript";
  const headers = { "x-api-key": apiKey };

  return {
    name: "supadata",
    async fetch(videoUrl: string): Promise<Cue[] | null> {
      const url = new URL(base);
      url.searchParams.set("url", videoUrl);
      url.searchParams.set("lang", "en");
      url.searchParams.set("mode", "native");

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });

      // 202 means it queued the video and handed back a job to poll.
      if (res.status === 202) {
        const { jobId } = (await res.json()) as { jobId?: string };
        return jobId ? await pollSupadata(jobId, headers) : null;
      }
      if (!res.ok) throw new Error(await providerError(res));

      return cuesFrom((await res.json()) as SupadataBody);
    },
  };
}

async function pollSupadata(jobId: string, headers: HeadersInit): Promise<Cue[] | null> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));

    const res = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(await providerError(res));

    const body = (await res.json()) as SupadataBody & { status?: string; error?: string };
    if (body.status === "failed") throw new Error(body.error || "the provider's job failed");
    if (body.status === "completed" || body.content !== undefined) return cuesFrom(body);
  }
  throw new Error("the provider was still working on it after 10 seconds");
}

interface SupadataBody {
  /** A string when the request asked for plain text, chunks otherwise. */
  content?: string | { text?: string; offset?: number }[];
}

/**
 * Turn a provider's chunks into cues.
 *
 * Timestamps are what make a transcript quotable -- "he says at 2:44" rather
 * than "somewhere in three hours" -- so the chunked shape is the one worth
 * asking for. A provider that only returns flat text still works; it just
 * arrives as one long cue starting at zero, which `paragraphs` then splits.
 */
export function cuesFrom(body: SupadataBody): Cue[] | null {
  const content = body.content;
  if (content === undefined || content === null) return null;

  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ start: 0, text }] : [];
  }
  if (!Array.isArray(content)) return null;

  const cues: Cue[] = [];
  for (const chunk of content) {
    const text = (chunk?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    cues.push({ start: Math.max(0, Math.round((chunk.offset ?? 0) / 1000)), text });
  }
  return cues;
}

/** The provider's own words about the failure, so a warning can name the cause. */
async function providerError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    detail = body.message || body.error || "";
  } catch {
    /* Not JSON. The status alone will have to do. */
  }
  if (res.status === 401 || res.status === 403) {
    return `the transcript key was rejected (${res.status})`;
  }
  if (res.status === 429) return "the transcript provider's quota is used up";
  return detail ? `${detail} (${res.status})` : `the transcript provider returned ${res.status}`;
}
