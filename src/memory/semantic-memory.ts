import path from "node:path";
import { HardFailure } from "../core/errors.js";
import type { ArtifactRef, TaskContext } from "../core/types.js";
import type { MemoryProvider, RecallOptions, Retrieval } from "./memory-provider.js";
import {
  PROJECT_MEMORY_FILES,
  type ProjectMemoryEntry,
  type ProjectMemoryFile,
  readProjectMemoryDocument,
} from "./project-memory-document.js";

const DEFAULT_DIMENSION = 512;
const DEFAULT_MAX_DOCUMENTS = 10_000;
const EMBEDDING_CONCURRENCY = 8;
const MAX_DIMENSION = 65_536;
const MAX_INDEXED_TEXT_LENGTH = 100_000;
const VECTOR_ONLY_THRESHOLD = 0.2;

export interface EmbeddingProvider {
  readonly dimension: number;
  embed(text: string): Promise<readonly number[]>;
}

export interface LexicalEmbeddingProviderOptions {
  readonly dimension?: number;
}

export interface SemanticMemoryOptions {
  /** Repository roots are an explicit authorization boundary for cross-project recall. */
  readonly repositoryRoots: readonly string[];
  readonly embeddingProvider?: EmbeddingProvider;
  readonly maxDocuments?: number;
}

/**
 * A deterministic, dependency-free hashed term-frequency embedding. Corpus IDF is
 * applied by SemanticMemory's BM25 scorer, so provider embeddings stay stateless.
 */
export class LexicalEmbeddingProvider implements EmbeddingProvider {
  public readonly dimension: number;

  public constructor(options: LexicalEmbeddingProviderOptions = {}) {
    this.dimension = boundedPositiveInteger(
      options.dimension ?? DEFAULT_DIMENSION,
      "lexical embedding dimension",
      MAX_DIMENSION,
    );
  }

  public embed(text: string): Promise<readonly number[]> {
    const counts = termCounts(semanticTerms(text));
    const vector = Array<number>(this.dimension).fill(0);
    for (const [term, count] of counts) {
      const index = stableHash(term, 0) % this.dimension;
      const sign = (stableHash(term, 0x9e3779b9) & 1) === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(count));
    }
    return Promise.resolve(normalize(vector));
  }
}

export class SemanticMemory implements MemoryProvider {
  readonly #repositoryRoots: readonly string[];
  readonly #embeddingProvider: EmbeddingProvider;
  readonly #dimension: number;
  readonly #maxDocuments: number;
  readonly #embeddingCache = new Map<string, readonly number[]>();

  public constructor(options: SemanticMemoryOptions) {
    if (options.repositoryRoots.length === 0) {
      throw new Error("SemanticMemory requires at least one repository root");
    }
    const roots = options.repositoryRoots.map((root) => {
      if (root.trim().length === 0)
        throw new Error("SemanticMemory repository roots cannot be empty");
      return path.resolve(root);
    });
    this.#repositoryRoots = [...new Set(roots)];
    this.#embeddingProvider = options.embeddingProvider ?? new LexicalEmbeddingProvider();
    this.#dimension = boundedPositiveInteger(
      this.#embeddingProvider.dimension,
      "embedding provider dimension",
      MAX_DIMENSION,
    );
    this.#maxDocuments = boundedPositiveInteger(
      options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS,
      "semantic memory maxDocuments",
      Number.MAX_SAFE_INTEGER,
    );
  }

  public remember(_ctx: TaskContext, _artifact: ArtifactRef): Promise<void> {
    return Promise.resolve();
  }

  public async recall(query: string, options: RecallOptions = {}): Promise<readonly Retrieval[]> {
    if (options.scopes !== undefined && !options.scopes.includes("semantic")) return [];
    const queryTerms = semanticTerms(query);
    if (queryTerms.length === 0) return [];
    const documents = await this.readCorpus();
    if (documents.length === 0) return [];
    this.pruneEmbeddingCache(documents);

    const limit = options.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("semantic memory recall limit must be a non-negative integer");
    }
    if (limit === 0) return [];

    const documentTerms = documents.map((document) => semanticTerms(document.searchText));
    const uniqueQueryTerms = [...new Set(queryTerms)];
    const documentFrequency = frequencies(uniqueQueryTerms, documentTerms);
    const averageDocumentLength =
      documentTerms.reduce((total, terms) => total + terms.length, 0) / documents.length;
    const queryVector = await this.embedQuery(query);
    const documentVectors = await mapConcurrent(
      documents,
      EMBEDDING_CONCURRENCY,
      async (document) => await this.embed(document.searchText, document.cacheKey),
    );
    const lexicalOnly = this.#embeddingProvider instanceof LexicalEmbeddingProvider;

    return documents
      .map((document, index): Retrieval | null => {
        const terms = documentTerms[index];
        const vector = documentVectors[index];
        if (terms === undefined || vector === undefined) return null;
        const bm25 = bm25Score(
          uniqueQueryTerms,
          terms,
          documentFrequency,
          documents.length,
          averageDocumentLength,
        );
        const cosine = Math.max(0, cosineSimilarity(queryVector, vector));
        if (bm25 === 0 && (lexicalOnly || cosine < VECTOR_ONLY_THRESHOLD)) return null;
        const lexicalScore = bm25 / (bm25 + 1);
        const score = roundScore(lexicalScore * 0.6 + cosine * 0.4);
        const matches = uniqueQueryTerms.filter((term) => terms.includes(term));
        return {
          content: document.entry.content,
          source: document.source,
          score,
          scope: "semantic",
          reason: `BM25=${roundScore(bm25)}; cosine=${roundScore(cosine)}; terms=${matches.join(", ") || "vector-only"}`,
        };
      })
      .filter((retrieval): retrieval is Retrieval => retrieval !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.source.localeCompare(right.source) ||
          left.content.localeCompare(right.content),
      )
      .slice(0, limit);
  }

  private async readCorpus(): Promise<readonly SemanticDocument[]> {
    const roots = this.#repositoryRoots;
    const sources = await Promise.all(
      roots.flatMap((repositoryRoot, rootIndex) =>
        PROJECT_MEMORY_FILES.map(async (file) => ({
          file,
          repositoryRoot,
          rootIndex,
          document: await readProjectMemoryDocument(
            path.join(repositoryRoot, ".forgemind", "memory"),
            file,
          ),
        })),
      ),
    );
    const documents = sources
      .flatMap(({ document, file, repositoryRoot, rootIndex }) =>
        document.entries.map((entry) =>
          semanticDocument(entry, file, repositoryRoot, rootIndex, roots.length),
        ),
      )
      .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
    if (documents.length > this.#maxDocuments) {
      throw new HardFailure(
        `Semantic memory corpus contains ${documents.length} documents; limit is ${this.#maxDocuments}`,
      );
    }
    return documents;
  }

  private async embed(text: string, cacheKey: string): Promise<readonly number[]> {
    const cached = this.#embeddingCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const embedded = await this.#embeddingProvider.embed(text.slice(0, MAX_INDEXED_TEXT_LENGTH));
    const vector = validateVector(embedded, this.#dimension, cacheKey);
    this.#embeddingCache.set(cacheKey, vector);
    return vector;
  }

  private async embedQuery(query: string): Promise<readonly number[]> {
    const embedded = await this.#embeddingProvider.embed(query.slice(0, MAX_INDEXED_TEXT_LENGTH));
    return validateVector(embedded, this.#dimension, "query");
  }

  private pruneEmbeddingCache(documents: readonly SemanticDocument[]): void {
    const activeKeys = new Set(documents.map((document) => document.cacheKey));
    for (const cacheKey of this.#embeddingCache.keys()) {
      if (!activeKeys.has(cacheKey)) this.#embeddingCache.delete(cacheKey);
    }
  }
}

interface SemanticDocument {
  readonly entry: ProjectMemoryEntry;
  readonly source: string;
  readonly searchText: string;
  readonly cacheKey: string;
}

function semanticDocument(
  entry: ProjectMemoryEntry,
  file: ProjectMemoryFile,
  repositoryRoot: string,
  rootIndex: number,
  rootCount: number,
): SemanticDocument {
  const searchText = `${entry.tags.join(" ")} ${entry.content}`;
  const memoryPath = path.join(".forgemind", "memory", file);
  const sourcePrefix =
    rootCount === 1
      ? ""
      : `${path.basename(repositoryRoot)}-${stableHash(repositoryRoot, rootIndex).toString(16)}`;
  const source = `${sourcePrefix.length === 0 ? memoryPath : path.join(sourcePrefix, memoryPath)}#${entry.id.slice(0, 12)}`;
  return {
    entry,
    source,
    searchText,
    cacheKey: `${repositoryRoot}\0${file}\0${entry.id}\0${stableHash(searchText, 0)}`,
  };
}

function semanticTerms(text: string): readonly string[] {
  const symbols = text
    .normalize("NFKC")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return (symbols.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(normalizeTerm)
    .filter((term) => term.length > 1);
}

function normalizeTerm(term: string): string {
  if (!/^[a-z]+$/.test(term)) return term;
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(sses|shes|ches|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (
    term.length > 3 &&
    term.endsWith("s") &&
    !term.endsWith("ss") &&
    !term.endsWith("us") &&
    !term.endsWith("is")
  ) {
    return term.slice(0, -1);
  }
  return term;
}

function frequencies(
  queryTerms: readonly string[],
  documents: readonly (readonly string[])[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const term of queryTerms) {
    result.set(
      term,
      documents.reduce((count, document) => count + (document.includes(term) ? 1 : 0), 0),
    );
  }
  return result;
}

function bm25Score(
  queryTerms: readonly string[],
  documentTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  averageDocumentLength: number,
): number {
  const counts = termCounts(documentTerms);
  const k1 = 1.2;
  const b = 0.75;
  return queryTerms.reduce((score, term) => {
    const termFrequency = counts.get(term) ?? 0;
    if (termFrequency === 0) return score;
    const frequency = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5));
    const lengthRatio =
      averageDocumentLength === 0 ? 1 : documentTerms.length / averageDocumentLength;
    const saturation =
      (termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + b * lengthRatio));
    return score + idf * saturation;
  }, 0);
}

function termCounts(terms: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function normalize(vector: readonly number[]): readonly number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function validateVector(value: unknown, dimension: number, source: string): readonly number[] {
  if (!isFiniteNumberArray(value) || value.length !== dimension) {
    throw new HardFailure(
      `EmbeddingProvider returned an invalid ${source === "query" ? "query" : "document"} vector; expected ${dimension} finite values`,
    );
  }
  return Object.freeze([...value]);
}

function isFiniteNumberArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "number" && Number.isFinite(item))
  );
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function stableHash(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  transform: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await transform(value);
    }
  });
  await Promise.all(workers);
  return results;
}
