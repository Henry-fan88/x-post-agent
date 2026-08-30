/**
 * D1-backed agent memory.
 *
 * Four kinds of memory, deliberately separated:
 *   - style_profile: the slow-moving model of the user's voice
 *   - samples:       real posts to imitate (few-shot corpus)
 *   - preferences:   atomic rules, injected into the prompt verbatim
 *   - notes:         what the user knows, distilled from sources they studied
 *   - format_stats:  what has been used lately, so drafts don't all look alike
 */

import type {
  FormatStat,
  Note,
  OutputMode,
  Preference,
  Sample,
  StyleProfile,
  Variant,
  Verdict,
} from "../types";

export const DEFAULT_USER = "default";

/**
 * Marks a turn where the agent read a source instead of writing a post.
 *
 * Study turns live in `drafts` so a session replays in order, but they are not
 * drafts: they carry no variants, take no verdict, and are excluded from format
 * statistics so reading three articles never looks like writing three posts.
 */
export const STUDY_KIND = "study";

export const DEFAULT_PROFILE: StyleProfile = {
  voice:
    "Plain, specific, and confident. Writes like a practitioner talking to peers.",
  tone: ["direct", "curious", "concrete"],
  do: [
    "Lead with the sharpest sentence",
    "Prefer concrete details over abstractions",
  ],
  dont: ["No engagement bait", "No corporate filler"],
  emoji: "never",
  hashtags: "never",
  capitalization: "sentence",
  max_chars: 280,
  audience: "Builders and engineers",
  topics: [],
  signature_moves: [],
};

/** Tolerates partial/corrupt stored JSON -- memory should never hard-fail a draft. */
function coerceProfile(raw: unknown): StyleProfile {
  const p = (raw ?? {}) as Partial<StyleProfile>;
  const arr = (v: unknown, fallback: string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;
  return {
    voice: typeof p.voice === "string" ? p.voice : DEFAULT_PROFILE.voice,
    tone: arr(p.tone, DEFAULT_PROFILE.tone),
    do: arr(p.do, DEFAULT_PROFILE.do),
    dont: arr(p.dont, DEFAULT_PROFILE.dont),
    emoji: p.emoji ?? DEFAULT_PROFILE.emoji,
    hashtags: p.hashtags ?? DEFAULT_PROFILE.hashtags,
    capitalization: p.capitalization ?? DEFAULT_PROFILE.capitalization,
    max_chars:
      typeof p.max_chars === "number" && p.max_chars > 0
        ? p.max_chars
        : DEFAULT_PROFILE.max_chars,
    audience: typeof p.audience === "string" ? p.audience : DEFAULT_PROFILE.audience,
    topics: arr(p.topics, DEFAULT_PROFILE.topics),
    signature_moves: arr(p.signature_moves, DEFAULT_PROFILE.signature_moves),
  };
}

export interface ProfileRecord {
  handle: string;
  bio: string;
  profile: StyleProfile;
  updated_at: string | null;
}

export async function getProfile(
  db: D1Database,
  userId = DEFAULT_USER,
): Promise<ProfileRecord> {
  const row = await db
    .prepare(
      "SELECT handle, bio, profile_json, updated_at FROM style_profile WHERE user_id = ?",
    )
    .bind(userId)
    .first<{
      handle: string | null;
      bio: string | null;
      profile_json: string;
      updated_at: string;
    }>();

  if (!row) {
    return { handle: "", bio: "", profile: DEFAULT_PROFILE, updated_at: null };
  }
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.profile_json);
  } catch {
    // fall through to defaults
  }
  return {
    handle: row.handle ?? "",
    bio: row.bio ?? "",
    profile: coerceProfile(parsed),
    updated_at: row.updated_at,
  };
}

export async function saveProfile(
  db: D1Database,
  input: { profile: Partial<StyleProfile>; handle?: string; bio?: string },
  userId = DEFAULT_USER,
): Promise<ProfileRecord> {
  const current = await getProfile(db, userId);
  const merged = coerceProfile({ ...current.profile, ...input.profile });
  const handle = input.handle ?? current.handle;
  const bio = input.bio ?? current.bio;

  await db
    .prepare(
      `INSERT INTO style_profile (user_id, handle, bio, profile_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         handle = excluded.handle,
         bio = excluded.bio,
         profile_json = excluded.profile_json,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, handle, bio, JSON.stringify(merged))
    .run();

  return { handle, bio, profile: merged, updated_at: new Date().toISOString() };
}

/* ------------------------------- samples -------------------------------- */

export async function listSamples(
  db: D1Database,
  limit = 100,
  userId = DEFAULT_USER,
): Promise<Sample[]> {
  const { results } = await db
    .prepare(
      `SELECT id, text, format, topics, source, engagement, created_at
       FROM samples WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<Sample>();
  return results ?? [];
}

export async function addSamples(
  db: D1Database,
  items: { text: string; format?: string | null; topics?: string; source?: Sample["source"] }[],
  userId = DEFAULT_USER,
): Promise<number> {
  const clean = items
    .map((i) => ({ ...i, text: i.text.trim() }))
    .filter((i) => i.text.length > 0);
  if (clean.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO samples (user_id, text, format, topics, source) VALUES (?, ?, ?, ?, ?)`,
  );
  await db.batch(
    clean.map((i) =>
      stmt.bind(userId, i.text, i.format ?? null, i.topics ?? "", i.source ?? "pasted"),
    ),
  );
  return clean.length;
}

export async function deleteSample(
  db: D1Database,
  id: number,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare("DELETE FROM samples WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}

/**
 * Choose few-shot exemplars for a draft.
 *
 * Scored in JS rather than SQL: the ranking mixes topic overlap, format match,
 * engagement and recency, which is clearer as code than as a CASE expression.
 */
export async function pickSamples(
  db: D1Database,
  opts: { topics: string[]; format?: string | null; limit?: number },
  userId = DEFAULT_USER,
): Promise<Sample[]> {
  const limit = opts.limit ?? 6;
  const { results } = await db
    .prepare(
      `SELECT id, text, format, topics, source, engagement, created_at
       FROM samples WHERE user_id = ? ORDER BY created_at DESC LIMIT 120`,
    )
    .bind(userId)
    .all<Sample>();

  const candidates = results ?? [];
  if (candidates.length === 0) return [];

  const wanted = opts.topics.map((t) => t.toLowerCase().trim()).filter(Boolean);
  const now = Date.now();

  const scored = candidates.map((s, idx) => {
    const hay = `${s.topics} ${s.text}`.toLowerCase();
    const overlap = wanted.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
    const ageDays = Math.max(
      0,
      (now - Date.parse(`${s.created_at}Z`.replace(/Z+$/, "Z"))) / 86_400_000,
    );

    let score = 0;
    score += overlap * 3;
    if (opts.format && s.format === opts.format) score += 2;
    if (s.source === "accepted_draft") score += 1; // the user actually shipped it
    score += Math.min(s.engagement / 100, 3);
    score += Math.max(0, 2 - ageDays / 60); // gentle recency tilt
    score -= idx * 0.001; // stable tiebreak
    return { s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.s);
}

/* ----------------------------- preferences ------------------------------ */

export async function listPreferences(
  db: D1Database,
  opts: { activeOnly?: boolean } = {},
  userId = DEFAULT_USER,
): Promise<Preference[]> {
  const sql = opts.activeOnly
    ? `SELECT * FROM preferences WHERE user_id = ? AND active = 1 ORDER BY weight DESC, id ASC`
    : `SELECT * FROM preferences WHERE user_id = ? ORDER BY active DESC, weight DESC, id ASC`;
  const { results } = await db.prepare(sql).bind(userId).all<Preference>();
  return results ?? [];
}

/**
 * The rules that actually apply to this draft.
 *
 * Global rules always. Format-scoped rules when the format matches. Topic rules
 * only when the topic is this post's topic -- which was the bug: every
 * `topic:*` rule went into every prompt, so a rule the user set while writing
 * about pricing turned up in the middle of a post about Rust, as an
 * authoritative-sounding instruction with nothing to do with the draft. A rule
 * fired on the wrong post is worse than no rule, because the model obeys it.
 */
export async function relevantPreferences(
  db: D1Database,
  format: string | null,
  topics: string[] = [],
  userId = DEFAULT_USER,
): Promise<Preference[]> {
  const all = await listPreferences(db, { activeOnly: true }, userId);
  return all.filter((p) => {
    if (p.scope === "global") return true;
    if (p.scope.startsWith("format:")) return format !== null && p.scope === `format:${format}`;
    if (p.scope.startsWith("topic:")) return topicsOverlap(p.scope.slice("topic:".length), topics);
    // An unrecognised scope is not silently treated as global.
    return false;
  });
}

/**
 * Whether a `topic:` scope is about what this turn is about.
 *
 * Compared word by word rather than as substrings, so "pricing" matches
 * "pricing strategy" without "ai" matching "chair". Both sides are user- or
 * model-authored tags, so neither is trusted to be normalised.
 */
function topicsOverlap(scope: string, topics: string[]): boolean {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
  const wanted = words(scope);
  if (!wanted.size) return false;

  for (const topic of topics) {
    for (const word of words(topic)) if (wanted.has(word)) return true;
  }
  return false;
}

export async function addPreference(
  db: D1Database,
  input: { rule: string; scope?: string; weight?: number; source?: Preference["source"] },
  userId = DEFAULT_USER,
): Promise<void> {
  const rule = input.rule.trim();
  if (!rule) return;
  // Don't let inferred rules pile up as near-duplicates of what's already there.
  const existing = await db
    .prepare(
      "SELECT id FROM preferences WHERE user_id = ? AND lower(rule) = lower(?) AND scope = ?",
    )
    .bind(userId, rule, input.scope ?? "global")
    .first<{ id: number }>();
  if (existing) {
    await db
      .prepare("UPDATE preferences SET weight = weight + 0.25, active = 1 WHERE id = ?")
      .bind(existing.id)
      .run();
    return;
  }
  await db
    .prepare(
      "INSERT INTO preferences (user_id, rule, scope, weight, source) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(userId, rule, input.scope ?? "global", input.weight ?? 1.0, input.source ?? "user")
    .run();
}

/** Rewrites a rule in place, so a nearly-right inferred rule can be corrected. */
export async function updatePreferenceRule(
  db: D1Database,
  id: number,
  rule: string,
  userId = DEFAULT_USER,
): Promise<void> {
  const trimmed = rule.trim();
  if (!trimmed) return;
  await db
    .prepare("UPDATE preferences SET rule = ?, source = 'user' WHERE id = ? AND user_id = ?")
    .bind(trimmed, id, userId)
    .run();
}

export async function setPreferenceActive(
  db: D1Database,
  id: number,
  active: boolean,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare("UPDATE preferences SET active = ? WHERE id = ? AND user_id = ?")
    .bind(active ? 1 : 0, id, userId)
    .run();
}

export async function deletePreference(
  db: D1Database,
  id: number,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare("DELETE FROM preferences WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}

/* ------------------------------ format stats ---------------------------- */

export async function getFormatStats(
  db: D1Database,
  userId = DEFAULT_USER,
): Promise<FormatStat[]> {
  const { results } = await db
    .prepare(
      `SELECT format, used, accepted, rejected, last_used_at
       FROM format_stats WHERE user_id = ? ORDER BY last_used_at DESC`,
    )
    .bind(userId)
    .all<FormatStat>();
  return results ?? [];
}

export async function recordFormatUse(
  db: D1Database,
  format: string,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO format_stats (user_id, format, used, last_used_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(user_id, format) DO UPDATE SET
         used = used + 1, last_used_at = datetime('now')`,
    )
    .bind(userId, format)
    .run();
}

/** The formats used in the last N drafts, newest first -- the anti-repetition signal. */
export async function recentFormats(
  db: D1Database,
  n = 8,
  userId = DEFAULT_USER,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT format FROM drafts
       WHERE user_id = ? AND input_kind != ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, STUDY_KIND, n)
    .all<{ format: string }>();
  return (results ?? []).map((r) => r.format);
}

/* --------------------------------- notes -------------------------------- */

export async function listNotes(
  db: D1Database,
  opts: { activeOnly?: boolean } = {},
  userId = DEFAULT_USER,
): Promise<Note[]> {
  const sql = opts.activeOnly
    ? `SELECT * FROM notes WHERE user_id = ? AND active = 1 ORDER BY created_at DESC`
    : `SELECT * FROM notes WHERE user_id = ? ORDER BY active DESC, created_at DESC`;
  const { results } = await db.prepare(sql).bind(userId).all<Note>();
  return results ?? [];
}

export interface NoteInput {
  note: string;
  topics?: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

/**
 * Insert notes, skipping ones the user already has.
 *
 * Studying two articles on the same subject would otherwise stack up near-identical
 * facts, and a knowledge block full of restatements crowds out the draft.
 */
export async function addNotes(
  db: D1Database,
  notes: NoteInput[],
  userId = DEFAULT_USER,
): Promise<Note[]> {
  const existing = await listNotes(db, {}, userId);
  const seen = new Set(existing.map((n) => normalise(n.note)));
  const added: Note[] = [];

  for (const input of notes) {
    const note = input.note.trim();
    if (note.length < 8) continue;
    const key = normalise(note);
    if (seen.has(key)) continue;
    seen.add(key);

    await db
      .prepare(
        `INSERT INTO notes (user_id, note, topics, source_url, source_title)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        note,
        (input.topics ?? "").trim(),
        (input.sourceUrl ?? "").trim(),
        (input.sourceTitle ?? "").trim(),
      )
      .run();

    const row = await db
      .prepare(
        `SELECT * FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(userId)
      .first<Note>();
    if (row) added.push(row);
  }
  return added;
}

export async function updateNote(
  db: D1Database,
  id: number,
  note: string,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare(`UPDATE notes SET note = ? WHERE id = ? AND user_id = ?`)
    .bind(note.trim(), id, userId)
    .run();
}

export async function setNoteActive(
  db: D1Database,
  id: number,
  active: boolean,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare(`UPDATE notes SET active = ? WHERE id = ? AND user_id = ?`)
    .bind(active ? 1 : 0, id, userId)
    .run();
}

export async function deleteNote(
  db: D1Database,
  id: number,
  userId = DEFAULT_USER,
): Promise<void> {
  await db.prepare(`DELETE FROM notes WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

/**
 * Notes worth putting in front of a draft.
 *
 * Scored rather than filtered: a note that shares no topic tag with this post is
 * usually noise, but with a small corpus it is better to fall back to recency
 * than to send nothing. Only notes with real overlap survive once there are
 * enough of them to choose from.
 */
export async function relevantNotes(
  db: D1Database,
  topics: string[],
  limit = 6,
  userId = DEFAULT_USER,
): Promise<Note[]> {
  const all = await listNotes(db, { activeOnly: true }, userId);
  if (!all.length) return [];

  const wanted = topics.map((t) => t.toLowerCase().trim()).filter(Boolean);
  if (!wanted.length) return all.slice(0, limit);

  const scored = all.map((n, idx) => {
    const hay = `${n.topics} ${n.note}`.toLowerCase();
    const overlap = wanted.reduce((acc, t) => (hay.includes(t) ? acc + 1 : acc), 0);
    return { n, overlap, idx };
  });

  const hits = scored.filter((x) => x.overlap > 0);
  // With few notes stored, unrelated ones are cheap and occasionally useful.
  const pool = hits.length ? hits : all.length <= limit ? scored : [];
  pool.sort((a, b) => b.overlap - a.overlap || a.idx - b.idx);
  return pool.slice(0, limit).map((x) => x.n);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

/* -------------------------------- drafts -------------------------------- */

export interface DraftRow {
  id: string;
  session_id: string | null;
  input: string;
  input_kind: string;
  /** post | reply. Never both -- one turn produces one kind of output. */
  output_type: string;
  /** The status a reply belongs under. Null for a post. */
  in_reply_to_id: string | null;
  format: string;
  variants_json: string;
  context_json: string;
  rationale: string;
  verdict: Verdict | null;
  final_text: string | null;
  note: string | null;
  created_at: string;
}

export async function saveDraft(
  db: D1Database,
  d: {
    id: string;
    sessionId: string;
    input: string;
    inputKind: string;
    outputType: OutputMode;
    /** Required when outputType is "reply"; the caller has already refused to save one without it. */
    inReplyToId: string | null;
    format: string;
    variants: Variant[];
    context: unknown;
    rationale: string;
  },
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drafts (id, user_id, session_id, input, input_kind, output_type, in_reply_to_id, format, variants_json, context_json, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      d.id,
      userId,
      d.sessionId,
      d.input,
      d.inputKind,
      d.outputType,
      d.inReplyToId,
      d.format,
      JSON.stringify(d.variants),
      JSON.stringify(d.context ?? {}),
      d.rationale,
    )
    .run();
  await Promise.all([recordFormatUse(db, d.format, userId), touchSession(db, d.sessionId, userId)]);
}

/**
 * Persist a study turn.
 *
 * Unlike `saveDraft` this does not touch format stats -- reading is not writing --
 * but it does touch the session so the sidebar orders correctly.
 */
export async function saveStudyTurn(
  db: D1Database,
  t: {
    id: string;
    sessionId: string;
    input: string;
    /** The digest, shown verbatim when the session is reopened. */
    summary: string;
    context: unknown;
  },
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drafts (id, user_id, session_id, input, input_kind, output_type, format, variants_json, context_json, rationale)
       VALUES (?, ?, ?, ?, ?, 'post', ?, '[]', ?, ?)`,
    )
    .bind(
      t.id,
      userId,
      t.sessionId,
      t.input,
      STUDY_KIND,
      STUDY_KIND,
      JSON.stringify(t.context ?? {}),
      t.summary,
    )
    .run();
  await touchSession(db, t.sessionId, userId);
}

export async function getDraft(
  db: D1Database,
  id: string,
  userId = DEFAULT_USER,
): Promise<DraftRow | null> {
  return await db
    .prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<DraftRow>();
}

export async function listDrafts(
  db: D1Database,
  limit = 30,
  userId = DEFAULT_USER,
): Promise<DraftRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM drafts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<DraftRow>();
  return results ?? [];
}

export async function recordVerdict(
  db: D1Database,
  input: { draftId: string; verdict: Verdict; finalText?: string; note?: string },
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare(
      `UPDATE drafts SET verdict = ?, final_text = ?, note = ? WHERE id = ? AND user_id = ?`,
    )
    .bind(
      input.verdict,
      input.finalText ?? null,
      input.note ?? null,
      input.draftId,
      userId,
    )
    .run();

  const draft = await getDraft(db, input.draftId, userId);
  if (!draft) return;

  const column = input.verdict === "rejected" ? "rejected" : "accepted";
  await db
    .prepare(
      `INSERT INTO format_stats (user_id, format, ${column}, last_used_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(user_id, format) DO UPDATE SET ${column} = ${column} + 1`,
    )
    .bind(userId, draft.format)
    .run();
}


/* -------------------------------- sessions ------------------------------- */

export interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary extends SessionRow {
  turns: number;
  /** Format of the most recent turn, for the sidebar. */
  lastFormat: string | null;
}

/**
 * A session's title is the first thing the user said, trimmed. Cheap, stable,
 * and recognisable in a list -- and renameable if it isn't.
 */
export function titleFromInput(input: string): string {
  const flat = input.replace(/\s+/g, " ").trim();
  const url = flat.match(/^https?:\/\/(?:www\.)?([^/\s]+)/);
  if (url && flat.length < 120) return url[1];
  return flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat || "Untitled";
}

export async function createSession(
  db: D1Database,
  input: { id: string; title: string },
  userId = DEFAULT_USER,
): Promise<SessionRow> {
  await db
    .prepare("INSERT INTO sessions (id, user_id, title) VALUES (?, ?, ?)")
    .bind(input.id, userId, input.title)
    .run();
  const now = new Date().toISOString();
  return { id: input.id, title: input.title, created_at: now, updated_at: now };
}

export async function touchSession(
  db: D1Database,
  sessionId: string,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(sessionId, userId)
    .run();
}

export async function getSession(
  db: D1Database,
  id: string,
  userId = DEFAULT_USER,
): Promise<SessionRow | null> {
  return await db
    .prepare("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<SessionRow>();
}

export async function listSessions(
  db: D1Database,
  limit = 100,
  userId = DEFAULT_USER,
): Promise<SessionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.title, s.created_at, s.updated_at,
              COUNT(d.id) AS turns,
              (SELECT format FROM drafts WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS lastFormat
       FROM sessions s
       LEFT JOIN drafts d ON d.session_id = s.id
       WHERE s.user_id = ?
       GROUP BY s.id
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<SessionSummary>();
  return results ?? [];
}

export async function renameSession(
  db: D1Database,
  id: string,
  title: string,
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?")
    .bind(title.trim().slice(0, 200) || "Untitled", id, userId)
    .run();
}

/** Deletes the session and every turn in it. */
export async function deleteSession(
  db: D1Database,
  id: string,
  userId = DEFAULT_USER,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM drafts WHERE session_id = ? AND user_id = ?").bind(id, userId),
    db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
}

/** Every turn in a session, oldest first -- the conversation, in order. */
export async function sessionTurns(
  db: D1Database,
  sessionId: string,
  userId = DEFAULT_USER,
): Promise<DraftRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM drafts WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC",
    )
    .bind(sessionId, userId)
    .all<DraftRow>();
  return results ?? [];
}

/** The most recent turn, which is the context a follow-up refines. */
export async function lastTurn(
  db: D1Database,
  sessionId: string,
  userId = DEFAULT_USER,
): Promise<DraftRow | null> {
  return await db
    .prepare(
      "SELECT * FROM drafts WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(sessionId, userId)
    .first<DraftRow>();
}
