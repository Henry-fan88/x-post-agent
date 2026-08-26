/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * Also covers OpenRouter, Groq, DeepSeek, Together, vLLM and anything else
 * speaking the same shape -- point MODEL_BASE_URL at their endpoint.
 */

import { type ChatMessage, type ChatModel, type CompleteOptions, ModelError } from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";

export function openAiModel(
  apiKey: string,
  modelId?: string,
  baseUrl?: string,
): ChatModel {
  const model = modelId || DEFAULT_MODEL;
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    name: `openai:${model}`,
    async complete(messages: ChatMessage[], opts: CompleteOptions = {}) {
      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? 4096,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (opts.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "response", strict: false, schema: opts.jsonSchema },
        };
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new ModelError(
          `OpenAI-compatible ${res.status}: ${(await res.text()).slice(0, 500)}`,
          res.status,
        );
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return (json.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}
