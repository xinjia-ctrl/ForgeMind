import type { ArtifactRef, GateResult, TaskContext } from "../core/types.js";
import {
  MEMORY_SCOPES,
  type MemoryProvider,
  type MemoryScope,
  type RecallOptions,
  type Retrieval,
} from "./memory-provider.js";

export interface LayeredMemoryOptions {
  readonly layers?: Partial<Readonly<Record<MemoryScope, MemoryProvider | null>>>;
  readonly defaultLimit?: number;
}

export class LayeredMemory implements MemoryProvider {
  readonly #layers: Partial<Readonly<Record<MemoryScope, MemoryProvider | null>>>;
  readonly #defaultLimit: number;

  public constructor(options: LayeredMemoryOptions = {}) {
    this.#layers = options.layers ?? {};
    this.#defaultLimit = options.defaultLimit ?? 8;
  }

  public async remember(ctx: TaskContext, artifact: ArtifactRef): Promise<void> {
    await Promise.all(this.providers().map((provider) => provider.remember(ctx, artifact)));
  }

  public async rememberGate(ctx: TaskContext, gate: GateResult): Promise<void> {
    await Promise.all(
      this.providers().map((provider) => provider.rememberGate?.(ctx, gate) ?? Promise.resolve()),
    );
  }

  public async recall(query: string, options: RecallOptions = {}): Promise<readonly Retrieval[]> {
    const scopes = options.scopes ?? MEMORY_SCOPES;
    const results = await Promise.all(
      scopes.map(async (scope) => {
        const provider = this.#layers[scope];
        if (provider === undefined || provider === null) return [];
        return await provider.recall(query, { ...options, scopes: [scope] });
      }),
    );
    const limit = options.limit ?? this.#defaultLimit;
    return results
      .flat()
      .filter((item) => scopes.includes(item.scope))
      .sort((left, right) => right.score - left.score || left.source.localeCompare(right.source))
      .slice(0, limit);
  }

  private providers(): readonly MemoryProvider[] {
    return [
      ...new Set(
        MEMORY_SCOPES.flatMap((scope) => {
          const provider = this.#layers[scope];
          return provider === undefined || provider === null ? [] : [provider];
        }),
      ),
    ];
  }
}
