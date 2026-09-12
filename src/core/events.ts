import type { RiskLevel } from "../policy/types.js";
import type { VerificationStrength } from "../quality/types.js";
import type { RunStatus, StageId, StageStatus } from "./types.js";

interface ApprovalIndex {
  readonly risk?: RiskLevel;
}

interface EventPayloadMap {
  readonly "run.started": {
    readonly runId: string;
    readonly requirement: string;
    readonly branch: string;
    readonly repo?: string;
    readonly profile?: "light" | "standard";
    readonly profileReason?: string;
  };
  readonly "run.resumed": {
    readonly runId: string;
    readonly phase: StageId;
    readonly attempt: number;
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
    readonly promptVersion?: string;
    readonly structuredOutput?: boolean;
  };
  readonly "context.assembled": {
    readonly runId: string;
    readonly stage: StageId;
    readonly sections: readonly {
      readonly name: string;
      readonly source: string;
      readonly trust?: "trusted" | "untrusted";
      readonly tokenEstimate: number;
      readonly references: readonly string[];
    }[];
    readonly tokenEstimate: number;
  };
  readonly "tool.called": {
    readonly runId: string;
    readonly stage: StageId;
    readonly tool: string;
    readonly args: unknown;
    readonly result: unknown;
    readonly policy: string;
  };
  readonly "approval.requested": {
    readonly runId: string;
    readonly stage: StageId;
    readonly tool: string;
    readonly action: unknown;
    readonly policy: string;
    readonly mode: "approve";
  } & ApprovalIndex;
  readonly "approval.approved": {
    readonly runId: string;
    readonly stage: StageId;
    readonly tool: string;
    readonly action: unknown;
    readonly policy: string;
    readonly mode: "approve";
    readonly decisionSource: "interactive" | "auto";
  } & ApprovalIndex;
  readonly "approval.rejected": {
    readonly runId: string;
    readonly stage: StageId;
    readonly tool: string;
    readonly action: unknown;
    readonly policy: string;
    readonly mode: "approve" | "deny";
    readonly reason: string;
    readonly decisionSource: "interactive" | "auto" | "disabled" | "policy";
  } & ApprovalIndex;
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
    readonly coveragePercent?: number;
    readonly artifactFingerprint: string;
    readonly verificationEvidence: readonly {
      readonly criterionId: string;
      readonly verifierKind: "test-suite" | "test-case" | "file" | "behavior" | "review";
      readonly source: string;
      readonly artifactFingerprint: string;
      readonly passed: boolean;
      readonly details: string;
    }[];
  };
  readonly "gate.passed": {
    readonly runId: string;
    readonly stage: "REVIEW" | "TEST";
    readonly evidence: string;
    readonly coveragePercent?: number;
    readonly artifactFingerprint: string;
    readonly verificationEvidence: readonly {
      readonly criterionId: string;
      readonly verifierKind: "test-suite" | "test-case" | "file" | "behavior" | "review";
      readonly source: string;
      readonly artifactFingerprint: string;
      readonly passed: boolean;
      readonly details: string;
    }[];
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
  readonly "run.quality": {
    readonly runId: string;
    readonly requirement: string;
    readonly outcome: "succeeded" | "failed";
    readonly evidenceCompleteness: number;
    readonly verificationStrength: VerificationStrength;
    readonly coveragePercent: number | null;
    readonly reworkRounds: number;
    readonly policyViolations: number;
    readonly confidence: number;
  };
}

export type EventDataMap = {
  readonly [K in keyof EventPayloadMap]: EventPayloadMap[K];
};

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
