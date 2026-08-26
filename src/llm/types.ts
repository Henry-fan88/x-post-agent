/** Provider-neutral chat model interface. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  /** Pipeline stage this call belongs to. Used for logging and by the mock provider. */
  task?: string;
  maxTokens?: number;
  /**
   * When set, the provider is asked to return JSON matching this schema.
   * Providers that can enforce it natively do; the rest fall back to
   * prompt-level instruction plus tolerant parsing in `parseJson`.
   */
  jsonSchema?: Record<string, unknown>;
}

export interface ChatModel {
  /** Human-readable "provider:model", surfaced in /api/config. */
  readonly name: string;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/** Splits a message list into an Anthropic-style (system, rest) pair. */
export function splitSystem(messages: ChatMessage[]): {
  system: string;
  rest: ChatMessage[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  return { system, rest: messages.filter((m) => m.role !== "system") };
}
