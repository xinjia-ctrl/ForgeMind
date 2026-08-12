import type { FailureKind } from "../core/errors.js";
import type { ForgeMindEvent } from "../core/events.js";
import { workflowSignature, workflowTrace } from "../core/reproducibility.js";
import { STAGES, type RunStatus, type StageId } from "../core/types.js";
import { auditValue } from "../tools/audit.js";

export const MAX_REPORT_EVENTS = 2_000;

export interface ReportFailure {
  readonly stage: StageId | null;
  readonly kind: FailureKind | "UNKNOWN";
  readonly message: string;
}

export interface ReportTimelineEvent {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly stage: StageId | null;
  readonly attempt: number | null;
  readonly operation: string | null;
  readonly outcome: string | null;
  readonly summary: string;
  readonly details?: unknown;
}

export interface TimelineGroup {
  readonly stage: StageId | null;
  readonly attempt: number | null;
  readonly events: readonly ReportTimelineEvent[];
}

export interface ReportGate {
  readonly seq: number;
  readonly stage: "REVIEW" | "TEST";
  readonly attempt: number;
  readonly passed: boolean;
  readonly reason: string;
  readonly feedback: string;
  readonly evidence: string;
  readonly rework: boolean;
}

export interface ReportStageStats {
  readonly stage: StageId;
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly durationMs: number | null;
}

export interface ReportArtifact {
  readonly seq: number;
  readonly stage: StageId;
  readonly path: string;
  readonly kind: string;
  readonly summary: string;
}

export interface ReportSecurityEvent {
  readonly seq: number;
  readonly ts: string;
  readonly stage: StageId;
  readonly action: string;
  readonly mode: "allow" | "approve" | "deny";
  readonly decision: "ALLOWED" | "REQUESTED" | "APPROVED" | "DENIED";
  readonly policy: string;
  readonly source?: string;
  readonly reason?: string;
  readonly details?: unknown;
}

export interface ReportViewModel {
  readonly runId: string;
  readonly status: RunStatus | "RUNNING";
  readonly requirement: string;
  readonly failure?: ReportFailure;
  readonly timeline: readonly TimelineGroup[];
  readonly gates: readonly ReportGate[];
  readonly stats: {
    readonly total: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly toolCalls: number;
      readonly durationMs: number | null;
    };
    readonly perStage: readonly ReportStageStats[];
  };
  readonly artifacts: readonly ReportArtifact[];
  readonly security: readonly ReportSecurityEvent[];
  readonly workflowSignature: string;
  readonly totalEvents: number;
  readonly displayedEvents: number;
  readonly truncated: boolean;
}

interface MutableStageStats {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  completedDurations: number;
  incompleteDuration: boolean;
}

export function buildReportViewModel(events: readonly ForgeMindEvent[]): ReportViewModel {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const trace = workflowTrace(ordered);
  const stageStats = new Map<StageId, MutableStageStats>(
    STAGES.map((stage) => [stage, emptyStageStats()]),
  );
  const attempts = new Map<StageId, number>();
  const openStarts = new Map<StageId, number | null>();
  const gates: ReportGate[] = [];
  const artifacts: ReportArtifact[] = [];
  const security: ReportSecurityEvent[] = [];
  const timeline: ReportTimelineEvent[] = [];
  let runId = "unknown";
  let requirement = "";
  let failure: ReportFailure | undefined;
  let runStartedAt: number | null = null;
  let runFinishedAt: number | null = null;
  let finishSummary = "";

  ordered.forEach((event, index) => {
    runId = event.data.runId;
    const eventTrace = trace[index];
    if (eventTrace === undefined) throw new Error(`Missing workflow trace for event ${event.seq}`);

    if (event.type === "stage.started") attempts.set(event.data.stage, event.data.attempt);
    const stage = eventStage(event);
    const attempt = stage === null ? null : (attempts.get(stage) ?? null);
    timeline.push(
      normalizeEvent(event, eventTrace.operation ?? null, eventTrace.outcome ?? null, attempt),
    );

    switch (event.type) {
      case "run.started":
        requirement = event.data.requirement;
        runStartedAt = timestamp(event.ts);
        break;
      case "stage.started":
        openStarts.set(event.data.stage, timestamp(event.ts));
        break;
      case "llm.called": {
        const stats = requiredStats(stageStats, event.data.stage);
        stats.llmCalls += 1;
        stats.inputTokens += event.data.inputTokens;
        stats.outputTokens += event.data.outputTokens;
        break;
      }
      case "tool.called":
        requiredStats(stageStats, event.data.stage).toolCalls += 1;
        if (policyMode(event.data.policy) === "allow") {
          security.push({
            seq: event.seq,
            ts: event.ts,
            stage: event.data.stage,
            action: event.data.tool,
            mode: "allow",
            decision: "ALLOWED",
            policy: event.data.policy,
            details: auditValue({ args: event.data.args, result: event.data.result }),
          });
        }
        break;
      case "approval.requested":
        security.push({
          seq: event.seq,
          ts: event.ts,
          stage: event.data.stage,
          action: event.data.tool,
          mode: event.data.mode,
          decision: "REQUESTED",
          policy: event.data.policy,
          details: auditValue(event.data.action),
        });
        break;
      case "approval.approved":
        security.push({
          seq: event.seq,
          ts: event.ts,
          stage: event.data.stage,
          action: event.data.tool,
          mode: event.data.mode,
          decision: "APPROVED",
          policy: event.data.policy,
          source: event.data.decisionSource,
          details: auditValue(event.data.action),
        });
        break;
      case "approval.rejected":
        security.push({
          seq: event.seq,
          ts: event.ts,
          stage: event.data.stage,
          action: event.data.tool,
          mode: event.data.mode,
          decision: "DENIED",
          policy: event.data.policy,
          source: event.data.decisionSource,
          reason: event.data.reason,
          details: auditValue(event.data.action),
        });
        break;
      case "artifact.produced":
        artifacts.push({
          seq: event.seq,
          stage: event.data.stage,
          path: event.data.path,
          kind: event.data.kind,
          summary: event.data.summary,
        });
        break;
      case "gate.rejected":
        gates.push({
          seq: event.seq,
          stage: event.data.stage,
          attempt: attempts.get(event.data.stage) ?? 0,
          passed: false,
          reason: event.data.reason,
          feedback: event.data.feedback,
          evidence: "",
          rework: true,
        });
        break;
      case "gate.passed": {
        const gateAttempt = attempts.get(event.data.stage) ?? 0;
        gates.push({
          seq: event.seq,
          stage: event.data.stage,
          attempt: gateAttempt,
          passed: true,
          reason: "",
          feedback: "",
          evidence: event.data.evidence,
          rework: gateAttempt > 1,
        });
        break;
      }
      case "stage.completed":
        recordDuration(event.data.stage, event.ts, openStarts, stageStats);
        break;
      case "stage.failed":
        markIncompleteDuration(event.data.stage, openStarts, stageStats);
        failure = {
          stage: event.data.stage,
          kind: event.data.kind ?? "UNKNOWN",
          message: event.data.error,
        };
        break;
      case "run.finished":
        finishSummary = event.data.summary;
        runFinishedAt = timestamp(event.ts);
        break;
    }
  });

  const status = finalRunStatus(ordered);
  for (const stage of openStarts.keys()) requiredStats(stageStats, stage).incompleteDuration = true;
  if (failure === undefined && status !== "SUCCEEDED" && status !== "RUNNING") {
    failure = {
      stage: null,
      kind: status === "BLOCKED" ? "FATAL" : "UNKNOWN",
      message: finishSummary,
    };
  }

  const limited = limitTimeline(timeline, MAX_REPORT_EVENTS);
  const perStage = STAGES.map((stage): ReportStageStats => {
    const stats = requiredStats(stageStats, stage);
    return {
      stage,
      llmCalls: stats.llmCalls,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      toolCalls: stats.toolCalls,
      durationMs:
        stats.incompleteDuration || stats.completedDurations === 0 ? null : stats.durationMs,
    };
  });

  const result: ReportViewModel = {
    runId,
    status,
    requirement,
    ...(failure === undefined ? {} : { failure }),
    timeline: groupTimeline(limited),
    gates,
    stats: {
      total: {
        inputTokens: perStage.reduce((sum, item) => sum + item.inputTokens, 0),
        outputTokens: perStage.reduce((sum, item) => sum + item.outputTokens, 0),
        toolCalls: perStage.reduce((sum, item) => sum + item.toolCalls, 0),
        durationMs: durationBetween(runStartedAt, runFinishedAt),
      },
      perStage,
    },
    artifacts,
    security,
    workflowSignature: workflowSignature(ordered),
    totalEvents: timeline.length,
    displayedEvents: limited.length,
    truncated: limited.length < timeline.length,
  };
  return result;
}

function groupTimeline(events: readonly ReportTimelineEvent[]): readonly TimelineGroup[] {
  const groups: Array<{
    stage: StageId | null;
    attempt: number | null;
    events: ReportTimelineEvent[];
  }> = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (previous?.stage === event.stage && previous.attempt === event.attempt) {
      previous.events.push(event);
    } else {
      groups.push({ stage: event.stage, attempt: event.attempt, events: [event] });
    }
  }
  return groups;
}

function finalRunStatus(events: readonly ForgeMindEvent[]): ReportViewModel["status"] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "run.finished") return event.data.status;
  }
  return "RUNNING";
}

function emptyStageStats(): MutableStageStats {
  return {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    durationMs: 0,
    completedDurations: 0,
    incompleteDuration: false,
  };
}

function requiredStats(
  stats: ReadonlyMap<StageId, MutableStageStats>,
  stage: StageId,
): MutableStageStats {
  const value = stats.get(stage);
  if (value === undefined) throw new Error(`Missing stage statistics for ${stage}`);
  return value;
}

function recordDuration(
  stage: StageId,
  completedAt: string,
  openStarts: Map<StageId, number | null>,
  stats: ReadonlyMap<StageId, MutableStageStats>,
): void {
  const start = openStarts.get(stage);
  const end = timestamp(completedAt);
  const stageStats = requiredStats(stats, stage);
  if (start === undefined || start === null || end === null || end < start) {
    stageStats.incompleteDuration = true;
  } else {
    stageStats.durationMs += end - start;
    stageStats.completedDurations += 1;
  }
  openStarts.delete(stage);
}

function markIncompleteDuration(
  stage: StageId,
  openStarts: Map<StageId, number | null>,
  stats: ReadonlyMap<StageId, MutableStageStats>,
): void {
  requiredStats(stats, stage).incompleteDuration = true;
  openStarts.delete(stage);
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetween(start: number | null, end: number | null): number | null {
  return start !== null && end !== null && end >= start ? end - start : null;
}

function eventStage(event: ForgeMindEvent): StageId | null {
  switch (event.type) {
    case "stage.started":
    case "llm.called":
    case "tool.called":
    case "approval.requested":
    case "approval.approved":
    case "approval.rejected":
    case "artifact.produced":
    case "gate.rejected":
    case "gate.passed":
    case "stage.completed":
    case "stage.failed":
      return event.data.stage;
    case "run.started":
    case "run.finished":
      return null;
  }
}

function normalizeEvent(
  event: ForgeMindEvent,
  operation: string | null,
  outcome: string | null,
  attempt: number | null,
): ReportTimelineEvent {
  const details = eventDetails(event);
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    stage: eventStage(event),
    attempt,
    operation,
    outcome,
    summary: eventSummary(event),
    ...(details === undefined ? {} : { details }),
  };
}

function eventDetails(event: ForgeMindEvent): unknown {
  if (event.type === "tool.called") {
    return {
      args: auditValue(event.data.args),
      result: auditValue(event.data.result),
      policy: event.data.policy,
    };
  }
  if (
    event.type === "approval.requested" ||
    event.type === "approval.approved" ||
    event.type === "approval.rejected"
  ) {
    return { action: auditValue(event.data.action), policy: event.data.policy };
  }
  if (event.type === "stage.failed" && event.data.stack !== undefined) {
    return { stack: event.data.stack };
  }
  return undefined;
}

function eventSummary(event: ForgeMindEvent): string {
  switch (event.type) {
    case "run.started":
      return `Run started on ${event.data.branch}`;
    case "stage.started":
      return `Attempt ${event.data.attempt} started`;
    case "llm.called":
      return `${event.data.model}: ${event.data.inputTokens} input / ${event.data.outputTokens} output tokens`;
    case "tool.called":
      return `${event.data.tool}: ${toolSucceeded(event.data.result) ? "passed" : "failed"}`;
    case "approval.requested":
      return `Approval requested: ${event.data.tool}`;
    case "approval.approved":
      return `Approved by ${event.data.decisionSource}: ${event.data.tool}`;
    case "approval.rejected":
      return `Denied: ${event.data.tool} — ${event.data.reason}`;
    case "artifact.produced":
      return `${event.data.kind}: ${event.data.path}`;
    case "gate.rejected":
      return `Rejected: ${event.data.reason}`;
    case "gate.passed":
      return `Passed: ${event.data.evidence}`;
    case "stage.completed":
      return event.data.status;
    case "stage.failed":
      return `${event.data.kind ?? "UNKNOWN"}: ${event.data.error}`;
    case "run.finished":
      return `${event.data.status}: ${event.data.summary}`;
  }
}

function toolSucceeded(result: unknown): boolean {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === true;
}

function limitTimeline(
  events: readonly ReportTimelineEvent[],
  limit: number,
): readonly ReportTimelineEvent[] {
  if (events.length <= limit) return events;
  const critical = events.filter(isCritical);
  if (critical.length >= limit) return critical.slice(critical.length - limit);
  const slots = limit - critical.length;
  const ordinary = events.filter((event) => !isCritical(event));
  const sampled = new Set<number>();
  for (let index = 0; index < slots; index += 1) {
    const position = Math.floor((index * ordinary.length) / slots);
    const event = ordinary[position];
    if (event !== undefined) sampled.add(event.seq);
  }
  const criticalSeq = new Set(critical.map((event) => event.seq));
  return events
    .filter((event) => criticalSeq.has(event.seq) || sampled.has(event.seq))
    .slice(0, limit);
}

function isCritical(event: ReportTimelineEvent): boolean {
  return (
    event.type === "run.started" ||
    event.type === "run.finished" ||
    event.type === "stage.failed" ||
    event.type === "approval.requested" ||
    event.type === "approval.approved" ||
    event.type === "approval.rejected" ||
    event.type === "gate.rejected" ||
    event.type === "gate.passed" ||
    (event.type === "tool.called" && event.outcome === "failed")
  );
}

function policyMode(policy: string): "allow" | "approve" | "deny" | null {
  const match = /(?:rule:\d+|default):(allow|approve|deny)(?:$|:)/.exec(policy);
  return match?.[1] === "allow" || match?.[1] === "approve" || match?.[1] === "deny"
    ? match[1]
    : null;
}
