import { CancellationFailure, StageFailure, throwIfCancelled } from "../core/errors.js";
import type { ChatCompletion, ChatMessage, ChatOptions, ChatProvider } from "./chat-provider.js";

interface ProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly retryAttempts?: number;
  readonly retryDelayMs?: number;
  readonly structuredOutput?: boolean;
  readonly temperatureOverride?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEEPSEEK_TIMEOUT_MS = 660_000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;

export class OpenAICompatibleChatProvider implements ChatProvider {
  #structuredOutputSupported: boolean;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retryAttempts: number;
  readonly #retryDelayMs: number;
  readonly #temperatureOverride: number | undefined;

  public constructor(options: ProviderOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new StageFailure("An API key is required");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs(this.#baseUrl);
    this.#retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#structuredOutputSupported = options.structuredOutput ?? true;
    if (
      !Number.isInteger(this.#retryAttempts) ||
      this.#retryAttempts < 0 ||
      this.#retryAttempts > 5
    ) {
      throw new StageFailure("Retry attempts must be an integer between 0 and 5");
    }
    if (!Number.isFinite(this.#retryDelayMs) || this.#retryDelayMs < 0) {
      throw new StageFailure("Retry delay must be a non-negative number");
    }
    if (
      options.temperatureOverride !== undefined &&
      (!Number.isFinite(options.temperatureOverride) ||
        options.temperatureOverride < 0 ||
        options.temperatureOverride > 2)
    ) {
      throw new StageFailure("Temperature override must be between 0 and 2");
    }
    this.#temperatureOverride = options.temperatureOverride;
  }

  public get supportsStructuredOutput(): boolean {
    return this.#structuredOutputSupported;
  }

  public get providerId(): string {
    return `openai-compatible:${this.#baseUrl}`;
  }

  public async complete(
    messages: readonly ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatCompletion> {
    const deepSeek = usesDeepSeekCompatibility(this.#baseUrl);
    const bigModelGlm = usesBigModelGlmCompatibility(this.#baseUrl, options.model);
    const disableThinking = deepSeek || bigModelGlm;
    const usesJsonObject = disableThinking || usesDashScopeJsonObject(this.#baseUrl, options.model);
    const requestBody = JSON.stringify({
      model: options.model,
      messages,
      temperature: this.#temperatureOverride ?? options.temperature,
      max_tokens: options.maxOutputTokens,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
      ...(options.structuredOutput === undefined
        ? {}
        : {
            response_format: usesJsonObject
              ? { type: "json_object" }
              : {
                  type: "json_schema",
                  json_schema: {
                    name: options.structuredOutput.name,
                    strict: true,
                    schema: options.structuredOutput.jsonSchema,
                  },
                },
          }),
    });
    const maximumAttempts = this.#retryAttempts + 1;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      throwIfCancelled(options.signal);
      let response: Response;
      try {
        response = await fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: requestBody,
          signal:
            options.signal === undefined
              ? AbortSignal.timeout(this.#timeoutMs)
              : AbortSignal.any([options.signal, AbortSignal.timeout(this.#timeoutMs)]),
        });
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw new CancellationFailure("LLM request cancelled", { cause: error });
        }
        if (attempt < maximumAttempts) {
          await retryDelay(this.#retryDelayMs, attempt, undefined, options.signal);
          continue;
        }
        throw new StageFailure(
          `LLM request failed after ${attempt} attempts: ${errorDetail(error)}`,
          { cause: error },
        );
      }

      const detail = await response.text();
      const body = tryParseResponseBody(detail);
      if (!response.ok) {
        if (response.status === 400 && options.structuredOutput !== undefined) {
          this.#structuredOutputSupported = false;
          const fallback = completionFromBody(body);
          if (fallback !== null) return fallback;
        }
        if (attempt < maximumAttempts && isRetryableStatus(response.status)) {
          await retryDelay(
            this.#retryDelayMs,
            attempt,
            response.headers.get("retry-after"),
            options.signal,
          );
          continue;
        }
        throw new StageFailure(
          `LLM request returned HTTP ${response.status} after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${detail.slice(0, 1_000)}`,
        );
      }

      if (body === null) throw new StageFailure("LLM response was not valid JSON");
      const finishReason = body.choices?.[0]?.finish_reason;
      if (finishReason === "insufficient_system_resource" && attempt < maximumAttempts) {
        await retryDelay(this.#retryDelayMs, attempt, undefined, options.signal);
        continue;
      }
      if (finishReason === "insufficient_system_resource") {
        throw new StageFailure(
          `LLM provider reported insufficient system resources after ${attempt} attempts`,
        );
      }
      if (finishReason === "length") {
        throw new StageFailure("LLM response was truncated at the maximum output token limit");
      }
      const completion = completionFromBody(body);
      if (completion === null) {
        throw new StageFailure("LLM response did not include message content");
      }
      return completion;
    }
    throw new StageFailure("LLM request exhausted its retry budget");
  }
}

interface ResponseBody {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function usesDeepSeekCompatibility(baseUrl: string): boolean {
  try {
    const endpoint = new URL(baseUrl);
    return endpoint.protocol === "https:" && endpoint.hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

function defaultTimeoutMs(baseUrl: string): number {
  try {
    return new URL(baseUrl).hostname === "api.deepseek.com"
      ? DEEPSEEK_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS;
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function retryDelay(
  baseDelayMs: number,
  attempt: number,
  retryAfter?: string | null,
  signal?: AbortSignal,
) {
  const requested = retryAfterMs(retryAfter);
  const delayMs = Math.min(
    MAX_RETRY_AFTER_MS,
    requested ?? baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new CancellationFailure("LLM retry cancelled", { cause: signal?.reason }));
    };
    signal?.addEventListener("abort", abort, { once: true });
    function done(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted === true) abort();
  });
}

function retryAfterMs(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.name}: ${error.message}`;
}

function usesBigModelGlmCompatibility(baseUrl: string, model: string): boolean {
  try {
    const endpoint = new URL(baseUrl);
    return (
      endpoint.protocol === "https:" &&
      endpoint.hostname === "open.bigmodel.cn" &&
      /^glm-(?:4\.[5-9]|[5-9](?:\.\d+)?)(?:-|$)/i.test(model)
    );
  } catch {
    return false;
  }
}

function usesDashScopeJsonObject(baseUrl: string, model: string): boolean {
  try {
    const endpoint = new URL(baseUrl);
    return (
      endpoint.protocol === "https:" &&
      (endpoint.hostname === "dashscope.aliyuncs.com" ||
        endpoint.hostname.endsWith(".maas.aliyuncs.com")) &&
      /^qwen/i.test(model)
    );
  } catch {
    return false;
  }
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
