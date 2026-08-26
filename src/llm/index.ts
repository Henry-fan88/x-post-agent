/**
 * Provider selection. MODEL_PROVIDER (a plain var) picks the adapter;
 * MODEL_API_KEY (a secret) supplies the credential.
 *
 * Falls back to the mock provider rather than throwing, so a deployment with
 * no key configured still serves a working UI instead of a 500.
 */

import { anthropicModel } from "./anthropic";
import { mockModel } from "./mock";
import { openAiModel } from "./openai";
import type { ChatModel } from "./types";
import { workersAiModel } from "./workers-ai";

export type { ChatMessage, ChatModel, CompleteOptions } from "./types";
export { ModelError } from "./types";

export interface ModelSelection {
  model: ChatModel;
  /** True when a real provider is wired up. Surfaced in the UI. */
  configured: boolean;
  note?: string;
}

export function createModel(env: Env): ModelSelection {
  const provider = (env.MODEL_PROVIDER || "mock").toLowerCase();
  const key = env.MODEL_API_KEY?.trim();
  const modelId = env.MODEL_ID?.trim() || undefined;

  switch (provider) {
    case "anthropic":
      if (!key) return unconfigured("MODEL_PROVIDER is anthropic but MODEL_API_KEY is not set.");
      return { model: anthropicModel(key, modelId), configured: true };

    case "openai":
      if (!key) return unconfigured("MODEL_PROVIDER is openai but MODEL_API_KEY is not set.");
      return {
        model: openAiModel(key, modelId, env.MODEL_BASE_URL?.trim() || undefined),
        configured: true,
      };

    case "workers-ai":
      if (!env.AI) {
        return unconfigured('MODEL_PROVIDER is workers-ai but the "ai" binding is not enabled in wrangler.jsonc.');
      }
      return { model: workersAiModel(env.AI, modelId), configured: true };

    case "mock":
      return { model: mockModel(), configured: false, note: "Using the built-in mock provider." };

    default:
      return unconfigured(`Unknown MODEL_PROVIDER "${provider}".`);
  }
}

function unconfigured(note: string): ModelSelection {
  return { model: mockModel(), configured: false, note: `${note} Falling back to the mock provider.` };
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences often enough that this is worth doing
 * properly rather than trusting JSON.parse on the raw string.
 */
export function parseJson<T>(raw: string): T | null {
  const attempts: string[] = [];
  const trimmed = raw.trim();
  attempts.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next shape
    }
  }
  return null;
}
