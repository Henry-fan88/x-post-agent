/**
 * post agent — UI.
 *
 * No framework: an app shell, a session list, and a conversation thread. All
 * user-supplied text goes in through textContent, never innerHTML.
 */

const $ = (id) => document.getElementById(id);

const els = {
  app: document.querySelector(".app"),
  sidebar: $("sidebar"),
  sessionList: $("session-list"),
  thread: $("thread"),
  welcome: $("welcome"),
  starters: $("starters"),
  title: $("session-title"),
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  note: $("composer-note"),
  hint: $("composer-hint"),
  chip: $("status-chip"),
  panel: $("settings-panel"),
  scrim: $("scrim"),
  rename: $("rename-session"),
  renameRow: $("rename-row"),
  renameInput: $("rename-input"),
  del: $("delete-session"),
};

const state = {
  config: { maxPostChars: 280, handle: "" },
  sessions: [],
  currentId: null,
  busy: false,
};

let passphrase = sessionStorage.getItem("x-post-agent-pass") || "";

const STARTERS = [
  "Ship a build log about what I fixed today",
  "Reply to an X post I paste",
  "Write a post about an article I paste",
];

/* ------------------------------ networking ------------------------------- */

function headers(extra = {}) {
  const h = { "content-type": "application/json", ...extra };
  if (passphrase) h["x-app-password"] = passphrase;
  return h;
}

function askPassphrase() {
  const entered = prompt("Passphrase:");
  if (!entered) return false;
  passphrase = entered;
  sessionStorage.setItem("x-post-agent-pass", entered);
  return true;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: headers(options.headers) });
  if (res.status === 401) {
    if (askPassphrase()) return api(path, options);
    throw new Error("Passphrase required.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status}).`);
  }
  return res.json();
}

/* -------------------------------- config --------------------------------- */

async function loadConfig() {
  try {
    state.config = await api("/api/config");
    const { model, search, xApi } = state.config;
    els.chip.textContent = model.configured ? model.name : "no model key";
    els.chip.classList.toggle("warn", !model.configured);
    els.chip.title = [
      model.note || `Model: ${model.name}`,
      `Search: ${search.configured ? search.provider : "off"}`,
      `X API: ${xApi.configured ? "on" : "oEmbed only"}`,
    ].join("\n");
  } catch {
    els.chip.textContent = "offline";
    els.chip.classList.add("warn");
  }
}

/* -------------------------------- sessions -------------------------------- */

/** Buckets for the sidebar. Recency is what makes a long list navigable. */
function bucketOf(iso) {
  const then = new Date(`${iso.replace(" ", "T")}Z`).getTime();
  if (Number.isNaN(then)) return "Earlier";
  const days = (Date.now() - then) / 86_400_000;
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 8) return "This week";
  if (days < 31) return "This month";
  return "Earlier";
}

async function loadSessions() {
  try {
    const { sessions } = await api("/api/sessions");
    state.sessions = sessions;
    renderSidebar();
  } catch {
    // A failure here shouldn't block composing; the list just stays empty.
  }
}

function renderSidebar() {
  els.sessionList.replaceChildren();
  let lastBucket = "";

  for (const s of state.sessions) {
    const bucket = bucketOf(s.updated_at);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      const head = document.createElement("div");
      head.className = "group";
      head.textContent = bucket;
      els.sessionList.append(head);
    }

    const item = document.createElement("button");
    item.type = "button";
    item.className = `session-item${s.id === state.currentId ? " on" : ""}`;

    const bar = document.createElement("span");
    bar.className = "bar";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = s.title || "Untitled";

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = s.turns > 1 ? String(s.turns) : "";

    item.append(bar, label, count);
    item.addEventListener("click", () => openSession(s.id));
    els.sessionList.append(item);
  }
}

function setActive(id, title) {
  state.currentId = id;
  els.title.textContent = title || "New post";
  els.rename.hidden = !id;
  els.del.hidden = !id;
  closeRename();
  els.input.placeholder = id ? "Ask for a change…" : "Paste a link or type an idea…";
  renderSidebar();
}

async function openSession(id) {
  closeSidebarOnNarrow();
  try {
    const { session, turns } = await api(`/api/sessions/${id}`);
    setActive(session.id, session.title);
    els.thread.replaceChildren(threadInner(turns));
    scrollToEnd(false);
  } catch (err) {
    showBanner(err.message, "bad");
  }
}

function newSession() {
  closeSidebarOnNarrow();
  setActive(null, "New post");
  els.thread.replaceChildren(welcomeBlock());
  els.input.focus();
}

function threadInner(turns) {
  const inner = document.createElement("div");
  inner.className = "thread-inner";
  for (const t of turns) inner.append(turnBlock(t.input, t));
  return inner;
}

function ensureInner() {
  let inner = els.thread.querySelector(".thread-inner");
  if (!inner) {
    inner = document.createElement("div");
    inner.className = "thread-inner";
    els.thread.replaceChildren(inner);
  }
  return inner;
}

/* --------------------------------- welcome -------------------------------- */

function welcomeBlock() {
  const wrap = document.createElement("div");
  wrap.className = "welcome";

  const mark = document.createElement("div");
  mark.className = "welcome-mark";
  mark.textContent = "✳";

  const h = document.createElement("h2");
  h.textContent = "What are we posting about?";

  // Kept in step with the static welcome in index.html; the two are the same
  // screen, one server-rendered and one rebuilt when you start a new post.
  const split = document.createElement("p");
  split.textContent =
    "Paste an X post and it drafts a reply to it. Type an idea, or paste an article, and it drafts a post. One or the other, never both \u2014 say \u201cwrite a post about this\u201d over an X link if you want the post.";

  const p = document.createElement("p");
  p.textContent =
    "It reads the source, looks things up when that helps, and writes the way you write. Say \u201cread this\u201d and it takes the source in without drafting; say \u201clearn from this\u201d and it keeps what matters.";

  const starters = document.createElement("div");
  starters.className = "starters";
  fillStarters(starters);

  wrap.append(mark, h, split, p, starters);
  return wrap;
}

/** The static welcome in index.html and the JS-built one share these. */
function fillStarters(container) {
  container.replaceChildren();
  for (const text of STARTERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "starter";
    b.textContent = text;
    b.addEventListener("click", () => {
      els.input.value = text;
      resizeInput();
      els.input.focus();
    });
    container.append(b);
  }
}

/* ---------------------------------- turns --------------------------------- */

/** One exchange: what the user asked, and what came back. */
function turnBlock(askText, reply) {
  const turn = document.createElement("div");
  turn.className = "turn";

  const ask = document.createElement("div");
  ask.className = "ask";
  ask.textContent = askText;
  turn.append(ask);

  if (reply) turn.append(reply.kind === "study" ? studyBlock(replayed(reply)) : replyBlock(reply));
  return turn;
}

/** A stored study turn keeps its digest and its sources in separate fields. */
function replayed(turn) {
  return { ...(turn.study || {}), sources: turn.sources || [] };
}

function replyBlock(reply) {
  const wrap = document.createElement("div");
  wrap.className = "reply";

  const head = document.createElement("div");
  head.className = "reply-head";

  const badge = document.createElement("span");
  badge.className = "badge";
  const isReply = reply.mode === "reply" || reply.format === "reply";
  badge.textContent = isReply ? "Reply" : reply.formatLabel || reply.format || "draft";
  // Not "reply" -- that class already means the reply container two levels up.
  if (isReply) badge.classList.add("badge-reply");

  const why = document.createElement("span");
  why.className = "reply-why";
  why.textContent = reply.formatRationale || reply.rationale || "";

  head.append(badge, why);
  wrap.append(head);

  const variants = reply.variants || [];
  const mode = reply.mode === "reply" ? "reply" : "post";
  variants.forEach((v, i) => {
    wrap.append(
      postCard(v, i, reply.draftId || reply.id, {
        mode,
        inReplyToId: reply.inReplyToId || null,
        only: variants.length === 1,
      }),
    );
  });

  if (reply.warnings?.length) wrap.append(warningBlock(reply.warnings));
  if (reply.sources?.length) wrap.append(sourceBlock(reply.sources));
  return wrap;
}

/* ------------------------------- post preview ------------------------------ */

function postCard(variant, index, draftId, out = { mode: "post", inReplyToId: null, only: true }) {
  const card = document.createElement("article");
  card.className = "post";

  const head = document.createElement("div");
  head.className = "post-head";

  const n = document.createElement("span");
  n.className = "post-n";
  // "Option 1" only means something when there is an option 2.
  n.textContent = out.only
    ? out.mode === "reply"
      ? "Reply"
      : "Draft"
    : `Option ${index + 1}`;

  const angle = document.createElement("span");
  angle.className = "post-angle";
  angle.textContent = variant.angle || "";

  head.append(n, angle);

  const tweets = document.createElement("div");
  tweets.className = "tweets";

  const handle = (state.config.handle || "you").replace(/^@/, "");
  const parts = variant.parts || [];

  parts.forEach((part, i) => {
    const tweet = document.createElement("div");
    tweet.className = `tweet${i < parts.length - 1 ? " linked" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = handle.charAt(0).toUpperCase() || "✳";

    const body = document.createElement("div");

    const who = document.createElement("div");
    who.className = "tweet-handle";
    who.textContent = handle;
    const at = document.createElement("span");
    at.textContent = `  @${handle}${parts.length > 1 ? ` · ${i + 1}/${parts.length}` : ""}`;
    who.append(at);

    const text = document.createElement("div");
    text.className = "tweet-text";
    text.textContent = part.text;

    const meta = document.createElement("div");
    const over = part.chars > state.config.maxPostChars;
    meta.className = `tweet-meta${over ? " over" : ""}`;
    meta.textContent = `${part.chars} / ${state.config.maxPostChars}`;

    body.append(who, text, meta);
    tweet.append(avatar, body);
    tweets.append(tweet);
  });

  card.append(head, tweets, actionBar(card, parts.map((p) => p.text).join("\n\n"), draftId, out));
  return card;
}

/**
 * Where a draft goes when it leaves the app.
 *
 * Two different X endpoints, and they are not interchangeable: a reply opened
 * through the post composer silently becomes a standalone post addressed to
 * nobody. So a reply with no parent id is an error the user sees, never a new
 * post opened quietly on their behalf.
 */
function intentUrl(fullText, out) {
  const text = encodeURIComponent(fullText);
  if (out.mode !== "reply") return `https://x.com/intent/post?text=${text}`;
  if (!out.inReplyToId) return null;
  return `https://x.com/intent/tweet?in_reply_to=${encodeURIComponent(out.inReplyToId)}&text=${text}`;
}

function actionBar(card, fullText, draftId, out = { mode: "post", inReplyToId: null }) {
  const bar = document.createElement("div");
  bar.className = "post-actions";

  const copy = act("Copy", async () => {
    await navigator.clipboard.writeText(fullText);
    copy.textContent = "Copied";
    copy.classList.add("done");
    setTimeout(() => {
      copy.textContent = "Copy";
      copy.classList.remove("done");
    }, 1400);
  });

  // Opens X's composer prefilled. The user reviews and posts it themselves —
  // the agent has no write path to X.
  const url = intentUrl(fullText, out);
  const open = act(out.mode === "reply" ? "Reply on X" : "Open in X", () => {
    if (!url) {
      if (!card.querySelector(".reply-broken")) {
        const note = document.createElement("div");
        note.className = "notice bad reply-broken";
        note.textContent =
          "This is a reply, but the post it belongs under is missing. Paste that post's link again rather than sending it as a new post.";
        card.append(note);
      }
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  });
  open.classList.add("primary");
  if (!url) open.classList.add("broken");

  const sep = document.createElement("span");
  sep.className = "sep";

  const posted = act("Posted", () => sendFeedback(bar, draftId, "posted", fullText));
  const edited = act("Edited", () => toggleEditor(card, bar, draftId, fullText));
  const nope = act("Not this", () => sendFeedback(bar, draftId, "rejected"));

  bar.append(copy, open, sep, posted, edited, nope);
  return bar;
}

function toggleEditor(card, bar, draftId, fullText) {
  const existing = card.querySelector(".edit-box");
  if (existing) return existing.remove();

  const box = document.createElement("div");
  box.className = "edit-box";

  const area = document.createElement("textarea");
  area.value = fullText;

  const row = document.createElement("div");
  row.className = "post-actions";
  row.style.cssText = "background:transparent;border:0;padding:0";

  row.append(act("Save what you posted", () => sendFeedback(bar, draftId, "edited", area.value.trim())));
  box.append(area, row);
  bar.parentElement.insertBefore(box, bar);
  area.focus();
}

async function sendFeedback(bar, draftId, verdict, finalText) {
  for (const b of bar.querySelectorAll("button")) b.disabled = true;
  try {
    const res = await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ draftId, verdict, finalText }),
    });

    bar.closest(".post")?.querySelector(".edit-box")?.remove();

    const note = document.createElement("div");
    note.className = "notice ok";
    note.textContent = res.learned?.length
      ? `Noted. Learned: ${res.learned.join(" · ")}`
      : verdict === "rejected"
        ? "Noted — this format is less likely next time."
        : "Noted.";
    bar.replaceWith(note);
  } catch (err) {
    for (const b of bar.querySelectorAll("button")) b.disabled = false;
    showBanner(err.message, "bad");
  }
}

/* -------------------------------- fragments -------------------------------- */

/**
 * What the agent decided to remember from this turn.
 *
 * Shown inline with an undo, because a wrong guess about a standing preference
 * should cost one click to reverse rather than a trip to Settings.
 */
function learnedBlock(learned) {
  const box = document.createElement("div");
  box.className = "notice learned";

  const title = document.createElement("strong");
  title.textContent = "Added to memory";
  box.append(title);

  const list = document.createElement("ul");

  /** One remembered thing, labelled with which memory it went into. */
  const row = (text, tag, undo) => {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.textContent = text;
    const em = document.createElement("em");
    em.className = "tag";
    em.textContent = tag;
    span.append(" ", em);

    const button = act("undo", async () => {
      await undo();
      li.remove();
      if (!list.children.length) box.remove();
    });
    button.classList.add("inline");

    li.append(span, button);
    list.append(li);
  };

  for (const item of learned.rules || []) {
    row(item.rule, "rule", () =>
      api(`/api/memory/preferences/${item.id}`, { method: "DELETE" }),
    );
  }
  for (const item of learned.notes || []) {
    row(item.note, "note", () => api(`/api/memory/notes/${item.id}`, { method: "DELETE" }));
  }
  // Undo puts the previous value back rather than deleting anything -- a profile
  // field always has a value, so there is nothing to remove.
  for (const change of learned.profile || []) {
    row(change.label, "voice", () =>
      api("/api/memory/profile", {
        method: "PUT",
        body: JSON.stringify({ profile: { [change.field]: change.from } }),
      }),
    );
  }

  box.append(list);
  return box;
}

function hasLearned(learned) {
  if (!learned) return false;
  return Boolean(
    learned.rules?.length || learned.notes?.length || learned.profile?.length,
  );
}

/* --------------------------------- reading -------------------------------- */

/**
 * A turn where the agent read something instead of writing something.
 *
 * The digest is the point: it is the user's proof that the source was actually
 * read, and it is what makes "learn this" safe to press afterwards.
 */
function studyBlock(result) {
  const wrap = document.createElement("div");
  wrap.className = "reply study";
  const learning = result.mode === "learn";

  const head = document.createElement("div");
  head.className = "reply-head";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = learning ? "learned" : "read";

  const why = document.createElement("span");
  why.className = "reply-why";
  why.textContent = learning
    ? "Read it, and kept what was worth keeping."
    : "Read it. Context for this session — nothing saved.";

  head.append(badge, why);
  wrap.append(head);

  if (result.summary) {
    const p = document.createElement("p");
    p.className = "study-summary";
    p.textContent = result.summary;
    wrap.append(p);
  }

  if (result.takeaways?.length) wrap.append(bulletList("What it says", result.takeaways));

  if (result.angles?.length) {
    const box = document.createElement("div");
    box.className = "study-list";

    const h = document.createElement("strong");
    h.textContent = "Could be a post";
    box.append(h);

    const row = document.createElement("div");
    row.className = "starters";
    for (const angle of result.angles) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "starter";
      b.textContent = angle;
      b.addEventListener("click", () => {
        els.input.value = angle;
        resizeInput();
        els.input.focus();
      });
      row.append(b);
    }
    box.append(row);
    wrap.append(box);
  }

  if (result.warnings?.length) wrap.append(warningBlock(result.warnings));
  if (hasLearned(result.learned)) wrap.append(learnedBlock(result.learned));
  if (result.sources?.length) wrap.append(sourceBlock(result.sources));
  if (!learning && result.sources?.length) wrap.append(learnActions(wrap, result.sources));

  return wrap;
}

/**
 * The deliberate way to commit a source.
 *
 * Reading leaves nothing behind on purpose, and the decision that something was
 * worth keeping is usually made after reading it -- so the button lives under
 * the digest rather than being something you had to say up front.
 */
function learnActions(wrap, sources) {
  const row = document.createElement("div");
  row.className = "study-actions";

  for (const source of sources) {
    const label = sources.length > 1 ? `Learn from ${hostOf(source.url)}` : "Learn from this";

    const button = act(label, async () => {
      button.disabled = true;
      button.textContent = "reading…";
      try {
        const res = await api("/api/learn", {
          method: "POST",
          body: JSON.stringify({ sessionId: state.currentId || undefined, url: source.url }),
        });
        button.remove();
        if (!row.children.length) row.remove();
        wrap.append(
          hasLearned(res.learned)
            ? learnedBlock(res.learned)
            : noticeBlock(
                "Nothing in that was worth keeping long-term. It is still context for this session.",
                "warn",
              ),
        );
        scrollToEnd();
      } catch (err) {
        button.disabled = false;
        button.textContent = label;
        showBanner(err.message, "bad");
      }
    });
    row.append(button);
  }
  return row;
}

function bulletList(title, items) {
  const box = document.createElement("div");
  box.className = "study-list";

  const h = document.createElement("strong");
  h.textContent = title;

  const list = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  }

  box.append(h, list);
  return box;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function warningBlock(warnings) {
  const box = document.createElement("div");
  box.className = "notice warn";

  const title = document.createElement("strong");
  title.textContent = "Worth checking";

  const list = document.createElement("ul");
  for (const w of warnings) {
    const li = document.createElement("li");
    li.textContent = w;
    list.append(li);
  }

  box.append(title, list);
  return box;
}

function sourceBlock(sources) {
  const details = document.createElement("details");
  details.className = "sources";

  const summary = document.createElement("summary");
  summary.textContent = `${sources.length} source${sources.length > 1 ? "s" : ""} used`;

  const list = document.createElement("ul");
  for (const s of sources) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.title || s.url;
    li.append(a);
    list.append(li);
  }

  details.append(summary, list);
  return details;
}

function act(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "act";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function noticeBlock(message, kind = "warn") {
  const box = document.createElement("div");
  box.className = `notice ${kind}`;
  box.textContent = message;
  return box;
}

function showBanner(message, kind = "bad") {
  ensureInner().append(noticeBlock(message, kind));
  scrollToEnd();
}

function scrollToEnd(smooth = true) {
  requestAnimationFrame(() => {
    els.thread.scrollTo({ top: els.thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  });
}

/* -------------------------------- generate -------------------------------- */

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  generate();
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    generate();
  }
});

els.input.addEventListener("input", resizeInput);

function resizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 220)}px`;
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  els.send.classList.toggle("busy", busy);
  els.note.textContent = busy ? "" : els.note.textContent;
}

async function generate() {
  const input = els.input.value.trim();
  if (!input || state.busy) return;

  setBusy(true);
  els.welcome?.remove();
  els.thread.querySelector(".welcome")?.remove();

  const inner = ensureInner();
  const turn = turnBlock(input, null);
  const trace = document.createElement("div");
  trace.className = "trace";
  turn.append(trace);
  inner.append(turn);

  els.input.value = "";
  resizeInput();
  scrollToEnd();

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ input, sessionId: state.currentId || undefined }),
    });

    if (res.status === 401) {
      if (askPassphrase()) {
        turn.remove();
        els.input.value = input;
        setBusy(false);
        return generate();
      }
      throw new Error("Passphrase required.");
    }
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status}).`);
    }

    for await (const event of readSSE(res.body)) handleEvent(event, turn, trace);
  } catch (err) {
    markTraceDone(trace);
    const note = document.createElement("div");
    note.className = "notice bad";
    note.textContent = err.message || String(err);
    turn.append(note);
    scrollToEnd();
  } finally {
    setBusy(false);
    loadSessions();
  }
}

/** Minimal SSE reader — EventSource can't POST, so we parse the stream ourselves. */
async function* readSSE(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        // Ignore a malformed frame rather than killing the stream.
      }
    }
  }
}

function handleEvent(event, turn, trace) {
  switch (event.type) {
    case "session":
      // Adopt the session immediately so a follow-up lands in the same thread.
      if (event.isNew) setActive(event.sessionId, event.title);
      break;
    case "step":
      markTraceDone(trace);
      trace.append(stepRow(event.label, event.detail));
      scrollToEnd();
      break;
    case "result":
      markTraceDone(trace);
      trace.remove();
      turn.append(replyBlock(event.result));
      scrollToEnd();
      break;
    case "studied":
      markTraceDone(trace);
      trace.remove();
      turn.append(studyBlock(event.result));
      scrollToEnd();
      break;
    case "learned":
      turn.append(learnedBlock(event.learned));
      scrollToEnd();
      break;
    case "error": {
      markTraceDone(trace);
      const note = document.createElement("div");
      note.className = "notice bad";
      note.textContent = event.message;
      turn.append(note);
      scrollToEnd();
      break;
    }
  }
}

function stepRow(label, detail) {
  const row = document.createElement("div");
  row.className = "step active";

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "●";

  const text = document.createElement("span");
  text.textContent = label;

  row.append(dot, text);

  if (detail) {
    const d = document.createElement("span");
    d.className = "detail";
    d.textContent = detail;
    row.append(d);
  }
  return row;
}

function markTraceDone(trace) {
  for (const step of trace.querySelectorAll(".step.active")) {
    step.classList.remove("active");
    const dot = step.querySelector(".dot");
    if (dot) dot.textContent = "✓";
  }
}

/* ------------------------------ session chrome ----------------------------- */

$("new-session").addEventListener("click", newSession);

/**
 * Renaming, inline under the title.
 *
 * Closing the row is what marks the edit finished, which is also how the blur
 * handler tells a click-away (save) from an Enter or Escape that already
 * settled it (nothing left to do).
 */
function openRename() {
  if (!state.currentId) return;
  els.renameRow.hidden = false;
  els.renameInput.value = els.title.textContent;
  els.renameInput.focus();
  els.renameInput.select();
}

function closeRename() {
  els.renameRow.hidden = true;
}

async function commitRename() {
  const next = els.renameInput.value.trim();
  closeRename();
  if (!next || next === els.title.textContent) return;
  await api(`/api/sessions/${state.currentId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: next }),
  });
  els.title.textContent = next;
  await loadSessions();
}

els.rename.addEventListener("click", () => {
  if (els.renameRow.hidden) openRename();
  else closeRename();
});

els.renameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitRename();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeRename();
  }
});

// Clicking away keeps what was typed; Enter and Escape have already closed the
// row by the time their blur arrives, so neither double-saves.
els.renameInput.addEventListener("blur", () => {
  if (!els.renameRow.hidden) commitRename();
});

els.del.addEventListener("click", async () => {
  if (!state.currentId) return;
  if (!confirm("Delete this session and all its drafts?")) return;
  await api(`/api/sessions/${state.currentId}`, { method: "DELETE" });
  newSession();
  await loadSessions();
});

/* --------------------------------- drawer --------------------------------- */

function openSidebar() {
  els.sidebar.classList.add("open");
  els.scrim.hidden = false;
}
function closeSidebarOnNarrow() {
  els.sidebar.classList.remove("open");
  if (els.panel.hidden) els.scrim.hidden = true;
}

$("sidebar-open").addEventListener("click", openSidebar);
$("sidebar-close").addEventListener("click", closeSidebarOnNarrow);

/* -------------------------------- settings -------------------------------- */

$("open-settings").addEventListener("click", openSettings);
$("close-settings").addEventListener("click", closeSettings);
els.scrim.addEventListener("click", () => {
  closeSettings();
  closeSidebarOnNarrow();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!els.panel.hidden) closeSettings();
    else closeSidebarOnNarrow();
  }
});

async function openSettings() {
  els.panel.hidden = false;
  els.scrim.hidden = false;
  await Promise.all([
    loadSettings(),
    loadProfile(),
    loadSamples(),
    loadPreferences(),
    loadNotes(),
  ]);
}

function closeSettings() {
  els.panel.hidden = true;
  if (!els.sidebar.classList.contains("open")) els.scrim.hidden = true;
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t === tab);
    for (const p of document.querySelectorAll(".tabpanel")) {
      p.hidden = p.dataset.panel !== tab.dataset.tab;
    }
  });
}

/* -------------------------------- providers -------------------------------- */

let providers = [];
let modelListLoaded = false;

function setNote(el, text, kind) {
  el.textContent = text || "";
  el.hidden = !text;
  el.className = `muted${kind ? ` ${kind}` : ""}`;
}

/** Show only the fields the selected provider actually uses. */
function applyProviderUi(id) {
  const provider = providers.find((p) => p.id === id);
  if (!provider) return;

  setNote($("s-provider-note"), provider.note);
  $("s-baseurl-row").hidden = !provider.needsBaseUrl;
  $("s-jsonmode-row").hidden = id !== "openai";
  $("s-key-section").hidden = !provider.needsKey;

  if (provider.exampleModel) $("s-model").placeholder = provider.exampleModel;
  if (provider.exampleBaseUrl) $("s-baseurl").placeholder = provider.exampleBaseUrl;
}

/** Describes where a key comes from without ever showing the key. */
function keyStateText(secret, label) {
  switch (secret.source) {
    case "env":
      return `${label} is set as a Cloudflare secret. That wins over anything saved here.`;
    case "stored":
      return `${label} saved here (${secret.hint}), encrypted.`;
    default:
      return `No ${label} set.`;
  }
}

async function loadSettings() {
  const data = await api("/api/settings");
  providers = data.providers;

  const select = $("s-provider");
  select.replaceChildren();
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    select.append(opt);
  }

  select.value = data.settings.MODEL_PROVIDER;
  $("s-model").value = data.settings.MODEL_ID;
  $("s-baseurl").value = data.settings.MODEL_BASE_URL;
  $("s-jsonmode").value = data.settings.MODEL_JSON_MODE;
  $("s-search").value = data.settings.SEARCH_PROVIDER;
  $("s-transcript").value = data.settings.TRANSCRIPT_PROVIDER ?? "none";
  applyProviderUi(select.value);

  setNote(
    $("s-result"),
    data.model.configured ? `Live: ${data.model.name}` : data.model.note || "Not configured.",
    data.model.configured ? "ok" : "bad",
  );

  $("s-key-state").textContent = keyStateText(data.secrets.MODEL_API_KEY, "Model API key");
  $("s-search-state").textContent = keyStateText(data.secrets.SEARCH_API_KEY, "Search key");
  $("s-x-state").textContent = keyStateText(data.secrets.X_BEARER_TOKEN, "X bearer token");
  $("s-transcript-state").textContent = keyStateText(
    data.secrets.TRANSCRIPT_API_KEY,
    "Transcript key",
  );

  // Without a passphrase there is no encryption key, so saving is refused.
  const canStore = data.canStoreSecrets;
  for (const id of [
    "s-key",
    "s-key-save",
    "s-searchkey",
    "s-search-save",
    "s-xtoken",
    "s-x-save",
    "s-transcriptkey",
    "s-transcript-save",
  ]) {
    $(id).disabled = !canStore;
  }
  if (!canStore) {
    $("s-key-state").textContent =
      "Set APP_PASSWORD (npx wrangler secret put APP_PASSWORD) before saving keys here — it is the encryption key.";
  }
  if (data.undecryptable?.length) {
    setNote(
      $("s-result"),
      `Stored ${data.undecryptable.join(", ")} can no longer be decrypted — the passphrase changed. Re-enter it below.`,
      "bad",
    );
  }

  if (!modelListLoaded) loadModelList();
}

/** Populates the datalist so the model field offers real ids instead of guesswork. */
async function loadModelList() {
  modelListLoaded = true;
  try {
    const { models } = await api("/api/settings/models");
    const list = $("s-model-list");
    list.replaceChildren();
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.label = m.schema ? m.name : `${m.name} (no structured output)`;
      list.append(opt);
    }
    if (models.length) {
      setNote($("s-model-note"), `${models.length} models available — start typing to filter.`);
    }
  } catch {
    // A missing catalogue just means typing the id by hand.
  }
}

$("s-provider").addEventListener("change", (e) => applyProviderUi(e.target.value));

$("s-save").addEventListener("click", async () => {
  setNote($("s-result"), "Saving…");
  try {
    const res = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        MODEL_PROVIDER: $("s-provider").value,
        MODEL_ID: $("s-model").value.trim(),
        MODEL_BASE_URL: $("s-baseurl").value.trim(),
        MODEL_JSON_MODE: $("s-jsonmode").value,
      }),
    });
    setNote(
      $("s-result"),
      res.model.configured ? `Saved. Live: ${res.model.name}` : `Saved, but ${res.model.note}`,
      res.model.configured ? "ok" : "bad",
    );
    modelListLoaded = false;
    await Promise.all([loadSettings(), loadConfig()]);
  } catch (err) {
    setNote($("s-result"), err.message, "bad");
  }
});

$("s-test").addEventListener("click", async () => {
  setNote($("s-result"), "Testing…");
  try {
    const res = await api("/api/settings/test", { method: "POST" });
    setNote(
      $("s-result"),
      res.ok ? `${res.model} replied in ${res.ms}ms.` : `Failed: ${res.error}`,
      res.ok ? "ok" : "bad",
    );
  } catch (err) {
    setNote($("s-result"), err.message, "bad");
  }
});

/** Saves a key and clears the field, so it never lingers in the DOM. */
async function saveSecret(name, inputId, stateId, label) {
  const input = $(inputId);
  const value = input.value.trim();
  if (!value) return;
  try {
    const res = await api(`/api/settings/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    input.value = "";
    await Promise.all([loadSettings(), loadConfig()]);
    if (res.shadowedByEnv) {
      $(stateId).textContent =
        `Saved, but a Cloudflare secret for ${label} already exists and takes precedence.`;
    }
  } catch (err) {
    setNote($("s-result"), err.message, "bad");
  }
}

$("s-key-save").addEventListener("click", () =>
  saveSecret("MODEL_API_KEY", "s-key", "s-key-state", "the model API key"),
);

$("s-key-clear").addEventListener("click", async () => {
  await api("/api/settings/secrets/MODEL_API_KEY", { method: "DELETE" });
  await Promise.all([loadSettings(), loadConfig()]);
});

$("s-transcript-save").addEventListener("click", async () => {
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ TRANSCRIPT_PROVIDER: $("s-transcript").value }),
  });
  await saveSecret(
    "TRANSCRIPT_API_KEY",
    "s-transcriptkey",
    "s-transcript-state",
    "the transcript key",
  );
  await Promise.all([loadSettings(), loadConfig()]);
});

$("s-search-save").addEventListener("click", async () => {
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ SEARCH_PROVIDER: $("s-search").value }),
  });
  await saveSecret("SEARCH_API_KEY", "s-searchkey", "s-search-state", "the search key");
  await Promise.all([loadSettings(), loadConfig()]);
});

$("s-x-save").addEventListener("click", () =>
  saveSecret("X_BEARER_TOKEN", "s-xtoken", "s-x-state", "the X bearer token"),
);

/* --------------------------------- memory --------------------------------- */

async function loadProfile() {
  const { profile, handle } = await api("/api/memory/profile");
  $("m-handle").value = handle || "";
  $("m-voice").value = profile.voice || "";
  $("m-emoji").value = profile.emoji;
  $("m-hashtags").value = profile.hashtags;
  $("m-maxchars").value = profile.max_chars;
  $("m-audience").value = profile.audience || "";
  $("m-do").value = (profile.do || []).join("\n");
  $("m-dont").value = (profile.dont || []).join("\n");
}

$("save-profile").addEventListener("click", async () => {
  const lines = (id) => $(id).value.split("\n").map((s) => s.trim()).filter(Boolean);

  await api("/api/memory/profile", {
    method: "PUT",
    body: JSON.stringify({
      handle: $("m-handle").value.trim(),
      profile: {
        voice: $("m-voice").value.trim(),
        emoji: $("m-emoji").value,
        hashtags: $("m-hashtags").value,
        max_chars: Number($("m-maxchars").value) || 280,
        audience: $("m-audience").value.trim(),
        do: lines("m-do"),
        dont: lines("m-dont"),
      },
    }),
  });

  await loadConfig();
  const saved = $("profile-saved");
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1600);
});

async function loadSamples() {
  const { samples } = await api("/api/memory/samples");
  const list = $("sample-list");
  list.replaceChildren();

  for (const s of samples) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = s.text.length > 150 ? `${s.text.slice(0, 150)}…` : s.text;
    li.append(
      span,
      act("✕", async () => {
        await api(`/api/memory/samples/${s.id}`, { method: "DELETE" });
        li.remove();
      }),
    );
    list.append(li);
  }
}

$("add-samples").addEventListener("click", async () => {
  const text = $("m-samples").value.trim();
  if (!text) return;
  await api("/api/memory/samples", { method: "POST", body: JSON.stringify({ text }) });
  $("m-samples").value = "";
  await loadSamples();
});

async function loadPreferences() {
  renderPreferences((await api("/api/memory/preferences")).preferences);
}

function renderPreferences(preferences) {
  const list = $("pref-list");
  list.replaceChildren();

  for (const p of preferences) {
    const li = document.createElement("li");
    if (!p.active) li.className = "off";

    const span = document.createElement("span");
    span.className = "rule-text";
    span.textContent = p.rule;
    span.title = "Click to edit";

    if (p.source === "inferred") {
      const tag = document.createElement("em");
      tag.className = "tag";
      tag.textContent = "learned";
      span.append(" ", tag);
    }

    // Click to edit in place; Enter saves, Escape cancels.
    span.addEventListener("click", () => startRuleEdit(li, p, span));

    li.append(
      span,
      act(p.active ? "mute" : "unmute", async () => {
        const { preferences: next } = await api(`/api/memory/preferences/${p.id}`, {
          method: "PATCH",
          body: JSON.stringify({ active: !p.active }),
        });
        renderPreferences(next);
      }),
      act("✕", async () => {
        await api(`/api/memory/preferences/${p.id}`, { method: "DELETE" });
        li.remove();
      }),
    );
    list.append(li);
  }
}

function startRuleEdit(li, pref, span) {
  if (li.querySelector("input.rule-edit")) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "rule-edit";
  input.value = pref.rule;

  const finish = async (save) => {
    const value = input.value.trim();
    input.replaceWith(span);
    if (!save || !value || value === pref.rule) return;
    const { preferences } = await api(`/api/memory/preferences/${pref.id}`, {
      method: "PATCH",
      body: JSON.stringify({ rule: value }),
    });
    renderPreferences(preferences);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  span.replaceWith(input);
  input.focus();
  input.select();
}

$("pref-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const rule = $("m-pref").value.trim();
  if (!rule) return;
  const { preferences } = await api("/api/memory/preferences", {
    method: "POST",
    body: JSON.stringify({ rule }),
  });
  $("m-pref").value = "";
  renderPreferences(preferences);
});

/* -------------------------------- knowledge -------------------------------- */

async function loadNotes() {
  renderNotes((await api("/api/memory/notes")).notes);
}

function renderNotes(notes) {
  const list = $("note-list");
  list.replaceChildren();

  for (const note of notes) {
    const li = document.createElement("li");
    if (!note.active) li.className = "off";

    const span = document.createElement("span");
    span.className = "rule-text";
    span.textContent = note.note;
    span.title = "Click to edit";

    if (note.source_title) {
      const tag = document.createElement("em");
      tag.className = "tag";
      tag.textContent = note.source_title.length > 40
        ? `${note.source_title.slice(0, 40)}…`
        : note.source_title;
      if (note.source_url) tag.title = note.source_url;
      span.append(" ", tag);
    }

    span.addEventListener("click", () => startNoteEdit(li, note, span));

    li.append(
      span,
      act(note.active ? "mute" : "unmute", async () => {
        const { notes: next } = await api(`/api/memory/notes/${note.id}`, {
          method: "PATCH",
          body: JSON.stringify({ active: !note.active }),
        });
        renderNotes(next);
      }),
      act("✕", async () => {
        await api(`/api/memory/notes/${note.id}`, { method: "DELETE" });
        li.remove();
      }),
    );
    list.append(li);
  }
}

function startNoteEdit(li, note, span) {
  if (li.querySelector("input.rule-edit")) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "rule-edit";
  input.value = note.note;

  const finish = async (save) => {
    const value = input.value.trim();
    input.replaceWith(span);
    if (!save || !value || value === note.note) return;
    const { notes } = await api(`/api/memory/notes/${note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ note: value }),
    });
    renderNotes(notes);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  span.replaceWith(input);
  input.focus();
  input.select();
}

$("note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = $("m-note").value.trim();
  if (!note) return;
  const { notes } = await api("/api/memory/notes", {
    method: "POST",
    body: JSON.stringify({ note }),
  });
  $("m-note").value = "";
  renderNotes(notes);
});

/* --------------------------------- startup -------------------------------- */

if (els.starters) fillStarters(els.starters);
loadConfig();
loadSessions();
resizeInput();
els.input.focus();
