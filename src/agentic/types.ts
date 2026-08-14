export const DEVELOPMENT_EVENT_TYPES = [
  "issue.updated",
  "issue.assigned",
  "ci.failed",
  "pr.mentioned",
  "approval.timed_out",
] as const;

export type DevelopmentEventType = (typeof DEVELOPMENT_EVENT_TYPES)[number];

export const DEVELOPMENT_EVENT_SOURCES = ["github", "jira", "ci", "forgemind"] as const;

export type DevelopmentEventSource = (typeof DEVELOPMENT_EVENT_SOURCES)[number];

export type DevelopmentContextValue = string | number | boolean | null | readonly string[];

export interface DevelopmentObject {
  readonly kind: "issue" | "pull_request" | "workflow" | "approval";
  readonly id: string;
  readonly title?: string;
  readonly url?: string;
}

export interface DevelopmentEvent {
  readonly id: string;
  readonly source: DevelopmentEventSource;
  readonly type: DevelopmentEventType;
  readonly repo: string;
  readonly object: DevelopmentObject;
  readonly occurredAt: string;
  readonly actor?: string;
  readonly labels: readonly string[];
  readonly context: Readonly<Record<string, DevelopmentContextValue>>;
}

export type RunPriority = "low" | "normal" | "high";

export interface TriggerRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly match: {
    readonly type: DevelopmentEventType;
    readonly source?: DevelopmentEventSource;
    readonly repo?: string;
    readonly labelsAll: readonly string[];
    readonly contextEquals: Readonly<Record<string, string | number | boolean | null>>;
  };
  readonly run: {
    readonly requirement: string;
    readonly priority: RunPriority;
  };
  readonly cooldownMs: number;
}

export interface AgenticGuardrailConfig {
  readonly allowedTools: readonly string[];
  readonly allowedCommands: readonly (readonly string[])[];
}

export interface AgenticConfig {
  readonly repositories: readonly string[];
  readonly dailyTaskQuota: number;
  readonly rateLimit: {
    readonly maxRuns: number;
    readonly windowMs: number;
  };
  readonly dedupeTtlMs: number;
  readonly guardrails: AgenticGuardrailConfig;
  readonly rules: readonly TriggerRule[];
}

export interface AgenticRunRequest {
  readonly id: string;
  readonly actor: "agentic";
  readonly repository: string;
  readonly requirement: string;
  readonly priority: RunPriority;
  readonly ruleId: string;
  readonly sourceEventIds: readonly string[];
  readonly triggeredAt: string;
}

export type TriggerDecisionReason =
  | "matched"
  | "duplicate-event"
  | "repository-not-authorized"
  | "no-matching-rule"
  | "active-object-cooldown"
  | "pending-object-merged"
  | "global-rate-limit"
  | "daily-task-quota";

interface DecisionBase {
  readonly event: DevelopmentEvent;
  readonly reason: TriggerDecisionReason;
  readonly ruleId?: string;
}

export type TriggerDecision =
  | (DecisionBase & {
      readonly kind: "TRIGGER";
      readonly reason: "matched";
      readonly ruleId: string;
      readonly request: AgenticRunRequest;
    })
  | (DecisionBase & {
      readonly kind: "IGNORE";
      readonly reason: "duplicate-event" | "repository-not-authorized" | "no-matching-rule";
    })
  | (DecisionBase & {
      readonly kind: "MERGE";
      readonly reason: "active-object-cooldown" | "pending-object-merged";
      readonly ruleId: string;
      readonly mergedInto: string;
    })
  | (DecisionBase & {
      readonly kind: "DEFER";
      readonly reason: "global-rate-limit" | "daily-task-quota";
      readonly ruleId: string;
      readonly retryAt: string;
    });
