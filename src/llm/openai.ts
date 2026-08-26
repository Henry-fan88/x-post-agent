/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * Also covers OpenRouter, Groq, DeepSeek, Together, vLLM and anything else
 * speaking the same shape -- point MODEL_BASE_URL at their endpoint.
 */

import { type ChatMessage, type ChatModel, type CompleteOptions, ModelError } from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";

/**
 * How hard to lean on the provider for JSON.
 *
 * Gateways front many models and not all of them accept `response_format`, so
 * this is a valve rather than an assumption. Every prompt already asks for bare
 * JSON and `parseJson` tolerates fences and surrounding prose, so "off" still
 * works -- it just leans on the prompt instead of the API.
 */
export type JsonMode = "schema" | "object" | "off";

export function parseJsonMode(raw: string | undefined): JsonMode {
  const v = (raw || "").trim().toLowerCase();
  return v === "object" || v === "off" ? v : "schema";
}

export function openAiModel(
  apiKey: string,
  modelId?: string,
  baseUrl?: string,
  jsonMode: JsonMode = "schema",
): ChatModel {
  const model = modelId || DEFAULT_MODEL;
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const isOpenRouter = base.includes("openrouter.ai");

  return {
    name: `${isOpenRouter ? "openrouter" : "openai"}:${model}`,
    async complete(messages: ChatMessage[], opts: CompleteOptions = {}) {
      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? 4096,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      };

      if (opts.jsonSchema && jsonMode === "schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "response", strict: false, schema: opts.jsonSchema },
        };
      } else if (opts.jsonSchema && jsonMode === "object") {
        body.response_format = { type: "json_object" };
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };
      // OpenRouter uses these for usage attribution in its dashboard.
      if (isOpenRouter) {
        headers["HTTP-Referer"] = "https://github.com/Henry-fan88/x-post-agent";
        headers["X-Title"] = "x-post-agent";
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        // A model that rejects response_format is the most common cause here;
        // name the fix rather than making the user guess.
        const hint =
          body.response_format && (res.status === 400 || res.status === 404)
            ? ' -- if this model does not support structured outputs, set MODEL_JSON_MODE to "object" or "off".'
            : "";
        throw new ModelError(`${this.name} ${res.status}: ${detail}${hint}`, res.status);
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      // Gateways sometimes return errors with a 200 status.
      if (json.error?.message) throw new ModelError(`${this.name}: ${json.error.message}`);

      return (json.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}
