/**
 * D1-backed agent memory.
 *
 * Four kinds of memory, deliberately separated:
 *   - style_profile: the slow-moving model of the user's voice
 *   - samples:       real posts to imitate (few-shot corpus)
 *   - preferences:   atomic rules, injected into the prompt verbatim
 *   - format_stats:  what has been used lately, so drafts don't all look alike
 */

import type {
  FormatStat,
  Preference,
  Sample,
  StyleProfile,
  Variant,
  Verdict,
} from "../types";

export const DEFAULT_USER = "default";

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

/** Preferences that apply to a given format: global ones plus format-scoped ones. */
export async function relevantPreferences(
  db: D1Database,
  format: string | null,
  userId = DEFAULT_USER,
): Promise<Preference[]> {
  const all = await listPreferences(db, { activeOnly: true }, userId);
  return all.filter(
    (p) =>
      p.scope === "global" ||
      (format !== null && p.scope === `format:${format}`) ||
      p.scope.startsWith("topic:"),
  );
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
      `SELECT format FROM drafts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, n)
    .all<{ format: string }>();
  return (results ?? []).map((r) => r.format);
}

/* -------------------------------- drafts -------------------------------- */

export interface DraftRow {
  id: string;
  input: string;
  input_kind: string;
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
    input: string;
    inputKind: string;
    format: string;
    variants: Variant[];
    context: unknown;
    rationale: string;
  },
  userId = DEFAULT_USER,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drafts (id, user_id, input, input_kind, format, variants_json, context_json, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      d.id,
      userId,
      d.input,
      d.inputKind,
      d.format,
      JSON.stringify(d.variants),
      JSON.stringify(d.context ?? {}),
      d.rationale,
    )
    .run();
  await recordFormatUse(db, d.format, userId);
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
