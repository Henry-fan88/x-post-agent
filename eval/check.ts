/**
 * The eval.
 *
 * Checks the decisions this app makes that must not drift: whether a turn is a
 * post or a reply, how many drafts come back, how X counts the characters, what
 * language to answer in, and which reply shapes are rejected before a user can
 * send them.
 *
 * Every one of these is a pure function on purpose. The model's taste is not
 * testable in CI; the rules around it are, and those are what a refactor
 * quietly breaks. Nothing here calls the network -- `fetch` is replaced with a
 * throwing stub below, so a live X call would fail the run rather than pass it
 * slowly.
 *
 *   node --import ./eval/register.js eval/check.ts
 */

import fixtures from "./fixtures.json" with { type: "json" };

/**
 * The only Node API this needs, declared rather than pulled in.
 *
 * @types/node for one field is not a trade worth making, and the eval has no
 * other reason to know it is running outside a Worker.
 */
declare const process: { exitCode: number };

import { dominantScript, weightedLength } from "../src/agent/chars.ts";
import { clampVariants, variantCount } from "../src/agent/formats.ts";
import { runAgent } from "../src/agent/orchestrator.ts";
import {
  type RefineTurn,
  STRATEGY,
  critiquePrompt,
  draftPrompt,
  replyPrompt,
} from "../src/agent/prompts.ts";
import { replyProblems } from "../src/agent/reply.ts";
import { RouteError, detectMode } from "../src/agent/route.ts";
import { mockModel } from "../src/llm/mock.ts";
import { relevantPreferences } from "../src/memory/store.ts";
import type {
  AgentEvent,
  GenerateResult,
  OutputMode,
  Preference,
  Understanding,
  Variant,
} from "../src/types.ts";

/* ------------------------------ no network ------------------------------- */

globalThis.fetch = (input: RequestInfo | URL) => {
  throw new Error(`The eval tried to reach the network: ${String(input)}`);
};

/* ------------------------------- reporting ------------------------------- */

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
}

function group(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------- routing -------------------------------- */

group("routing — post or reply, never both");

for (const f of fixtures.routing) {
  const explicit = (f as { explicit?: string }).explicit as OutputMode | undefined;

  if ((f as { error?: boolean }).error) {
    let threw = false;
    try {
      detectMode(f.input, explicit ?? null);
    } catch (err) {
      threw = err instanceof RouteError;
    }
    check(f.name, threw, "expected a RouteError rather than a silent post");
    continue;
  }

  const decision = detectMode(f.input, explicit ?? null);
  const wantId = (f as { inReplyToId?: string }).inReplyToId ?? null;

  check(
    f.name,
    decision.mode === f.mode && decision.inReplyToId === wantId,
    `got mode=${decision.mode} inReplyToId=${decision.inReplyToId}, wanted mode=${f.mode} inReplyToId=${wantId}`,
  );
}

// The property that the whole split exists to guarantee.
check(
  "a post decision never carries a reply target",
  fixtures.routing
    .filter((f) => !(f as { error?: boolean }).error)
    .every((f) => {
      const d = detectMode(f.input, ((f as { explicit?: string }).explicit as OutputMode) ?? null);
      return d.mode === "reply" ? d.inReplyToId !== null : d.inReplyToId === null;
    }),
  "a post came back with an inReplyToId, or a reply came back without one",
);

/* ----------------------------- variant lock ------------------------------ */

group("variants — 1 or 2 by the lock, replies always 1");

for (const f of fixtures.variants) {
  const got = variantCount(f.format, f.mode as OutputMode);
  check(
    `${f.mode}/${f.format} wants ${f.expect}`,
    got === f.expect,
    `got ${got}`,
  );
}

const draft = (text: string): Variant => ({ parts: [{ text, chars: text.length }], angle: "" });

check(
  "a reply is clamped to one draft even when the model returns two",
  clampVariants([draft("first reply"), draft("a completely different second reply")], 1).length === 1,
);

check(
  "two genuinely different angles both survive",
  clampVariants(
    [
      draft("the retry policy is the hard part of an agent framework, not the prompting"),
      draft("we spent four weeks on evals and shipped nothing anyone noticed"),
    ],
    2,
  ).length === 2,
);

check(
  "a second draft that is the first one reworded is dropped",
  clampVariants(
    [
      draft("the retry policy is the hard part of an agent framework, not the prompting"),
      draft("the hard part of an agent framework is the retry policy, not the prompting"),
    ],
    2,
  ).length === 1,
);

// The prompts have to ask for what the lock enforces, or the model fights it.
const understanding: Understanding = {
  kind: "idea",
  mode: "post",
  inReplyToId: null,
  intent: "",
  topics: [],
  claims: [],
  urls: [],
  directions: [],
  needs_research: false,
  research_queries: [],
};

check(
  "the draft prompt never hardcodes exactly two variants",
  !/exactly 2 objects/.test(draftPrompt("idea", understanding, "build_log", "", [], [], 280, 2)),
  "found the old 'array of exactly 2 objects' instruction",
);

check(
  "a single-variant format asks for exactly one",
  /exactly 1 object/.test(draftPrompt("idea", understanding, "one_liner", "", [], [], 280, 1)),
);

/* ------------------------------- replies --------------------------------- */

group("replies — the shapes that must not ship");

for (const f of fixtures.replies) {
  const problems = replyProblems(f.reply, { parentText: f.parent, maxChars: 280 });
  check(
    f.name,
    f.fails ? problems.length > 0 : problems.length === 0,
    f.fails ? "expected this to be caught, and it was not" : `unexpectedly flagged: ${problems.join(" | ")}`,
  );
}

const replyText = replyPrompt(
  "he's wrong about the batching",
  { ...understanding, mode: "reply", inReplyToId: "123" },
  "",
  { handle: "someone", id: "123", text: "Agents fail because the models aren't good enough." },
  [],
  [],
  280,
);

check(
  "the reply prompt asks for exactly one draft",
  /exactly 1 object/.test(replyText),
);
check(
  "the reply prompt names the post it sits under",
  replyText.includes("<parent>") && replyText.includes("status 123"),
);
check(
  "the reply prompt forbids recapping the parent",
  /Do not recap or paraphrase/.test(replyText),
);
check(
  "the reply prompt refuses a standalone post",
  /Do not write a standalone post/.test(replyText),
);

/* ------------------------------- language -------------------------------- */

group("language — answer in the language you were addressed in");

for (const f of fixtures.language) {
  const got = dominantScript(f.text);
  check(f.name, got === f.script, `detected ${got}, wanted ${f.script}`);
}

const chineseParent = "我们把推理迁到了自研芯片上，吞吐是原来的三倍，成本大概只有三分之一。";
const chineseReply = replyPrompt(
  "tell him the batch size matters",
  { ...understanding, mode: "reply", inReplyToId: "1" },
  "",
  { handle: "someone", id: "1", text: chineseParent },
  [],
  [],
  280,
);
check(
  "a Chinese parent produces a prompt that demands Chinese",
  /Chinese\/Japanese\/Korean characters/.test(chineseReply) &&
    /do not answer in English/.test(chineseReply),
);

const englishReply = replyPrompt(
  "tell him the batch size matters",
  { ...understanding, mode: "reply", inReplyToId: "1" },
  "",
  { handle: "someone", id: "1", text: "We moved inference onto our own chips." },
  [],
  [],
  280,
);
check(
  "an English parent is not told to write in another script",
  !/do not answer in English/.test(englishReply) &&
    /Write in the same language as the post you are replying to/.test(englishReply),
);

/* -------------------------------- counting ------------------------------- */

group("length — X's weighted count, not code points");

for (const f of fixtures.chars) {
  const text = (f as { repeat?: number }).repeat
    ? f.text.repeat((f as { repeat: number }).repeat)
    : f.text;
  const got = weightedLength(text);
  check(f.name, got === f.expect, `got ${got}, wanted ${f.expect}`);
}

check(
  "the weighted count differs from the code-point count for CJK",
  weightedLength("中".repeat(140)) === 280 && [..."中".repeat(140)].length === 140,
  "a CJK post that fits by code points must not fit by X's count",
);

/* ------------------------------- pipeline -------------------------------- */

group("pipeline — one run, one kind of output");

/**
 * D1, reduced to what the pipeline actually needs from it here.
 *
 * Every read comes back empty and every write is accepted, which is exactly the
 * cold-start case: no profile, no samples, no rules. That is the state where a
 * routing or variant-count bug is visible rather than masked by remembered
 * preferences, and it needs no SQL engine to reproduce.
 */
function stubDb(rows: unknown[] = []) {
  const writes: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => null,
        all: async () => ({ results: rows }),
        run: async () => {
          writes.push(sql);
          return { success: true };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, writes };
}

async function run(
  input: string,
  history?: RefineTurn[],
): Promise<GenerateResult> {
  const { db } = stubDb();
  const events: AgentEvent[] = [];
  const result = await runAgent({
    cfg: {
      maxPostChars: 280,
      xBearerToken: "",
    } as never,
    db,
    model: mockModel(),
    search: null,
    input,
    sessionId: "eval-session",
    history,
    emit: (event) => {
      events.push(event);
    },
  });
  return result as GenerateResult;
}

const postRun = await run("the hard part of an agent framework is the retry policy, not the prompting");
check("an idea produces a post", postRun.mode === "post", `got ${postRun.mode}`);
check("a post carries no reply target", postRun.inReplyToId === null);
check(
  "a post's variant count obeys the lock",
  postRun.variants.length === variantCount(postRun.format, "post"),
  `${postRun.variants.length} drafts for format ${postRun.format}`,
);

const replyRun = await run("https://x.com/someone/status/1934567890123456789");
check("an X status link produces a reply", replyRun.mode === "reply", `got ${replyRun.mode}`);
check(
  "the reply knows what it is replying to",
  replyRun.inReplyToId === "1934567890123456789",
  `got ${replyRun.inReplyToId}`,
);
check("a reply is exactly one draft", replyRun.variants.length === 1, `got ${replyRun.variants.length}`);
check("a reply is a single post, not a thread", replyRun.variants[0].parts.length === 1);
check(
  "an unreadable parent is a warning, not a silent guess",
  replyRun.warnings.some((w) => /replying to/i.test(w)),
  `warnings: ${replyRun.warnings.join(" | ")}`,
);

const askedForPost = await run(
  "write a post about this https://x.com/someone/status/1934567890123456789",
);
check(
  "asking for a post about an X link produces a post",
  askedForPost.mode === "post" && askedForPost.inReplyToId === null,
  `got mode=${askedForPost.mode} inReplyToId=${askedForPost.inReplyToId}`,
);

check(
  "no run returned both a post and a reply",
  [postRun, replyRun, askedForPost].every(
    (r) => (r.mode === "reply") === (r.inReplyToId !== null),
  ),
);

// The bug this fixes: a follow-up used to reset the session to a fresh idea, so
// "make it shorter" on a reply came back as a standalone post with nowhere to go.
const refinedReply = await run("make it shorter", [
  {
    instruction: "https://x.com/someone/status/1934567890123456789",
    format: "reply",
    mode: "reply",
    inReplyToId: "1934567890123456789",
    kind: "x_post",
    variants: [{ parts: [{ text: "the batching is the part that breaks first" }] }],
  },
]);

check("refining a reply still produces a reply", refinedReply.mode === "reply");
check(
  "refining a reply keeps the post it belongs under",
  refinedReply.inReplyToId === "1934567890123456789",
  `got ${refinedReply.inReplyToId}`,
);
check("a refined reply is still one draft", refinedReply.variants.length === 1);
check(
  "refining does not reset the input kind to an idea",
  refinedReply.understanding.kind === "x_post",
  `got ${refinedReply.understanding.kind}`,
);

const refinedPost = await run("make it punchier", [
  {
    instruction: "an idea about retry policies",
    format: "build_log",
    mode: "post",
    inReplyToId: null,
    kind: "idea",
    variants: [{ parts: [{ text: "we shipped the retry policy and it broke twice" }] }],
  },
]);
check(
  "refining a post stays a post with no reply target",
  refinedPost.mode === "post" && refinedPost.inReplyToId === null,
);

/* ---------------------------- topic-scoped rules -------------------------- */

group("memory — a topic rule fires only on its own topic");

const prefRows: Preference[] = [
  { id: 1, rule: "no em dashes", scope: "global", weight: 1, source: "user", active: 1, created_at: "" },
  { id: 2, rule: "always name the tier", scope: "topic:pricing", weight: 1, source: "user", active: 1, created_at: "" },
  { id: 3, rule: "say borrow checker, not BC", scope: "topic:rust", weight: 1, source: "user", active: 1, created_at: "" },
  { id: 4, rule: "open on the claim", scope: "format:hot_take", weight: 1, source: "user", active: 1, created_at: "" },
];
const prefDb = stubDb(prefRows).db;

const onRust = (await relevantPreferences(prefDb, "hot_take", ["rust", "memory safety"])).map(
  (p) => p.rule,
);
check(
  "a pricing rule does not appear on a rust-tagged draft",
  !onRust.includes("always name the tier"),
  `got: ${onRust.join(" | ")}`,
);
check("the matching topic rule does appear", onRust.includes("say borrow checker, not BC"));
check("global rules always appear", onRust.includes("no em dashes"));
check("the matching format rule appears", onRust.includes("open on the claim"));

const onPricing = (await relevantPreferences(prefDb, "one_liner", ["pricing strategy"])).map(
  (p) => p.rule,
);
check(
  "a topic rule matches a longer tag containing it",
  onPricing.includes("always name the tier"),
  `got: ${onPricing.join(" | ")}`,
);
check(
  "a format rule for another format stays out",
  !onPricing.includes("open on the claim"),
);
check(
  "with no topics, no topic rules fire",
  !(await relevantPreferences(prefDb, null, [])).some((p) => p.scope.startsWith("topic:")),
);

/* ------------------------------- strategy -------------------------------- */

group("prompts — the strategy is in them, this week's news is not");

for (const [name, pattern] of [
  ["a party, not a stage", /party, not a stage/i],
  ["replies are what get read while small", /the reply is what gets read/i],
  ["the three reflexes", /learning in public.*building in\s+public/is],
  ["value before promotion", /Do not open by promoting a company or a product/i],
  ["ride the object already in the sources", /If this turn's sources name a live proper noun/i],
  ["raw beats polished", /Raw beats polished/i],
  ["no thread announced as a thread", /A thread announced as a thread/i],
  ["no bait", /holds the useful part back/i],
  ["no fake questions", /asked to farm replies/i],
  ["no reply slop", /Reply slop/i],
  ["no fake scoops", /A scoop that is not one/i],
  ["no unasked-for growth retrospective", /how I grew on X/i],
] as [string, RegExp][]) {
  check(`the strategy states: ${name}`, pattern.test(STRATEGY));
}

// Whatever is hot this week belongs in the turn's sources, never frozen into a
// prompt that will still be running in six months.
const TICKERS = /\bNVDA\b|AGENTS\.md|\bGLM-\d|Terminal-Bench|\bY Combinator\b|\bKimi\b|\bMoonshot\b/i;
check(
  "no proper nouns from this week are frozen into the strategy",
  !TICKERS.test(STRATEGY),
  "a ticker or product name leaked into the system prompt",
);
check(
  "the draft prompt carries the strategy",
  draftPrompt("idea", understanding, "build_log", "", [], [], 280, 2).includes(STRATEGY),
);
check(
  "the reply prompt carries the strategy",
  replyText.includes(STRATEGY),
);

const postCritique = critiquePrompt({
  brief: "",
  directions: [],
  draftsJson: "{}",
  maxChars: 280,
  mode: "post",
});
const replyCritique = critiquePrompt({
  brief: "",
  directions: [],
  draftsJson: "{}",
  maxChars: 280,
  mode: "reply",
  parentText: "Agents fail because the models aren't good enough.",
  problems: ["It restates the post it is replying to."],
});

check(
  "a post is checked for opening on a sales pitch",
  /does not open by selling a company or product/i.test(postCritique),
);
check(
  "a post is checked with X's weighted count",
  /CJK characters and emoji cost two/i.test(postCritique),
);
check(
  "a reply is checked as a reply, not as a post",
  /if it would work posted on its own/i.test(replyCritique) &&
    !/The first line stands on its own/.test(replyCritique),
);
check(
  "the reply critique is handed the faults already found",
  replyCritique.includes("It restates the post it is replying to."),
);
check(
  "the reply critique sees the parent",
  replyCritique.includes("Agents fail because the models aren't good enough."),
);

/* -------------------------------- verdict -------------------------------- */

console.log(`\n${"-".repeat(60)}`);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  console.log("");
  process.exitCode = 1;
} else {
  console.log(`${passed} checks passed. No network calls.\n`);
}
