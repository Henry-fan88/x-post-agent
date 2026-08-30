/**
 * Reading YouTube videos, by their captions.
 *
 * A YouTube watch page is a shell: the HTML reader in `fetch-url.ts` comes back
 * with chrome -- "Sign in", "Subscribe", cookie copy -- and none of the talk. So
 * a link to a three-hour explainer used to reach the model as nothing at all,
 * and the only honest post it could write was "someone recommends this video".
 *
 * The method here is the one `youtube-transcript-api` uses
 * (https://github.com/jdepoix/youtube-transcript-api). That library is Python,
 * so it cannot be imported into a Worker; what it knows -- which undocumented
 * endpoints hold the caption list, and in what shape -- is what has been ported:
 *
 *   1. POST the InnerTube `player` endpoint as the Android client, which
 *      returns the video's details and its caption track list.
 *   2. GET the chosen track's `baseUrl`, which serves the timed text.
 *
 * Both are undocumented and used by YouTube's own clients, so either could
 * change without notice. Every failure here returns null, which the orchestrator
 * reports as a link it could not open -- the agent says so rather than drafting
 * from a title it guessed at.
 */

import type { SourceDoc } from "../types";
import type { TranscriptProvider } from "./transcript";

/**
 * The Android client's public InnerTube key.
 *
 * The Python library scrapes an equivalent key out of the watch page on every
 * call. Going straight to the API skips a request that is the most likely one to
 * be answered with a consent interstitial; `innertubeKeyFromWatchPage` is the
 * fallback for the day this constant is retired.
 */
const ANDROID_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";
const CLIENT_VERSION = "20.10.38";
const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?key=";
const WATCH_URL = "https://www.youtube.com/watch?v=";

/** The Android app's own user agent. The web one gets a different, poorer response. */
const UA = `com.google.android.youtube/${CLIENT_VERSION} (Linux; U; Android 11) gzip`;

const TIMEOUT_MS = 10_000;

/**
 * How much transcript to keep.
 *
 * Tied to SOURCE_BUDGET in `prompts.ts` rather than to the web reader's larger
 * budget, and for a specific reason: storing more than one prompt can carry
 * doesn't preserve the extra, it just moves where the cut happens. The prompt
 * cuts tails, and a tail is the last forty minutes of the talk. Here the cut is
 * spread across the runtime instead, so this is the better place to make it.
 *
 * An hour of speech is far more text than this either way. See `condense`.
 */
const MAX_CHARS = 9_000;
/** Of that, what the uploader's description may take before the transcript starts. */
const DESCRIPTION_CHARS = 600;
/** Roughly a paragraph of speech per timestamp marker. */
const PARAGRAPH_CHARS = 420;

/** Caption languages to prefer when a video is captioned in several. */
const PREFERRED = ["en"];

export interface YouTubeRef {
  id: string;
  /** Canonical watch URL, so the same video linked three ways dedupes to one source. */
  url: string;
  /** Seconds, when the link points at a moment in the video rather than at the video. */
  at: number | null;
}

const HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

/** Video ids are exactly 11 characters of the URL-safe alphabet. */
const ID = /^[\w-]{11}$/;

/**
 * Recognises the several shapes a YouTube link comes in: watch, youtu.be,
 * shorts, embed, live. Returns null for a channel or a playlist -- those have no
 * transcript, and the HTML reader should have them instead.
 */
export function parseYouTubeUrl(raw: string): YouTubeRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (!HOSTS.has(host)) return null;

  const path = url.pathname;
  let id = "";

  if (host === "youtu.be") {
    id = path.slice(1).split("/")[0];
  } else if (path === "/watch") {
    id = url.searchParams.get("v") ?? "";
  } else {
    const m = path.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    if (m) id = m[1];
  }
  if (!ID.test(id)) return null;

  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    at: parseTimestamp(url.searchParams.get("t") ?? url.searchParams.get("start")),
  };
}

/** `t` arrives as `90`, `90s`, or `1h2m30s`. */
export function parseTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (/^\d+$/.test(value)) return Number(value);

  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/* ------------------------------- fetching -------------------------------- */

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  /** "asr" for machine transcription. Absent on human-written captions. */
  kind?: string;
}

interface PlayerResponse {
  /** "OK", or a reason the video cannot be played: private, removed, age-gated. */
  playabilityStatus?: { status?: string };
  videoDetails?: {
    title?: string;
    author?: string;
    shortDescription?: string;
    lengthSeconds?: string;
  };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

export interface Cue {
  /** Seconds from the start of the video. */
  start: number;
  text: string;
}

/**
 * Read a video as a source document.
 *
 * A video with no captions still comes back, carrying the uploader's own
 * description and saying plainly that it has no transcript. That is worth more
 * than nothing and, unlike a scraped watch page, it cannot be mistaken for a
 * record of what was said.
 */
export async function readYouTubeVideo(
  ref: YouTubeRef,
  provider?: TranscriptProvider | null,
): Promise<SourceDoc | null> {
  const player = await fetchPlayer(ref.id);
  const blocked = !player || (player.playabilityStatus?.status ?? "OK") !== "OK";

  // The direct path is gone -- either YouTube refused this egress, or the video
  // is private, removed or age-gated. A provider can tell those apart by
  // succeeding, so it is worth asking before giving up.
  if (blocked) return provider ? await readViaProvider(ref, provider) : null;

  const details = player.videoDetails;
  const title = details?.title?.trim() || ref.url;
  const author = details?.author?.trim() || "";
  const seconds = Number(details?.lengthSeconds ?? 0) || 0;

  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  let cues = track ? await fetchCues(track) : [];

  // Tracks listed but empty is the other shape the block takes: the caption list
  // survives in a cache while the text behind it does not.
  if (!cues.length && provider) {
    const viaProvider = await readViaProvider(ref, provider);
    if (viaProvider) return viaProvider;
    cues = [];
  }

  // The description is labelled rather than run in with the transcript: it is
  // the uploader's pitch, sponsor copy and all, and the model has to be able to
  // tell an advertisement for the video from something said in it.
  const description = (details?.shortDescription ?? "").trim().slice(0, DESCRIPTION_CHARS);
  const header = [
    [author, seconds ? runtime(seconds) : ""].filter(Boolean).join(" · "),
    description && `Uploader's description:\n${description}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!cues.length) {
    if (!header) return null;
    return {
      kind: "video",
      url: ref.url,
      title,
      author: author || undefined,
      text: `${header}\n\nThis video has no captions, so nothing below is a record of what was said -- the text above is the uploader's own description.`,
    };
  }

  const label = `${track?.kind === "asr" ? "Auto-generated captions" : "Captions"} (${track?.languageCode ?? "?"})`;
  const budget = MAX_CHARS - header.length - label.length - 64;
  const body = condense(paragraphs(cues), budget, ref.at);

  return {
    kind: "video",
    url: ref.url,
    title,
    author: author || undefined,
    text: `${header}\n\n${label}:\n${body}`.slice(0, MAX_CHARS),
  };
}

/**
 * Read a video through a configured provider.
 *
 * The provider returns captions and nothing else, so the title and channel come
 * from YouTube's oEmbed endpoint -- the one part of YouTube that still answers
 * this Worker's egress, because it is meant to be called by other people's
 * servers. Without it a transcript would arrive with no idea whose it was.
 */
async function readViaProvider(
  ref: YouTubeRef,
  provider: TranscriptProvider,
): Promise<SourceDoc | null> {
  const [cues, meta] = await Promise.all([
    provider.fetch(ref.url).catch(() => null),
    fetchOembed(ref.id),
  ]);
  if (!cues?.length) return null;

  const title = meta?.title || ref.url;
  const author = meta?.author || "";
  const header = author ? `${author} · via ${provider.name}` : `via ${provider.name}`;
  const budget = MAX_CHARS - header.length - 64;

  return {
    kind: "video",
    url: ref.url,
    title,
    author: author || undefined,
    text: `${header}\n\nCaptions:\n${condense(paragraphs(cues), budget, ref.at)}`.slice(0, MAX_CHARS),
  };
}

/** Title and channel, from the one YouTube endpoint that allows other servers in. */
async function fetchOembed(videoId: string): Promise<{ title: string; author: string } | null> {
  try {
    const url = new URL("https://www.youtube.com/oembed");
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
    url.searchParams.set("format", "json");

    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;

    const body = (await res.json()) as { title?: string; author_name?: string };
    return { title: (body.title ?? "").trim(), author: (body.author_name ?? "").trim() };
  } catch {
    return null;
  }
}

/**
 * Ask the InnerTube player endpoint for the video.
 *
 * Retried once with a key lifted from the watch page, which is where the Python
 * library gets its key every time. Worth the second request only when the
 * constant above has stopped working.
 */
async function fetchPlayer(videoId: string): Promise<PlayerResponse | null> {
  const first = await postPlayer(videoId, ANDROID_KEY);
  if (first?.captions || first?.videoDetails) return first;

  const scraped = await innertubeKeyFromWatchPage(videoId);
  if (!scraped || scraped === ANDROID_KEY) return first;
  return (await postPlayer(videoId, scraped)) ?? first;
}

async function postPlayer(videoId: string, key: string): Promise<PlayerResponse | null> {
  try {
    const res = await fetch(PLAYER_URL + key, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": UA,
        "accept-language": "en-US,en",
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: CLIENT_VERSION,
            androidSdkVersion: 30,
            hl: "en",
            gl: "US",
          },
        },
        videoId,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as PlayerResponse;
  } catch {
    return null;
  }
}

async function innertubeKeyFromWatchPage(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(WATCH_URL + videoId, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "en-US,en",
        // Skips the EU consent interstitial, which serves no player data.
        cookie: "CONSENT=YES+cb; SOCS=CAI",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html.match(/"INNERTUBE_API_KEY":\s*"([\w-]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Choose one track out of the list.
 *
 * Language first, then human captions over machine ones: an English auto-caption
 * is a better reading of an English talk than a hand-written Portuguese
 * translation of it. When nothing matches a preferred language the video is not
 * in one, and its own captions -- whatever language they are in -- are the point.
 */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const usable = tracks.filter((t) => t.baseUrl);
  if (!usable.length) return null;

  const score = (t: CaptionTrack): number => {
    const lang = (t.languageCode ?? "").toLowerCase().split("-")[0];
    return (PREFERRED.includes(lang) ? 2 : 0) + (t.kind === "asr" ? 0 : 1);
  };

  let best = usable[0];
  for (const t of usable.slice(1)) if (score(t) > score(best)) best = t;
  return best;
}

/**
 * Fetch the timed text for a track.
 *
 * `fmt=json3` in preference to the default XML: a Worker has no XML parser, and
 * the XML form double-escapes its entities, so `&amp;#39;` has to be unescaped
 * twice to get an apostrophe back. `parseXmlCues` is the fallback for when json3
 * is refused.
 */
async function fetchCues(track: CaptionTrack): Promise<Cue[]> {
  const json = await getText(withFormat(track.baseUrl as string, "json3"));
  const fromJson = json ? parseJson3Cues(json) : [];
  if (fromJson.length) return fromJson;

  const xml = await getText(withFormat(track.baseUrl as string, null));
  return xml ? parseXmlCues(xml) : [];
}

function withFormat(baseUrl: string, fmt: string | null): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (fmt) url.searchParams.set("fmt", fmt);
  else url.searchParams.delete("fmt");
  return url.toString();
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "en-US,en" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

export function parseJson3Cues(raw: string): Cue[] {
  let parsed: { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const cues: Cue[] = [];
  for (const event of parsed.events ?? []) {
    // Auto-caption tracks carry timing-only events with no segs, between the
    // ones that hold words. They are scaffolding, not silence.
    if (!event.segs) continue;
    const text = clean(event.segs.map((s) => s.utf8 ?? "").join(""));
    if (!text) continue;
    cues.push({ start: Math.max(0, Math.round((event.tStartMs ?? 0) / 1000)), text });
  }
  return cues;
}

export function parseXmlCues(raw: string): Cue[] {
  const cues: Cue[] = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;

  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const start = Number(m[1].match(/\bstart="([\d.]+)"/)?.[1] ?? NaN);
    // Unescaped twice on purpose: the payload is HTML inside XML, so an
    // apostrophe arrives as "&amp;#39;".
    const text = clean(unescapeHtml(unescapeHtml(m[2])).replace(/<[^>]+>/g, ""));
    if (!text || Number.isNaN(start)) continue;
    cues.push({ start: Math.max(0, Math.round(start)), text });
  }
  return cues;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([\da-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function clean(s: string): string {
  // [Music] / [Applause] and the like are the caption track describing itself.
  return s
    .replace(/\[[A-Za-zÀ-ɏ ]{2,20}\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------- shaping --------------------------------- */

export interface Paragraph {
  start: number;
  text: string;
}

/**
 * Gather cues into paragraphs.
 *
 * Captions arrive as two-second fragments, which read as a list and cost a
 * timestamp each. A paragraph's worth of them, stamped once, is what a reader
 * would call a passage.
 */
export function paragraphs(cues: Cue[]): Paragraph[] {
  const out: Paragraph[] = [];
  let current: Paragraph | null = null;

  for (const cue of cues) {
    if (!current) {
      current = { start: cue.start, text: cue.text };
      continue;
    }
    current.text += ` ${cue.text}`;
    if (current.text.length >= PARAGRAPH_CHARS) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Fit the transcript into `budget` characters.
 *
 * Truncating would give the model the first fifteen minutes of a three-hour talk
 * and let it believe that was the talk. So the budget is spent across the whole
 * runtime instead: the opening, the moment the user linked to if they linked to
 * one, then passages chosen by repeatedly halving the remainder, which spreads
 * them evenly however many fit. Gaps are marked, so a jump from 0:12 to 1:40 is
 * visibly a jump and not a non-sequitur the model has to explain.
 */
export function condense(paras: Paragraph[], budget: number, focusAt: number | null): string {
  if (!paras.length) return "";

  const cost = (p: Paragraph): number => p.text.length + 12;
  const total = paras.reduce((n, p) => n + cost(p), 0);
  if (total <= budget) return render(paras, paras.map((_, i) => i));

  const keep = new Set<number>();
  let used = 0;
  const add = (i: number): void => {
    if (i < 0 || i >= paras.length || keep.has(i)) return;
    if (used + cost(paras[i]) > budget) return;
    keep.add(i);
    used += cost(paras[i]);
  };

  // What the video says it is about.
  add(0);
  add(1);
  // And the moment the link points at, with its lead-in.
  if (focusAt !== null) {
    const at = nearest(paras, focusAt);
    add(at);
    add(at - 1);
    add(at + 1);
  }
  for (const i of halvingOrder(paras.length)) add(i);

  return render(paras, [...keep].sort((a, b) => a - b));
}

function render(paras: Paragraph[], indices: number[]): string {
  const lines: string[] = [];
  let previous = -1;

  for (const i of indices) {
    if (previous >= 0 && i > previous + 1) lines.push("[...]");
    lines.push(`[${stamp(paras[i].start)}] ${paras[i].text}`);
    previous = i;
  }
  return lines.join("\n");
}

/** `[2:55:42] ...` or `[0:32] ...` -- a rendered passage, ready to be read back. */
const STAMPED = /^\[(?:(\d+):)?(\d+):(\d\d)\] ?([\s\S]*)$/;

/**
 * Re-fit an already-rendered transcript into a smaller budget.
 *
 * A prompt divides its source budget among however many sources the turn
 * gathered, so a transcript that fitted when it was stored may not fit when it
 * is used. Cutting the tail there would undo the spreading done here -- on a
 * three-hour talk it drops everything after the two-hour mark, including the
 * moment the user's own link pointed at. So the passages are read back and
 * re-spread instead, and the transcript still ends where the video does.
 */
export function fitVideoText(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const lines = text.split("\n");
  const first = lines.findIndex((line) => STAMPED.test(line));
  // No passages to re-spread: a description-only read, so a plain cut is right.
  if (first < 0) return text.slice(0, limit);

  const head = lines.slice(0, first).join("\n");
  const paras: Paragraph[] = [];
  for (const line of lines.slice(first)) {
    const m = line.match(STAMPED);
    // Skips the "[...]" gap markers, which `condense` puts back where they land.
    if (!m) continue;
    paras.push({
      start: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]),
      text: m[4],
    });
  }
  if (!paras.length) return text.slice(0, limit);

  const body = condense(paras, Math.max(0, limit - head.length - 1), null);
  return head ? `${head}\n${body}` : body;
}

/** The paragraph containing a moment, or the nearest one before it. */
function nearest(paras: Paragraph[], seconds: number): number {
  let best = 0;
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].start <= seconds) best = i;
    else break;
  }
  return best;
}

/**
 * Indices ordered so that any prefix of them is spread across the whole range:
 * the midpoint, then the midpoints of both halves, and so on.
 */
export function halvingOrder(n: number): number[] {
  const order: number[] = [];
  const queue: [number, number][] = [[0, n - 1]];

  while (queue.length) {
    const [lo, hi] = queue.shift() as [number, number];
    if (lo > hi) continue;
    const mid = (lo + hi) >> 1;
    order.push(mid);
    queue.push([lo, mid - 1], [mid + 1, hi]);
  }
  return order;
}

/** 0:07, 4:31, 2:56:16 -- the way a timestamp is written under a video. */
export function stamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

function runtime(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}
