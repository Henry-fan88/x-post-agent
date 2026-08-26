/** CRUD over the agent's memory, so the user can inspect and correct it. */

import { Hono } from "hono";
import {
  addPreference,
  addSamples,
  deletePreference,
  deleteSample,
  getFormatStats,
  getProfile,
  listPreferences,
  listSamples,
  saveProfile,
  setPreferenceActive,
} from "../memory/store";
import type { StyleProfile } from "../types";
import { readJson } from "./util";

export const memoryRoutes = new Hono<{ Bindings: Env }>();

/* ------------------------------- profile --------------------------------- */

memoryRoutes.get("/profile", async (c) => c.json(await getProfile(c.env.DB)));

memoryRoutes.put("/profile", async (c) => {
  const body = await readJson<{ profile: Partial<StyleProfile>; handle: string; bio: string }>(c);
  return c.json(
    await saveProfile(c.env.DB, {
      profile: body.profile ?? {},
      handle: body.handle,
      bio: body.bio,
    }),
  );
});

/* -------------------------------- samples -------------------------------- */

memoryRoutes.get("/samples", async (c) => c.json({ samples: await listSamples(c.env.DB) }));

/**
 * Accepts either a list of posts or one blob of pasted text. Blank lines
 * separate posts, which is what you get from copying a few posts out of X.
 */
memoryRoutes.post("/samples", async (c) => {
  const body = await readJson<{ text: string; posts: string[]; format: string | null; topics: string }>(c);

  const posts = body.posts?.length
    ? body.posts
    : (body.text ?? "")
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean);

  const added = await addSamples(
    c.env.DB,
    posts.map((text) => ({ text, format: body.format ?? null, topics: body.topics ?? "" })),
  );
  return c.json({ added });
});

memoryRoutes.delete("/samples/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Bad id." }, 400);
  await deleteSample(c.env.DB, id);
  return c.json({ deleted: true });
});

/* ------------------------------ preferences ------------------------------ */

memoryRoutes.get("/preferences", async (c) =>
  c.json({ preferences: await listPreferences(c.env.DB) }),
);

memoryRoutes.post("/preferences", async (c) => {
  const body = await readJson<{ rule: string; scope: string }>(c);
  if (!body.rule?.trim()) return c.json({ error: "A rule is required." }, 400);
  await addPreference(c.env.DB, { rule: body.rule, scope: body.scope, source: "user", weight: 1.5 });
  return c.json({ preferences: await listPreferences(c.env.DB) });
});

memoryRoutes.patch("/preferences/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<{ active: boolean }>(c);
  if (!Number.isInteger(id) || typeof body.active !== "boolean") {
    return c.json({ error: "Bad id or missing active flag." }, 400);
  }
  await setPreferenceActive(c.env.DB, id, body.active);
  return c.json({ preferences: await listPreferences(c.env.DB) });
});

memoryRoutes.delete("/preferences/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Bad id." }, 400);
  await deletePreference(c.env.DB, id);
  return c.json({ deleted: true });
});

/* --------------------------------- stats --------------------------------- */

memoryRoutes.get("/stats", async (c) => c.json({ formats: await getFormatStats(c.env.DB) }));
