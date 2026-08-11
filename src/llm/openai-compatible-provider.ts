import { StageFailure } from "../core/errors.js";
import type { ChatCompletion, ChatMessage, ChatOptions, ChatProvider } from "./chat-provider.js";

interface ProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  public constructor(options: ProviderOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new StageFailure("An API key is required");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  public async complete(
    messages: readonly ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatCompletion> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          temperature: options.temperature,
          max_tokens: options.maxOutputTokens,
          ...(options.seed === undefined ? {} : { seed: options.seed }),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new StageFailure("LLM request failed", { cause: error });
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new StageFailure(`LLM request returned HTTP ${response.status}: ${detail}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new StageFailure("LLM response did not include message content");
    }
    return {
      content,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}
