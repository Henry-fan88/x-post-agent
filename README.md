# x-post-agent

Send it an idea or a link. It reads the source, looks things up when that helps,
picks a format that suits the idea, and writes the post in your voice.

It runs on Cloudflare Workers, keeps its memory in D1, and treats the model
provider as configuration — so you can plug in a key whenever you pick one.

```
you ──▶ [ one input box ]
              │
              ▼
   understand ─▶ open links ─▶ research ─▶ recall your voice
              ─▶ choose format ─▶ draft ×2 ─▶ self-check
              │
              ▼
        two drafts, a reason for the format, and the sources used
```

## What makes it more than a prompt

**It remembers, in four separate ways.** A *style profile* (the slow-moving
description of your voice), *samples* (real posts of yours, used as few-shot
examples), *rules* (atomic instructions you or it wrote down), and *format
stats* (what you've posted lately and what you've rejected). All in D1, all
editable from the UI.

**It doesn't write the same post every time.** There are 13 formats — one-liner,
hot take, thread, build log, teardown, reaction, and so on — each with a note on
when it fits. The agent picks one per post, and formats used recently are
penalised so drafts stay varied. Formats you actually post get rewarded.

**It learns from edits.** When you tell it you edited a draft before posting, it
diffs its version against yours, names the style rule behind the change, and
stores it. Your edited text also becomes a new writing sample.

**It never posts for you.** "Open in X" launches X's compose window prefilled;
you review and hit post. There's no write path to X anywhere in the code.

## Quick start

```bash
npm install
npx wrangler d1 migrations apply x-post-agent-db --local
npm run db:seed:local   # optional starter voice profile
npm run dev
```

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

## Layout

```
src/
  index.ts            Worker entry: routing, passphrase gate, /api/config
  agent/
    orchestrator.ts   The pipeline, and the events it streams to the UI
    formats.ts        13 post formats + the anti-repetition logic
    prompts.ts        Stage prompts and their JSON schemas
  config/
    settings.ts       Runtime config: wrangler vars as defaults, D1 as override
    crypto.ts         AES-GCM + PBKDF2 for API keys stored in D1
  llm/                Provider adapters behind one ChatModel interface
  memory/
    store.ts          D1 reads and writes
    learn.ts          Turning feedback into rules and samples
  tools/
    x.ts              X post reading (API, then oEmbed)
    fetch-url.ts      HTML to text via HTMLRewriter
    search.ts         Brave / Tavily / Exa behind one interface
  routes/             HTTP handlers
public/               The UI: one HTML file, one CSS file, one JS module
migrations/           D1 schema
db/seed.sql           Optional starter memory
```

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/config` | What's configured; drives the UI |
| `POST` | `/api/generate` | `{input}` → SSE stream of progress, then the drafts |
| `POST` | `/api/feedback` | `{draftId, verdict, finalText?, note?}` — this is what teaches it |
| `GET` | `/api/history` | Recent drafts and their verdicts |
| `GET`/`PUT` | `/api/memory/profile` | Your voice |
| `GET`/`POST`/`DELETE` | `/api/memory/samples` | Writing samples |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/memory/preferences` | Rules |
| `GET` | `/api/memory/stats` | Per-format usage and acceptance |
| `GET`/`PUT` | `/api/settings` | Provider, model, base URL, JSON mode |
| `PUT`/`DELETE` | `/api/settings/secrets/:name` | Store or remove an encrypted key. Never returns plaintext |
| `POST` | `/api/settings/test` | Round-trip the configured model |
| `GET` | `/api/settings/models` | Model catalogue for the current provider |

`verdict` is `posted`, `edited`, or `rejected`. Sending `edited` with the text
you actually posted is the single highest-value thing you can do — it's how the
agent's sense of your voice improves.
