import type { ArtifactRef, TaskContext } from "../core/types.js";

export interface Retrieval {
  readonly content: string;
  readonly source: string;
  readonly score: number;
}

export interface MemoryProvider {
  remember(ctx: TaskContext, artifact: ArtifactRef): Promise<void>;
  recall(query: string): Promise<readonly Retrieval[]>;
}
