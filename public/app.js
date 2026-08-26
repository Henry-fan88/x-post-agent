/**
 * UI for the post agent.
 *
 * No framework on purpose: the whole surface is one input, a progress trace,
 * and a couple of cards. Everything user-supplied goes in through textContent,
 * never innerHTML.
 */

const $ = (id) => document.getElementById(id);

const els = {
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  trace: $("trace"),
  result: $("result"),
  empty: $("empty"),
  chip: $("status-chip"),
  panel: $("memory-panel"),
  scrim: $("scrim"),
};

let config = { maxPostChars: 280, authRequired: false };
let passphrase = sessionStorage.getItem("x-post-agent-pass") || "";
let inFlight = false;

/* ------------------------------ networking ------------------------------- */

function headers(extra = {}) {
  const h = { "content-type": "application/json", ...extra };
  if (passphrase) h["x-app-password"] = passphrase;
  return h;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: headers(options.headers) });
  if (res.status === 401) {
    const entered = prompt("Passphrase:");
    if (entered) {
      passphrase = entered;
      sessionStorage.setItem("x-post-agent-pass", entered);
      return api(path, options);
    }
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
    config = await api("/api/config");
    const { model, search } = config;
    els.chip.textContent = model.configured ? model.name : "no model key";
    els.chip.classList.toggle("warn", !model.configured);
    els.chip.title = [
      model.note || `Model: ${model.name}`,
      `Search: ${search.configured ? search.provider : "off"}`,
      `X API: ${config.xApi.configured ? "on" : "oEmbed only"}`,
    ].join("\n");
  } catch {
    els.chip.textContent = "offline";
    els.chip.classList.add("warn");
  }
}

/* ------------------------------- generate -------------------------------- */

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  generate();
});

els.input.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    generate();
  }
});

// Grow the box with the text rather than scrolling inside it.
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 340)}px`;
});

async function generate() {
  const input = els.input.value.trim();
  if (!input || inFlight) return;

  inFlight = true;
  els.send.disabled = true;
  els.send.textContent = "Writing…";
  els.empty.hidden = true;
  els.result.hidden = true;
  els.result.replaceChildren();
  els.trace.hidden = false;
  els.trace.replaceChildren();

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ input }),
    });

    if (res.status === 401) {
      const entered = prompt("Passphrase:");
      if (entered) {
        passphrase = entered;
        sessionStorage.setItem("x-post-agent-pass", entered);
        inFlight = false;
        resetSend();
        return generate();
      }
      throw new Error("Passphrase required.");
    }
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status}).`);
    }

    for await (const event of readSSE(res.body)) handleEvent(event);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    inFlight = false;
    resetSend();
  }
}

function resetSend() {
  els.send.disabled = false;
  els.send.textContent = "Write it";
}

/** Minimal SSE parser -- EventSource can't POST, so we read the stream ourselves. */
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
        // Ignore malformed frames rather than killing the stream.
      }
    }
  }
}

function handleEvent(event) {
  switch (event.type) {
    case "step":
      markStepsDone();
      els.trace.append(stepRow(event.label, event.detail));
      break;
    case "format":
      markStepsDone();
      break;
    case "result":
      markStepsDone();
      renderResult(event.result);
      break;
    case "error":
      markStepsDone();
      showError(event.message);
      break;
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

function markStepsDone() {
  for (const step of els.trace.querySelectorAll(".step.active")) {
    step.classList.remove("active");
    const dot = step.querySelector(".dot");
    if (dot) dot.textContent = "✓";
  }
}

/* -------------------------------- results -------------------------------- */

function renderResult(result) {
  els.result.hidden = false;
  els.result.replaceChildren();

  const bar = document.createElement("div");
  bar.className = "format-bar";

  const badge = document.createElement("span");
  badge.className = "format-badge";
  badge.textContent = result.formatLabel;

  const why = document.createElement("span");
  why.className = "format-why";
  why.textContent = result.formatRationale;

  bar.append(badge, why);
  els.result.append(bar);

  result.variants.forEach((variant, i) => {
    els.result.append(variantCard(variant, i, result.draftId));
  });

  if (result.warnings?.length) els.result.append(warningBlock(result.warnings));
  if (result.sources?.length) els.result.append(sourceBlock(result.sources));
}

function variantCard(variant, index, draftId) {
  const card = document.createElement("article");
  card.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";

  const n = document.createElement("span");
  n.className = "card-n";
  n.textContent = `OPTION ${index + 1}`;

  const angle = document.createElement("span");
  angle.className = "card-angle";
  angle.textContent = variant.angle || "";

  head.append(n, angle);
  card.append(head);

  const fullText = variant.parts.map((p) => p.text).join("\n\n");

  variant.parts.forEach((part, i) => {
    const wrap = document.createElement("div");
    wrap.className = "part";

    const text = document.createElement("div");
    text.className = "part-text";
    text.textContent = part.text;

    const meta = document.createElement("div");
    const over = part.chars > config.maxPostChars;
    meta.className = `part-meta${over ? " over" : ""}`;
    meta.textContent =
      (variant.parts.length > 1 ? `${i + 1}/${variant.parts.length} · ` : "") +
      `${part.chars}/${config.maxPostChars}`;

    wrap.append(text, meta);
    card.append(wrap);
  });

  card.append(actionBar(card, fullText, draftId));
  return card;
}

function actionBar(card, fullText, draftId) {
  const bar = document.createElement("div");
  bar.className = "actions";

  const copy = button("Copy", async () => {
    await navigator.clipboard.writeText(fullText);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1400);
  });

  // Opens X's compose window prefilled. The user reviews and posts it
  // themselves -- the agent never posts on anyone's behalf.
  const open = button("Open in X", () => {
    const url = `https://x.com/intent/post?text=${encodeURIComponent(fullText)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  });

  const spacer = document.createElement("span");
  spacer.className = "spacer";

  const posted = button("Posted", () => sendFeedback(bar, draftId, "posted", fullText));
  const edited = button("I edited it", () => toggleEditor(card, bar, draftId, fullText));
  const nope = button("Not this", () => sendFeedback(bar, draftId, "rejected"));

  bar.append(copy, open, spacer, posted, edited, nope);
  return bar;
}

function toggleEditor(card, bar, draftId, fullText) {
  const existing = card.querySelector(".edit-box");
  if (existing) {
    existing.remove();
    return;
  }

  const box = document.createElement("div");
  box.className = "edit-box";

  const area = document.createElement("textarea");
  area.rows = 5;
  area.value = fullText;

  const row = document.createElement("div");
  row.className = "actions";
  row.style.background = "transparent";
  row.style.border = "0";
  row.style.padding = "0";

  const save = button("Save what you posted", () =>
    sendFeedback(bar, draftId, "edited", area.value.trim()),
  );
  row.append(save);

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

    const card = bar.closest(".card");
    card?.querySelector(".edit-box")?.remove();

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
    showError(err.message);
  }
}

function warningBlock(warnings) {
  const box = document.createElement("div");
  box.className = "notice";

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

function showError(message) {
  const box = document.createElement("div");
  box.className = "notice";
  box.textContent = message;
  els.result.hidden = false;
  els.result.append(box);
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/* --------------------------------- memory -------------------------------- */

$("open-memory").addEventListener("click", openMemory);
$("close-memory").addEventListener("click", closeMemory);
els.scrim.addEventListener("click", closeMemory);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.panel.hidden) closeMemory();
});

async function openMemory() {
  els.panel.hidden = false;
  els.scrim.hidden = false;
  await Promise.all([loadProfile(), loadSamples(), loadPreferences()]);
}

function closeMemory() {
  els.panel.hidden = true;
  els.scrim.hidden = true;
}

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
  const lines = (id) =>
    $(id).value.split("\n").map((s) => s.trim()).filter(Boolean);

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

  config.maxPostChars = Number($("m-maxchars").value) || 280;
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
    span.textContent = s.text.length > 160 ? `${s.text.slice(0, 160)}…` : s.text;
    li.append(
      span,
      button("×", async () => {
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
  const { preferences } = await api("/api/memory/preferences");
  renderPreferences(preferences);
}

function renderPreferences(preferences) {
  const list = $("pref-list");
  list.replaceChildren();

  for (const p of preferences) {
    const li = document.createElement("li");
    if (!p.active) li.className = "off";

    const span = document.createElement("span");
    span.textContent = p.source === "inferred" ? `${p.rule}  (learned)` : p.rule;

    li.append(
      span,
      button(p.active ? "mute" : "unmute", async () => {
        const { preferences: next } = await api(`/api/memory/preferences/${p.id}`, {
          method: "PATCH",
          body: JSON.stringify({ active: !p.active }),
        });
        renderPreferences(next);
      }),
      button("×", async () => {
        await api(`/api/memory/preferences/${p.id}`, { method: "DELETE" });
        li.remove();
      }),
    );
    list.append(li);
  }
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

loadConfig();
