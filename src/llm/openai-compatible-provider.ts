import { StageFailure } from "../core/errors.js";
import type { ChatCompletion, ChatMessage, ChatOptions, ChatProvider } from "./chat-provider.js";

interface ProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly structuredOutput?: boolean;
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  #structuredOutputSupported: boolean;
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
    this.#structuredOutputSupported = options.structuredOutput ?? true;
  }

  public get supportsStructuredOutput(): boolean {
    return this.#structuredOutputSupported;
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
          ...(options.structuredOutput === undefined
            ? {}
            : {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: options.structuredOutput.name,
                    strict: true,
                    schema: options.structuredOutput.jsonSchema,
                  },
                },
              }),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new StageFailure("LLM request failed", { cause: error });
    }

    const detail = await response.text();
    const body = tryParseResponseBody(detail);
    if (!response.ok) {
      if (response.status === 400 && options.structuredOutput !== undefined) {
        this.#structuredOutputSupported = false;
        const fallback = completionFromBody(body);
        if (fallback !== null) return fallback;
      }
      throw new StageFailure(
        `LLM request returned HTTP ${response.status}: ${detail.slice(0, 1_000)}`,
      );
    }

    if (body === null) throw new StageFailure("LLM response was not valid JSON");
    const completion = completionFromBody(body);
    if (completion === null) {
      throw new StageFailure("LLM response did not include message content");
    }
    return completion;
  }
}

interface ResponseBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function tryParseResponseBody(content: string): ResponseBody | null {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return null;
  }
}

function completionFromBody(body: ResponseBody | null): ChatCompletion | null {
  if (body === null) return null;
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  return {
    content,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
  };
}
