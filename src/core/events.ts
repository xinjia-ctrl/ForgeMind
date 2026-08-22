import type { RiskLevel, Role } from "../auth/types.js";
import type { CoverageSource, QualityGrade } from "../quality/types.js";
import type { RunStatus, StageId, StageStatus } from "./types.js";

interface ActorIndex {
  readonly actor?: string;
  readonly role?: Role;
  readonly risk?: RiskLevel;
}

interface EventIndex {
  readonly taskId?: string;
}

interface EventPayloadMap {
  readonly "development.received": {
    readonly runId: string;
    readonly actor: "agentic";
    readonly eventId: string;
    readonly source: "github" | "jira" | "ci" | "forgemind";
    readonly developmentType:
      "issue.updated" | "issue.assigned" | "ci.failed" | "pr.mentioned" | "approval.timed_out";
    readonly repo: string;
    readonly objectKind: "issue" | "pull_request" | "workflow" | "approval";
    readonly objectId: string;
    readonly occurredAt: string;
  };
  readonly "trigger.decided": {
    readonly runId: string;
    readonly actor: "agentic";
    readonly eventId: string;
    readonly repo: string;
    readonly decision: "TRIGGER" | "IGNORE" | "MERGE" | "DEFER";
    readonly reason: string;
    readonly ruleId?: string;
    readonly requestId?: string;
    readonly retryAt?: string;
  };
  readonly "negotiation.started": {
    readonly runId: string;
    readonly negotiationId: string;
    readonly trigger: "arch-conflict" | "review-repeated-rejection" | "artifact-mismatch";
    readonly topic: string;
  };
  readonly "negotiation.round": {
    readonly runId: string;
    readonly negotiationId: string;
    readonly round: 1 | 2 | 3;
    readonly status: "CONTINUE" | "CONVERGED";
    readonly proposal: unknown;
    readonly counter: unknown;
  };
  readonly "negotiation.resolved": {
    readonly runId: string;
    readonly negotiationId: string;
    readonly decisionRecordId: string;
    readonly decision: unknown;
  };
  readonly "negotiation.escalated": {
    readonly runId: string;
    readonly negotiationId: string;
    readonly reason: "no-consensus" | "timeout";
    readonly approved: boolean;
  };
  readonly "run.started": {
    readonly runId: string;
    readonly requirement: string;
    readonly branch: string;
    readonly repo?: string;
    readonly parentRunId?: string;
    readonly actor?: string;
  };
  readonly "task.started": {
    readonly runId: string;
    readonly taskId: string;
    readonly childRunId: string;
    readonly repo: string;
    readonly requirement: string;
  };
  readonly "task.completed": {
    readonly runId: string;
    readonly taskId: string;
    readonly childRunId: string;
    readonly repo: string;
    readonly branch: string;
    readonly status: "SUCCEEDED";
    readonly summary: string;
  };
  readonly "task.failed": {
    readonly runId: string;
    readonly taskId: string;
    readonly childRunId: string;
    readonly repo: string;
    readonly status: "FAILED" | "BLOCKED";
    readonly error: string;
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
    readonly negotiationId?: string;
    readonly negotiationSide?: "proposal" | "counter";
  };
  readonly "memory.recalled": {
    readonly runId: string;
    readonly stage: StageId;
    readonly scope: "working" | "episodic" | "project" | "semantic";
    readonly source: string;
    readonly score: number;
    readonly reason: string;
    readonly content: unknown;
    readonly used: boolean;
  };
  readonly "memory.stored": {
    readonly runId: string;
    readonly stage: StageId;
    readonly scope: "working" | "episodic" | "project" | "semantic";
    readonly kind: string;
    readonly path: string;
  };
  readonly "context.assembled": {
    readonly runId: string;
    readonly stage: StageId;
    readonly sections: readonly {
      readonly name: string;
      readonly source: string;
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
  } & ActorIndex;
  readonly "approval.approved": {
    readonly runId: string;
    readonly stage: StageId;
    readonly tool: string;
    readonly action: unknown;
    readonly policy: string;
    readonly mode: "approve";
    readonly decisionSource: "interactive" | "auto" | "config";
  } & ActorIndex;
  readonly "approval.rejected": {
    readonly runId: string;
    readonly stage: StageId;
    readonly tool: string;
    readonly action: unknown;
    readonly policy: string;
    readonly mode: "approve" | "deny";
    readonly reason: string;
    readonly decisionSource: "interactive" | "auto" | "disabled" | "policy";
  } & ActorIndex;
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
  };
  readonly "gate.passed": {
    readonly runId: string;
    readonly stage: "REVIEW" | "TEST";
    readonly evidence: string;
    readonly coveragePercent?: number;
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
    readonly status: RunStatus;
    readonly score: number;
    readonly grade: QualityGrade;
    readonly gatePassRate: number;
    readonly gatesPassed: number;
    readonly gatesTotal: number;
    readonly reworkRounds: number;
    readonly testPassRate: number;
    readonly testsPassed: number;
    readonly testsTotal: number;
    readonly codeCoveragePercent: number | null;
    readonly coverageSource: CoverageSource;
    readonly recommendations: readonly string[];
  };
}

export type EventDataMap = {
  readonly [K in keyof EventPayloadMap]: EventPayloadMap[K] & EventIndex;
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
