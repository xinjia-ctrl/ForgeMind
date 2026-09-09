export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatOptions {
  readonly model: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly seed?: number;
  readonly structuredOutput?: {
    readonly name: string;
    readonly jsonSchema: Readonly<Record<string, unknown>>;
  };
  readonly signal?: AbortSignal;
}

export interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ChatCompletion {
  readonly content: string;
  readonly usage: ChatUsage;
}

export interface ChatProvider {
  readonly supportsStructuredOutput?: boolean;
  /** Stable, non-secret runtime identity used by recovery manifests. */
  readonly providerId?: string;
  complete(messages: readonly ChatMessage[], options: ChatOptions): Promise<ChatCompletion>;
}
