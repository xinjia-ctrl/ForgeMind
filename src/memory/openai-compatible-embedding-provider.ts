import { HardFailure, StageFailure } from "../core/errors.js";
import type { EmbeddingProvider } from "./semantic-memory.js";

const MAX_DIMENSION = 65_536;

export interface OpenAICompatibleEmbeddingProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly dimension: number;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/** External `/embeddings` adapter with a fixed, validated vector contract. */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  public readonly dimension: number;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  public constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new HardFailure("An embedding API key is required");
    }
    if (options.model.trim().length === 0) {
      throw new HardFailure("An embedding model is required");
    }
    if (
      !Number.isInteger(options.dimension) ||
      options.dimension <= 0 ||
      options.dimension > MAX_DIMENSION
    ) {
      throw new HardFailure(
        `Embedding dimension must be an integer between 1 and ${MAX_DIMENSION}`,
      );
    }
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new HardFailure("Embedding timeoutMs must be a positive integer");
    }
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.dimension = options.dimension;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.#timeoutMs = timeoutMs;
  }

  public async embed(text: string): Promise<readonly number[]> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.#model, input: text, encoding_format: "float" }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new StageFailure("Embedding request failed", { cause: error });
    }

    const detail = await response.text();
    if (!response.ok) {
      throw new StageFailure(
        `Embedding request returned HTTP ${response.status}: ${detail.slice(0, 1_000)}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(detail) as unknown;
    } catch (error) {
      throw new StageFailure("Embedding response was not valid JSON", { cause: error });
    }
    const vector = embeddingFrom(body);
    if (
      vector === null ||
      vector.length !== this.dimension ||
      !vector.every((value) => Number.isFinite(value))
    ) {
      throw new StageFailure(`Embedding response did not include ${this.dimension} finite values`);
    }
    return Object.freeze([...vector]);
  }
}

function embeddingFrom(value: unknown): readonly number[] | null {
  if (typeof value !== "object" || value === null || !("data" in value)) return null;
  const data = value.data;
  if (!Array.isArray(data)) return null;
  const first: unknown = data[0];
  if (typeof first !== "object" || first === null || !("embedding" in first)) return null;
  const embedding = first.embedding;
  if (!Array.isArray(embedding) || !embedding.every((entry) => typeof entry === "number")) {
    return null;
  }
  return embedding;
}
