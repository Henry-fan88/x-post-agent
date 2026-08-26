/**
 * Workers AI adapter -- runs on Cloudflare's own inference, so there is no
 * external API key at all. Enable the "ai" binding in wrangler.jsonc to use it.
 */

import { type ChatMessage, type ChatModel, type CompleteOptions, ModelError } from "./types";

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function workersAiModel(ai: Ai, modelId?: string): ChatModel {
  const model = modelId || DEFAULT_MODEL;

  return {
    name: `workers-ai:${model}`,
    async complete(messages: ChatMessage[], opts: CompleteOptions = {}) {
      const result = (await ai.run(model as keyof AiModels, {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: opts.maxTokens ?? 4096,
      } as never)) as { response?: string } | string;

      const text = typeof result === "string" ? result : (result.response ?? "");
      if (!text) throw new ModelError("Workers AI returned an empty response.");
      return text.trim();
    },
  };
}
