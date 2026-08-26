/**
 * Anthropic Messages API adapter.
 *
 * Raw fetch rather than @anthropic-ai/sdk: this app is provider-neutral by
 * design (the provider is a runtime env var), so pulling in one vendor's SDK
 * would be the wrong dependency. If you settle on Anthropic permanently,
 * swapping this file for the SDK is a contained change.
 */

import { type ChatMessage, type ChatModel, type CompleteOptions, ModelError, splitSystem } from "./types";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-5";

export function anthropicModel(apiKey: string, modelId?: string): ChatModel {
  const model = modelId || DEFAULT_MODEL;

  return {
    name: `anthropic:${model}`,
    async complete(messages: ChatMessage[], opts: CompleteOptions = {}) {
      const { system, rest } = splitSystem(messages);

      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? 4096,
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
      };
      if (system) body.system = system;
      // Structured outputs. Note there is no `temperature` here on purpose:
      // current Claude models reject sampling parameters with a 400.
      if (opts.jsonSchema) {
        body.output_config = {
          format: { type: "json_schema", schema: opts.jsonSchema },
        };
      }

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new ModelError(
          `Anthropic ${res.status}: ${(await res.text()).slice(0, 500)}`,
          res.status,
        );
      }

      const json = (await res.json()) as {
        content?: { type: string; text?: string }[];
        stop_reason?: string;
      };

      if (json.stop_reason === "refusal") {
        throw new ModelError("The model declined this request.");
      }

      return (json.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string)
        .join("")
        .trim();
    },
  };
}
