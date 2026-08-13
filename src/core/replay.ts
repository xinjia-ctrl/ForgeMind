import type { ForgeMindEvent } from "./events.js";
import type { RunStatus, StageId } from "./types.js";

export interface TimelineEntry {
  readonly seq: number;
  readonly type: string;
  readonly stage: StageId | null;
  readonly detail: string;
}

export interface Timeline {
  readonly runId: string;
  readonly status: RunStatus | "RUNNING";
  readonly requirement: string;
  readonly entries: readonly TimelineEntry[];
}

export function replay(events: readonly ForgeMindEvent[]): Timeline {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let runId = "unknown";
  let requirement = "";
  let status: Timeline["status"] = "RUNNING";

  const entries = ordered.map((event): TimelineEntry => {
    const data = event.data as unknown as Record<string, unknown>;
    if (typeof data["runId"] === "string") runId = data["runId"];
    if (event.type === "run.started") requirement = event.data.requirement;
    if (event.type === "run.finished") status = event.data.status;
    return {
      seq: event.seq,
      type: event.type,
      stage: isStage(data["stage"]) ? data["stage"] : null,
      detail: describe(event),
    };
  });

  return { runId, status, requirement, entries };
}

function isStage(value: unknown): value is StageId {
  return (
    value === "PLAN" ||
    value === "ARCH" ||
    value === "CODE" ||
    value === "REVIEW" ||
    value === "TEST" ||
    value === "COMMIT"
  );
}

function describe(event: ForgeMindEvent): string {
  switch (event.type) {
    case "run.started":
      return `Run started on ${event.data.branch}`;
    case "task.started":
      return `Task ${event.data.taskId} started as ${event.data.childRunId}`;
    case "task.completed":
      return `Task ${event.data.taskId} succeeded on ${event.data.branch}`;
    case "task.failed":
      return `Task ${event.data.taskId} ${event.data.status.toLocaleLowerCase()}: ${event.data.error}`;
    case "stage.started":
      return `Attempt ${event.data.attempt} started`;
    case "llm.called":
      return `${event.data.model}: ${event.data.inputTokens} input / ${event.data.outputTokens} output tokens`;
    case "memory.recalled":
      return `${event.data.used ? "Used" : "Skipped"} ${event.data.scope} memory from ${event.data.source}`;
    case "memory.stored":
      return `Stored ${event.data.scope} ${event.data.kind}: ${event.data.path}`;
    case "context.assembled":
      return `Assembled ${event.data.sections.length} context sections (${event.data.tokenEstimate} estimated tokens)`;
    case "tool.called":
      return `${event.data.tool}: ${toolSucceeded(event.data.result) ? "ok" : "failed"}`;
    case "approval.requested":
      return `Approval requested for ${event.data.tool}`;
    case "approval.approved":
      return `Approved ${event.data.tool} by ${event.data.decisionSource}`;
    case "approval.rejected":
      return `Rejected ${event.data.tool}: ${event.data.reason}`;
    case "artifact.produced":
      return `${event.data.kind}: ${event.data.path}`;
    case "gate.rejected":
      return `Rejected: ${event.data.reason}`;
    case "gate.passed":
      return `Passed: ${event.data.evidence}`;
    case "stage.completed":
      return event.data.status;
    case "stage.failed":
      return event.data.error;
    case "run.finished":
      return `${event.data.status}: ${event.data.summary}`;
  }
}

function toolSucceeded(result: unknown): boolean {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === true;
}
