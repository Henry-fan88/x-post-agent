# x-post-agent

Send it an idea or a link and it writes the post in your voice. Paste someone
else's X post and it writes a reply to go under it. Or hand it something to read
and it will take the source in rather than post about it -- permanently, if you
ask.

It runs on Cloudflare Workers, keeps its memory in D1, and treats the model
provider as configuration — so you can plug in a key whenever you pick one.

```
you ──▶ [ one input box ]
              │
              ├── an idea, or an article ──▶ understand ─▶ open links ─▶ research
              │                           ─▶ recall your voice ─▶ choose format
              │                           ─▶ draft ─▶ self-check
              │                                   │
              │                                   ▼
              │             1 or 2 drafts, why that format, and the sources used
              │
              ├── an X post ──▶ read it ─▶ recall your voice
              │              ─▶ draft one reply ─▶ check it as a reply
              │                              │
              │                              ▼
              │              one reply, and the post it belongs under
              │
              └── "read this" ──▶ open links ─▶ distil ─▶ (learn)
                                             │
                                             ▼
                          what it says, what it's worth posting about, and
                          — only if you asked — what got kept
```

## What makes it more than a prompt

**It remembers, in five separate ways.** A *style profile* (the slow-moving
description of your voice), *samples* (real posts of yours, used as few-shot
examples), *rules* (atomic instructions you or it wrote down), *notes* (what it
learned from sources you told it to read), and *format stats* (what you've posted
lately and what you've rejected). All in D1, all editable from the UI.

The first four all answer *how you write*. Notes answer *what you know*, which is
why they are a separate table rather than more rules: a rule is injected into
every draft, while a note only surfaces when a post touches the same topic, and
the prompt is explicit that knowing something is not a reason to put it in the
post.

**A post and a reply are different jobs, and one turn does one of them.** Paste
an X post and you get exactly one reply, drafted to sit under that post; type an
idea and you get a post. Never both in one run, and a reply always carries the
status id it belongs to, so *Reply on X* opens X threaded rather than dropping
your reply into an empty composer. Want a post *about* an X post instead? Say
*write a post about this* — that phrasing turns the link from a reply target into
a source.

The split is not cosmetic. A reply is read directly under the thing it answers,
so everything a standalone post does to earn attention — the hook, the setup,
restating the premise — works against it there. Replies are drafted from their
own prompt and checked against the parent, and the shapes that reliably fail
(recapping the parent, complimenting it, opening with the handle, ending on a
question asked for engagement, a call to action) are caught in code before the
model gets a chance to review its own work — then handed back for one repair
pass. Whatever survives that is shown to you as a warning rather than passed off
as fine.

**One draft or two, depending on the shape.** A one-liner, hot take, open
question or before/after gets one draft: a second is the same sentence with the
words moved, and making you read both to find that out is worse than giving you
one. Everything else gets two genuinely different angles — and if the second turns
out to be the first reworded, it's dropped rather than shown.

**It counts characters the way X does.** A CJK character or an emoji costs two,
and any URL costs 23 however long it is. 140 Chinese characters is a full
280-character post, which counting code points would have called half full.

**It answers in the language it was addressed in.** Chinese in, Chinese out. For
a reply, it matches the post being replied to rather than your one-line
instruction about it.

**It doesn't write the same post every time.** There are 13 formats — one-liner,
hot take, thread, build log, teardown, reaction, and so on — each with a note on
when it fits. The agent picks one per post, and formats used recently are
penalised so drafts stay varied. Formats you actually post get rewarded.

**It learns two ways.** When you tell it you edited a draft before posting, it
diffs its version against yours, names the style rule behind the change, and
stores it — your edited text also becomes a new writing sample. And it reads the
conversation itself: say *"stop opening with a question"* while refining and that
becomes a standing rule.

The hard part there is telling a standing preference from a one-off note about
the post in front of you. *"Never use em dashes"* should outlive the draft;
*"focus on the pricing angle"* should not. The extractor defaults to one-off,
keeps only high-confidence generalisations, writes them at low weight marked
`learned`, and shows each one inline with an undo. Everything it records is
listed in **Settings → Rules**, where rules can be edited in place, muted, or
deleted — editing one promotes it to a rule you own.

**It reads what you give it, and learns when you ask.** Paste a link and it opens
the page, pulls the readable text out of it, and drafts from that. Say *read this*
instead and it stops after reading: you get what the source argues, what a reader
would take from it, and the angles in it worth posting -- and the source stays in
the session, so three turns later "now write the thread" needs no second fetch.

Say *learn from this* and it also decides what should outlive the session. Facts,
positions, numbers and vocabulary become notes. Style rules and changes to your
voice profile are held to a higher bar: they only happen if you said the source
represents how *you* want to write, because reading an essay is not consent to
write like its author. Everything it keeps is listed inline with an undo, and
lives in **Settings → Knowledge**.

Intent is read from your words -- "read this", "learn from this", "remember this"
-- with a deliberate bias toward drafting, since an unwanted draft is cheaper than
a silent write to memory. "Learn from this and write me a thread" does both. When
the phrasing misses, every source carries a **Learn from this** button, which is
also how you keep something you only meant to read at the time.

**It never posts for you.** *Open in X* launches X's compose window prefilled;
*Reply on X* opens the same composer already threaded under the right post. You
review and hit post. There's no write path to X anywhere in the code.

## Quick start

```bash
npm install
npx wrangler d1 migrations apply x-post-agent-db --local
npm run db:seed:local   # optional starter voice profile
npm run dev
```

`npm run eval` checks the decisions that must not drift — post vs reply, how many
drafts come back, X's weighted character count, which language to answer in, and
the reply shapes that get rejected. It calls no network and needs no API key.

Open http://localhost:8787. It works immediately on a built-in **mock provider** —
the full pipeline runs, memory is written, the UI is exercisable — the drafts are
just obviously canned. Plug in a real key and the same pipeline produces real
posts.

## Picking a model provider

**From the UI:** open **Settings → Model**. Provider, model, base URL, and JSON
mode are all editable there and take effect immediately — no redeploy. On
OpenRouter the model field autocompletes from their live catalogue, flagging
which models support structured outputs. **Test connection** round-trips the
configured model so a bad key or model id surfaces there rather than mid-draft.

**From config:** the `vars` in `wrangler.jsonc` are the defaults. Anything set in
the UI overrides them.

| Provider | Key | Notes |
|---|---|---|
| `mock` | none | Runs everything, writes fake prose. Useful for testing. |
| `anthropic` | `MODEL_API_KEY` | Set the model to e.g. `claude-opus-5`. |
| `openai` | `MODEL_API_KEY` | Also covers OpenRouter, Groq, DeepSeek, vLLM — point the base URL at them. |
| `workers-ai` | none | Uncomment the `ai` binding in `wrangler.jsonc`. Runs on Cloudflare. |

Adding a provider is one file in [`src/llm/`](src/llm/), a case in
[`createModel`](src/llm/index.ts), and an entry in the `PROVIDERS` list in
[`src/routes/settings.ts`](src/routes/settings.ts).

### Where API keys live

Two options, and the more secure one wins:

```bash
npx wrangler secret put MODEL_API_KEY    # encrypted by Cloudflare, never readable back
```

or paste the key into **Settings → Model → API key**. Keys entered that way are
stored in D1 **encrypted with AES-GCM**, under a key derived from `APP_PASSWORD`
via PBKDF2 — a database dump alone won't yield them. The API never returns
plaintext; the UI only ever sees the last four characters.

`wrangler secret put` remains the stronger option and **takes precedence** over
anything stored through the UI. The UI path exists so you can rotate a key or
switch providers from a phone; it is a convenience, not a replacement. It is
refused entirely unless `APP_PASSWORD` is set, since that passphrase *is* the
encryption key — which also means rotating `APP_PASSWORD` invalidates stored
keys, and the UI will tell you to re-enter them.

## Optional extras

**Web search** — set `SEARCH_PROVIDER` to `brave`, `tavily`, or `exa` and put the
key in `SEARCH_API_KEY`. Without it the agent works from your input and its links
only, and says so when a post would have benefited from a lookup.

**X API** — set `X_BEARER_TOKEN` to read posts with author and engagement
metadata. Without it, public posts are read through oEmbed, which needs no
credentials and returns the text.

**A lock** — set `APP_PASSWORD` and the UI asks for it before it will call the
API. Worth doing before you put this on a public URL.

## Deploying

Needs a Cloudflare account.

```bash
npx wrangler login
npx wrangler d1 create x-post-agent-db     # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply x-post-agent-db --remote
npx wrangler secret put MODEL_API_KEY      # and any others you're using
npm run deploy
```

`database_id` in `wrangler.jsonc` is a placeholder until you run `d1 create`.

Already deployed? Migrations are additive, so an upgrade is the migration and the
deploy, in that order:

```bash
npx wrangler d1 migrations apply x-post-agent-db --remote && npm run deploy
```

## Layout

```
src/
  index.ts            Worker entry: routing, passphrase gate, /api/config
  agent/
    orchestrator.ts   Both pipelines, and the events they stream to the UI
    route.ts          Post or reply? Decided once, before anything else runs
    intent.ts         Post about this, or take this in?
    formats.ts        13 post formats, the anti-repetition logic, the variant lock
    reply.ts          The reply shapes that must not ship
    chars.ts          X's weighted character count, and which script text is in
    prompts.ts        Stage prompts and their JSON schemas
  config/
    settings.ts       Runtime config: wrangler vars as defaults, D1 as override
    crypto.ts         AES-GCM + PBKDF2 for API keys stored in D1
  llm/                Provider adapters behind one ChatModel interface
  memory/
    store.ts          D1 reads and writes
    learn.ts          Turning feedback and sources into rules, samples and notes
  tools/
    x.ts              X post reading (API, then oEmbed)
    fetch-url.ts      HTML to text via HTMLRewriter
    search.ts         Brave / Tavily / Exa behind one interface
  routes/             HTTP handlers
public/               The UI: one HTML file, one CSS file, one JS module
migrations/           D1 schema
db/seed.sql           Optional starter memory
eval/                 Offline checks for the rules above. No network, no key
```

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/config` | What's configured; drives the UI |
| `POST` | `/api/generate` | `{input, sessionId?, mode?}` → SSE stream of progress, then the drafts. `mode` is `post` or `reply` and overrides the router; asking for `reply` with no X link in the input is a 400. With a `sessionId` it refines that session's last draft, keeping its mode. A "read this" / "learn from this" input streams a reading instead |
| `POST` | `/api/learn` | `{url, sessionId?, instruction?}` — read one source and commit what's worth keeping |
| `POST` | `/api/feedback` | `{draftId, verdict, finalText?, note?}` — this is what teaches it |
| `GET` | `/api/sessions` | Sessions, newest first |
| `GET` | `/api/sessions/:id` | One session and every turn in it |
| `PATCH`/`DELETE` | `/api/sessions/:id` | Rename or delete a session |
| `GET`/`PUT` | `/api/memory/profile` | Your voice |
| `GET`/`POST`/`DELETE` | `/api/memory/samples` | Writing samples |
| `GET`/`POST`/`DELETE` | `/api/memory/preferences` | Rules |
| `PATCH` | `/api/memory/preferences/:id` | Edit rule text, mute/unmute, or both |
| `GET`/`POST`/`DELETE` | `/api/memory/notes` | What it learned from sources |
| `PATCH` | `/api/memory/notes/:id` | Edit note text, mute/unmute, or both |
| `GET` | `/api/memory/stats` | Per-format usage and acceptance |
| `GET`/`PUT` | `/api/settings` | Provider, model, base URL, JSON mode |
| `PUT`/`DELETE` | `/api/settings/secrets/:name` | Store or remove an encrypted key. Never returns plaintext |
| `POST` | `/api/settings/test` | Round-trip the configured model |
| `GET` | `/api/settings/models` | Model catalogue for the current provider |

The result of a generate carries `mode` (`post` or `reply`) and `inReplyToId`,
which is non-null exactly when the mode is `reply`.

`verdict` is `posted`, `edited`, or `rejected`. Sending `edited` with the text
you actually posted is the single highest-value thing you can do — it's how the
agent's sense of your voice improves.
