import { createHash } from "node:crypto";
import type { ForgeMindEvent } from "./events.js";

export interface WorkflowTraceStep {
  readonly type: string;
  readonly stage?: string;
  readonly attempt?: number;
  readonly operation?: string;
  readonly outcome?: string;
}

export function workflowTrace(events: readonly ForgeMindEvent[]): readonly WorkflowTraceStep[] {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .map((event): WorkflowTraceStep => {
      switch (event.type) {
        case "run.started":
          return { type: event.type };
        case "stage.started":
          return {
            type: event.type,
            stage: event.data.stage,
            attempt: event.data.attempt,
          };
        case "llm.called":
          return {
            type: event.type,
            stage: event.data.stage,
            operation: event.data.model,
          };
        case "tool.called":
          return {
            type: event.type,
            stage: event.data.stage,
            operation: event.data.tool,
            outcome: toolSucceeded(event.data.result) ? "passed" : "failed",
          };
        case "approval.requested":
          return {
            type: event.type,
            stage: event.data.stage,
            operation: event.data.tool,
            outcome: "requested",
          };
        case "approval.approved":
          return {
            type: event.type,
            stage: event.data.stage,
            operation: event.data.tool,
            outcome: "approved",
          };
        case "approval.rejected":
          return {
            type: event.type,
            stage: event.data.stage,
            operation: event.data.tool,
            outcome: "rejected",
          };
        case "artifact.produced":
          return {
            type: event.type,
            stage: event.data.stage,
            operation: event.data.kind,
          };
        case "gate.rejected":
          return {
            type: event.type,
            stage: event.data.stage,
            outcome: "rejected",
          };
        case "gate.passed":
          return {
            type: event.type,
            stage: event.data.stage,
            outcome: "passed",
          };
        case "stage.completed":
          return {
            type: event.type,
            stage: event.data.stage,
            outcome: event.data.status,
          };
        case "stage.failed":
          return {
            type: event.type,
            stage: event.data.stage,
            outcome: "FAILED",
          };
        case "run.finished":
          return { type: event.type, outcome: event.data.status };
      }
    });
}

export function workflowSignature(events: readonly ForgeMindEvent[]): string {
  return createHash("sha256")
    .update(JSON.stringify(workflowTrace(events)))
    .digest("hex");
}

function toolSucceeded(result: unknown): boolean {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === true;
}
