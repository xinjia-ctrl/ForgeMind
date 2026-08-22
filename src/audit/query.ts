import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import type { ForgeMindEvent } from "../core/events.js";
import type { RiskLevel, Role } from "../auth/types.js";
import type { RunStatus, StageId } from "../core/types.js";

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_EVENTS = 100_000;

export interface AuditQuery {
  readonly from: string;
  readonly to: string;
  readonly actor?: string;
  readonly repo?: string;
  readonly status?: RunStatus;
}

export interface AuditRecord {
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly stage: StageId | null;
  readonly taskId?: string;
  readonly actor?: string;
  readonly role?: Role;
  readonly risk?: RiskLevel;
  readonly repo?: string;
  readonly status?: RunStatus;
  readonly operation?: string;
  readonly outcome?: string;
}

export interface AuditQueryResult {
  readonly query: AuditQuery;
  readonly records: readonly AuditRecord[];
  readonly scannedFiles: number;
  readonly scannedEvents: number;
}

export async function queryAuditEvents(
  eventsDirectories: string | readonly string[],
  query: AuditQuery,
): Promise<AuditQueryResult> {
  const { from, to } = validateWindow(query.from, query.to);
  const directories =
    typeof eventsDirectories === "string" ? [eventsDirectories] : [...eventsDirectories];
  if (directories.length === 0) throw new HardFailure("At least one audit directory is required");
  const files = (await Promise.all(directories.map((directory) => listEventFiles(directory))))
    .flat()
    .sort();
  const records: AuditRecord[] = [];
  let scannedEvents = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const events = parseEvents(content, file);
    scannedEvents += events.length;
    if (scannedEvents > MAX_EVENTS) {
      throw new HardFailure(`Audit query exceeds the ${MAX_EVENTS} event scan limit`);
    }
    records.push(...projectRun(events, query, from, to));
  }
  records.sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
  return { query, records, scannedFiles: files.length, scannedEvents };
}

async function listEventFiles(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw new HardFailure(`Cannot read audit events directory ${directory}`, { cause: error });
  }
}

function projectRun(
  events: readonly ForgeMindEvent[],
  query: AuditQuery,
  from: number,
  to: number,
): readonly AuditRecord[] {
  const started = events.find((event) => event.type === "run.started");
  const finished = [...events].reverse().find((event) => event.type === "run.finished");
  const runActor = started?.type === "run.started" ? started.data.actor : undefined;
  const runRepo = started?.type === "run.started" ? started.data.repo : undefined;
  const runStatus = finished?.type === "run.finished" ? finished.data.status : undefined;
  if (query.status !== undefined && runStatus !== query.status) return [];
  return events.flatMap((event): AuditRecord[] => {
    const timestamp = Date.parse(event.ts);
    if (!Number.isFinite(timestamp) || timestamp < from || timestamp > to) return [];
    const actor = approvalActor(event) ?? runActor;
    const repo = eventRepo(event) ?? runRepo;
    if (query.actor !== undefined && actor !== query.actor) return [];
    if (query.repo !== undefined && repo !== query.repo) return [];
    const data = event.data as unknown as Record<string, unknown>;
    return [
      {
        runId: typeof data["runId"] === "string" ? data["runId"] : "unknown",
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        stage: eventStage(event),
        ...(typeof data["taskId"] === "string" ? { taskId: data["taskId"] } : {}),
        ...(actor === undefined ? {} : { actor }),
        ...approvalRoleAndRisk(event),
        ...(repo === undefined ? {} : { repo }),
        ...(runStatus === undefined ? {} : { status: runStatus }),
        ...operationAndOutcome(event),
      },
    ];
  });
}

function validateWindow(fromValue: string, toValue: string): { from: number; to: number } {
  const from = Date.parse(fromValue);
  const to = Date.parse(toValue);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new HardFailure("Audit query from/to must be valid ISO timestamps");
  }
  if (to < from) throw new HardFailure("Audit query to must not precede from");
  if (to - from > MAX_WINDOW_MS) {
    throw new HardFailure("Audit query time window cannot exceed 31 days");
  }
  return { from, to };
}

function parseEvents(content: string, file: string): readonly ForgeMindEvent[] {
  if (content.trim().length === 0) return [];
  return content
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== "object" ||
          value === null ||
          !("v" in value) ||
          value.v !== 1 ||
          !("seq" in value) ||
          typeof value.seq !== "number" ||
          !("ts" in value) ||
          typeof value.ts !== "string" ||
          !("type" in value) ||
          typeof value.type !== "string" ||
          !("data" in value) ||
          typeof value.data !== "object" ||
          value.data === null
        ) {
          throw new Error("invalid event shape");
        }
        return value as ForgeMindEvent;
      } catch (error) {
        throw new HardFailure(`Invalid audit event ${file}:${index + 1}`, { cause: error });
      }
    });
}

function eventStage(event: ForgeMindEvent): StageId | null {
  if (!("stage" in event.data)) return null;
  const stage: unknown = event.data.stage;
  return stage === "PLAN" ||
    stage === "ARCH" ||
    stage === "CODE" ||
    stage === "REVIEW" ||
    stage === "TEST" ||
    stage === "COMMIT"
    ? stage
    : null;
}

function approvalActor(event: ForgeMindEvent): string | undefined {
  if (event.type === "development.received" || event.type === "trigger.decided") {
    return event.data.actor;
  }
  return event.type === "approval.requested" ||
    event.type === "approval.approved" ||
    event.type === "approval.rejected"
    ? event.data.actor
    : undefined;
}

function approvalRoleAndRisk(event: ForgeMindEvent): {
  readonly role?: Role;
  readonly risk?: RiskLevel;
} {
  if (
    event.type !== "approval.requested" &&
    event.type !== "approval.approved" &&
    event.type !== "approval.rejected"
  ) {
    return {};
  }
  return {
    ...(event.data.role === undefined ? {} : { role: event.data.role }),
    ...(event.data.risk === undefined ? {} : { risk: event.data.risk }),
  };
}

function eventRepo(event: ForgeMindEvent): string | undefined {
  switch (event.type) {
    case "development.received":
    case "trigger.decided":
      return event.data.repo;
    case "run.started":
      return event.data.repo;
    case "task.started":
    case "task.completed":
    case "task.failed":
      return event.data.repo;
    default:
      return undefined;
  }
}

function operationAndOutcome(event: ForgeMindEvent): {
  readonly operation?: string;
  readonly outcome?: string;
} {
  switch (event.type) {
    case "development.received":
      return { operation: event.data.developmentType, outcome: "RECEIVED" };
    case "trigger.decided":
      return { operation: event.data.ruleId ?? event.data.eventId, outcome: event.data.decision };
    case "negotiation.started":
      return { operation: event.data.trigger, outcome: "STARTED" };
    case "negotiation.round":
      return { operation: event.data.negotiationId, outcome: event.data.status };
    case "negotiation.resolved":
      return { operation: event.data.negotiationId, outcome: "RESOLVED" };
    case "negotiation.escalated":
      return {
        operation: event.data.negotiationId,
        outcome: event.data.approved ? "APPROVED" : "DENIED",
      };
    case "tool.called":
      return {
        operation: event.data.tool,
        outcome:
          typeof event.data.result === "object" &&
          event.data.result !== null &&
          "ok" in event.data.result &&
          event.data.result.ok === true
            ? "SUCCEEDED"
            : "FAILED",
      };
    case "approval.requested":
      return { operation: event.data.tool, outcome: "REQUESTED" };
    case "approval.approved":
      return { operation: event.data.tool, outcome: "APPROVED" };
    case "approval.rejected":
      return { operation: event.data.tool, outcome: "DENIED" };
    case "run.finished":
      return { outcome: event.data.status };
    case "run.quality":
      return { operation: event.data.grade, outcome: String(event.data.score) };
    case "task.completed":
      return { operation: event.data.taskId, outcome: "SUCCEEDED" };
    case "task.failed":
      return { operation: event.data.taskId, outcome: event.data.status };
    default:
      return {};
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
