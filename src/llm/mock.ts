/**
 * Zero-config provider so the whole pipeline runs before you pick a model.
 *
 * It returns structurally valid responses for each pipeline stage, which means
 * the UI, the SSE stream, the D1 writes and the feedback loop are all
 * exercisable today. The prose is obviously canned -- that is the point.
 */

import type { ChatMessage, ChatModel, CompleteOptions } from "./types";

/** The orchestrator wraps the user's raw input in <input> tags. */
function extractInput(messages: ChatMessage[]): string {
  const joined = messages.map((m) => m.content).join("\n");
  const m = joined.match(/<input>([\s\S]*?)<\/input>/);
  return (m?.[1] ?? joined).trim();
}

function firstSentence(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  const cut = s.match(/^(.{20,}?[.!?])\s/);
  return (cut?.[1] ?? s).slice(0, max);
}

export function mockModel(): ChatModel {
  return {
    name: "mock:no-api-key",
    async complete(messages: ChatMessage[], opts: CompleteOptions = {}) {
      const input = extractInput(messages);
      const urls = input.match(/https?:\/\/\S+/g) ?? [];
      const words = input
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .match(/[a-z][a-z0-9+#.-]{3,}/g) ?? [];
      const topics = [...new Set(words)].slice(0, 4);

      switch (opts.task) {
        case "understand":
          return JSON.stringify({
            kind: urls.length ? (urls.some((u) => /(?:twitter|x)\.com/.test(u)) ? "x_post" : "link") : "idea",
            intent: "Share a point of view on the pasted material.",
            topics,
            claims: [firstSentence(input, 120)],
            urls,
            needs_research: urls.length === 0 && input.length < 200,
            research_queries: topics.slice(0, 2).map((t) => `${t} 2026`),
          });

        case "choose_format":
          return JSON.stringify({
            format: urls.length ? "quote_reaction" : "hot_take",
            alternate: "one_liner",
            rationale: urls.length
              ? "Mock provider: your input has a link, so it picked a reaction. Set MODEL_PROVIDER for a real decision."
              : "Mock provider: no link, so it defaulted to a hot take. Set MODEL_PROVIDER for a real decision.",
          });

        case "draft":
          return JSON.stringify({
            variants: [
              {
                parts: [
                  `[mock draft] ${firstSentence(input, 180)}`,
                  ...(urls.length ? [] : []),
                ],
                angle: "Straight restatement of the idea, sharpened.",
              },
              {
                parts: [
                  `[mock draft] The part everyone skips: ${firstSentence(input, 150)}`,
                ],
                angle: "Leads with the overlooked detail.",
              },
            ],
          });

        case "refine":
          return JSON.stringify({
            format: /thread/i.test(input) ? "insight_thread" : "hot_take",
            changed: `[mock] Pretended to apply: "${firstSentence(input, 80)}"`,
            variants: [
              {
                parts: [`[mock revision] ${firstSentence(input, 180)}`],
                angle: "Mock revision A.",
              },
              {
                parts: [`[mock revision] Another take on: ${firstSentence(input, 150)}`],
                angle: "Mock revision B.",
              },
            ],
          });

        case "critique":
          return JSON.stringify({
            variants: null, // no revisions needed
            warnings: ["Running on the mock provider -- no real model was called."],
          });

        case "extract": {
          // Mirrors the real heuristic closely enough to exercise the path:
          // generalising language means durable, anything else is one-off.
          const durable = /\b(never|always|from now on|stop|don'?t ever|you keep)\b/i.test(input);
          return JSON.stringify({
            rules: durable
              ? [{ rule: `[mock] ${firstSentence(input, 80)}`, durable: true, confidence: 0.9 }]
              : [],
            profile: /\bno (emoji|emojis)\b/i.test(input) ? { emoji: "never" } : null,
          });
        }

        case "learn":
          return JSON.stringify({ rules: [] });

        default:
          return JSON.stringify({});
      }
    },
  };
}
