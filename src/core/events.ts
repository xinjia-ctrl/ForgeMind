import type { RunStatus, StageId, StageStatus } from "./types.js";

export interface EventDataMap {
  readonly "run.started": {
    readonly runId: string;
    readonly requirement: string;
    readonly branch: string;
  };
  readonly "stage.started": {
    readonly runId: string;
    readonly stage: StageId;
    readonly attempt: number;
  };
  readonly "llm.called": {
    readonly runId: string;
    readonly stage: StageId;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly promptFingerprint: string;
  };
  readonly "tool.called": {
    readonly runId: string;
    readonly stage: StageId;
    readonly tool: string;
    readonly args: unknown;
    readonly result: unknown;
    readonly policy: string;
  };
  readonly "artifact.produced": {
    readonly runId: string;
    readonly stage: StageId;
    readonly path: string;
    readonly kind: string;
    readonly summary: string;
  };
  readonly "gate.rejected": {
    readonly runId: string;
    readonly stage: "REVIEW" | "TEST";
    readonly reason: string;
    readonly feedback: string;
  };
  readonly "gate.passed": {
    readonly runId: string;
    readonly stage: "REVIEW" | "TEST";
    readonly evidence: string;
  };
  readonly "stage.completed": {
    readonly runId: string;
    readonly stage: StageId;
    readonly status: StageStatus;
  };
  readonly "stage.failed": {
    readonly runId: string;
    readonly stage: StageId;
    readonly kind?: "STAGE" | "HARD" | "FATAL";
    readonly error: string;
    readonly stack?: string;
  };
  readonly "run.finished": {
    readonly runId: string;
    readonly status: RunStatus;
    readonly summary: string;
  };
}

export type EventType = keyof EventDataMap;

export type EventInput = {
  readonly [K in EventType]: {
    readonly type: K;
    readonly data: EventDataMap[K];
  };
}[EventType];

export type ForgeMindEvent = {
  readonly [K in EventType]: {
    readonly v: 1;
    readonly seq: number;
    readonly ts: string;
    readonly type: K;
    readonly data: EventDataMap[K];
  };
}[EventType];
