import type { ArtifactRef, GateResult, RunStatus, TaskContext } from "../core/types.js";

export const MEMORY_SCOPES = ["working", "episodic", "project", "semantic"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface RecallOptions {
  readonly scopes?: readonly MemoryScope[];
  readonly statuses?: readonly RunStatus[];
  readonly limit?: number;
}

export interface Retrieval {
  readonly content: string;
  readonly source: string;
  readonly score: number;
  readonly scope: MemoryScope;
  readonly reason: string;
}

export interface MemoryProvider {
  remember(ctx: TaskContext, artifact: ArtifactRef): Promise<void>;
  rememberGate?(ctx: TaskContext, gate: GateResult): Promise<void>;
  recall(query: string, options?: RecallOptions): Promise<readonly Retrieval[]>;
}
