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
  /** The provider's HTTP status, when the failure came back as one. */
  readonly status?: number;

  // Written out rather than as a constructor parameter property: those are the
  // one TypeScript feature that cannot be compiled away by deleting types, so
  // they break every strip-only runtime -- including the one the eval runs on.
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelError";
    this.status = status;
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
