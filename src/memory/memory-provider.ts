import type { ArtifactRef, GateResult, RunStatus, TaskContext } from "../core/types.js";
import type { DecisionRecord } from "../negotiation/types.js";
import type { RunQualityMetrics } from "../quality/types.js";

export const MEMORY_SCOPES = ["working", "episodic", "project", "semantic"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface RecallOptions {
  readonly scopes?: readonly MemoryScope[];
  readonly statuses?: readonly RunStatus[];
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface Retrieval {
  readonly entryId: string;
  readonly content: string;
  readonly source: string;
  readonly timestamp: string;
  readonly confidence: number;
  readonly score: number;
  readonly scope: MemoryScope;
  readonly reason: string;
}

export interface MemoryProvider {
  remember(ctx: TaskContext, artifact: ArtifactRef): Promise<void>;
  rememberGate?(ctx: TaskContext, gate: GateResult): Promise<void>;
  rememberDecisionRecord?(record: DecisionRecord): Promise<void>;
  rememberQuality?(quality: RunQualityMetrics): Promise<void>;
  recall(query: string, options?: RecallOptions): Promise<readonly Retrieval[]>;
}
