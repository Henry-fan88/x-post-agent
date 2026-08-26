/**
 * Provider selection. MODEL_PROVIDER (a plain var) picks the adapter;
 * MODEL_API_KEY (a secret) supplies the credential.
 *
 * Falls back to the mock provider rather than throwing, so a deployment with
 * no key configured still serves a working UI instead of a 500.
 */

import type { ResolvedConfig } from "../config/settings";
import { anthropicModel } from "./anthropic";
import { mockModel } from "./mock";
import { openAiModel, parseJsonMode } from "./openai";
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

export function createModel(cfg: ResolvedConfig): ModelSelection {
  const provider = cfg.modelProvider;
  const key = cfg.modelApiKey.trim();
  const modelId = cfg.modelId.trim() || undefined;

  switch (provider) {
    case "anthropic":
      if (!key) return unconfigured("Provider is anthropic but no API key is set.");
      return { model: anthropicModel(key, modelId), configured: true };

    case "openai":
      if (!key) return unconfigured("Provider is openai-compatible but no API key is set.");
      return {
        model: openAiModel(
          key,
          modelId,
          cfg.modelBaseUrl.trim() || undefined,
          parseJsonMode(cfg.modelJsonMode),
        ),
        configured: true,
      };

    case "workers-ai":
      if (!cfg.ai) {
        return unconfigured('Provider is workers-ai but the "ai" binding is not enabled in wrangler.jsonc.');
      }
      return { model: workersAiModel(cfg.ai, modelId), configured: true };

    case "mock":
      return { model: mockModel(), configured: false, note: "Using the built-in mock provider." };

    default:
      return unconfigured(`Unknown provider "${provider}".`);
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
