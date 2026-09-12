import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FatalFailure } from "./errors.js";
import { assertValidRunId } from "./event-log.js";
import type { GateResult, TaskContext } from "./types.js";
import type { RunBudgetSnapshot } from "./run-budget.js";
import type { RunManifest } from "./run-manifest.js";

const MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024;

export const RUN_PHASES = ["PLAN", "ARCH", "CODE", "TEST", "REVIEW", "COMMIT"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export interface CheckpointReworkRecord {
  readonly attempt: number;
  readonly gate: Pick<GateResult, "stage" | "reason" | "feedback" | "evidence">;
}

export interface RunCheckpoint {
  readonly version: 1;
  readonly runId: string;
  readonly phase: RunPhase;
  readonly attempt: number;
  readonly context: TaskContext;
  readonly feedback?: string;
  readonly reworkHistory: readonly CheckpointReworkRecord[];
  readonly budget?: RunBudgetSnapshot;
  readonly manifest?: RunManifest;
  readonly updatedAt: string;
}

export interface RunCheckpointStore {
  load(runId: string): Promise<RunCheckpoint | null>;
  save(checkpoint: RunCheckpoint): Promise<void>;
  clear(runId: string): Promise<void>;
}

export class FileRunCheckpointStore implements RunCheckpointStore {
  readonly #directory: string;

  public constructor(directory: string) {
    if (directory.trim().length === 0) throw new FatalFailure("Checkpoint directory is required");
    this.#directory = path.resolve(directory);
  }

  public async load(runId: string): Promise<RunCheckpoint | null> {
    assertValidRunId(runId);
    try {
      const content = await readFile(this.filePath(runId), "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_BYTES) {
        throw new FatalFailure(`Checkpoint for ${runId} exceeds the size limit`);
      }
      return parseRunCheckpoint(JSON.parse(content));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      if (error instanceof FatalFailure) throw error;
      throw new FatalFailure(`Cannot load checkpoint for ${runId}`, { cause: error });
    }
  }

  public async save(checkpoint: RunCheckpoint): Promise<void> {
    const validated = parseRunCheckpoint(checkpoint);
    assertValidRunId(validated.runId);
    await mkdir(this.#directory, { recursive: true });
    const target = this.filePath(validated.runId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new FatalFailure(`Cannot save checkpoint for ${validated.runId}`, { cause: error });
    }
  }

  public async clear(runId: string): Promise<void> {
    assertValidRunId(runId);
    await unlink(this.filePath(runId)).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) {
        throw new FatalFailure(`Cannot clear checkpoint for ${runId}`, { cause: error });
      }
    });
  }

  private filePath(runId: string): string {
    return path.join(this.#directory, `${runId}.checkpoint.json`);
  }
}

export function parseRunCheckpoint(value: unknown): RunCheckpoint {
  if (!isRecord(value) || value["version"] !== 1) {
    throw new FatalFailure("Invalid run checkpoint version");
  }
  const runId = requiredString(value["runId"], "checkpoint runId");
  const phase = value["phase"];
  if (!RUN_PHASES.includes(phase as RunPhase)) throw new FatalFailure("Invalid checkpoint phase");
  const attempt = value["attempt"];
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new FatalFailure("Invalid checkpoint attempt");
  }
  const context = value["context"];
  if (!isTaskContext(context) || context.runId !== runId) {
    throw new FatalFailure("Checkpoint context does not match its run id");
  }
  const reworkHistory = value["reworkHistory"];
  if (!Array.isArray(reworkHistory)) {
    throw new FatalFailure("Invalid checkpoint recovery history");
  }
  if (value["budget"] !== undefined && !isRunBudgetSnapshot(value["budget"])) {
    throw new FatalFailure("Invalid checkpoint run budget usage");
  }
  if (value["manifest"] !== undefined && !isRunManifest(value["manifest"])) {
    throw new FatalFailure("Invalid checkpoint run manifest");
  }
  if (
    !reworkHistory.every(
      (item) =>
        isRecord(item) &&
        typeof item["attempt"] === "number" &&
        Number.isSafeInteger(item["attempt"]) &&
        item["attempt"] >= 1 &&
        isRecord(item["gate"]) &&
        (item["gate"]["stage"] === "REVIEW" || item["gate"]["stage"] === "TEST") &&
        typeof item["gate"]["reason"] === "string" &&
        typeof item["gate"]["feedback"] === "string" &&
        typeof item["gate"]["evidence"] === "string",
    )
  ) {
    throw new FatalFailure("Invalid checkpoint rework evidence");
  }
  if (
    value["feedback"] !== undefined &&
    (typeof value["feedback"] !== "string" || value["feedback"].length > 100_000)
  ) {
    throw new FatalFailure("Invalid checkpoint feedback");
  }
  if (typeof value["updatedAt"] !== "string" || !Number.isFinite(Date.parse(value["updatedAt"]))) {
    throw new FatalFailure("Invalid checkpoint timestamp");
  }
  return value as unknown as RunCheckpoint;
}

function isRunBudgetSnapshot(value: unknown): value is RunBudgetSnapshot {
  if (!isRecord(value)) return false;
  return (
    ["llmCalls", "inputTokens", "outputTokens", "estimatedCostUsd", "toolCalls"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
    ) &&
    typeof value["startedAt"] === "string" &&
    Number.isFinite(Date.parse(value["startedAt"])) &&
    typeof value["updatedAt"] === "string" &&
    Number.isFinite(Date.parse(value["updatedAt"]))
  );
}

function isRunManifest(value: unknown): value is RunManifest {
  if (!isRecord(value) || !isRecord(value["promptVersions"])) return false;
  return (
    [
      "requirementHash",
      "acceptanceContractHash",
      "initialHead",
      "provider",
      "model",
      "policyHash",
      "testCommandHash",
      "budgetHash",
    ].every((key) => typeof value[key] === "string") &&
    Object.values(value["promptVersions"]).every((item) => typeof item === "string")
  );
}

function isTaskContext(value: unknown): value is TaskContext {
  if (!isRecord(value)) return false;
  const repo = value["repo"];
  const meta = value["meta"];
  return (
    typeof value["runId"] === "string" &&
    typeof value["requirement"] === "string" &&
    (value["requirementTrust"] === undefined ||
      value["requirementTrust"] === "trusted" ||
      value["requirementTrust"] === "untrusted") &&
    (value["requiredAcceptanceCriteria"] === undefined ||
      (Array.isArray(value["requiredAcceptanceCriteria"]) &&
        value["requiredAcceptanceCriteria"].every(isAcceptanceCriterion))) &&
    isRecord(repo) &&
    typeof repo["path"] === "string" &&
    typeof repo["branch"] === "string" &&
    isPlan(value["plan"]) &&
    (value["architecture"] === null || isRecord(value["architecture"])) &&
    Array.isArray(value["artifacts"]) &&
    Array.isArray(value["gates"]) &&
    isRecord(meta) &&
    isRecord(meta["attempt"]) &&
    typeof meta["attempt"]["stage"] === "string" &&
    typeof meta["attempt"]["count"] === "number" &&
    isRecord(meta["tokenBudget"])
  );
}

function isPlan(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value["objective"] === "string" &&
    Array.isArray(value["steps"]) &&
    Array.isArray(value["acceptanceCriteria"]) &&
    value["acceptanceCriteria"].length > 0 &&
    value["acceptanceCriteria"].every(isAcceptanceCriterion) &&
    typeof value["summary"] === "string"
  );
}

function isAcceptanceCriterion(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const requiredEvidence = value["requiredEvidence"];
  const verifier = value["verifier"];
  return (
    typeof value["id"] === "string" &&
    typeof value["description"] === "string" &&
    Array.isArray(requiredEvidence) &&
    requiredEvidence.every((item) => item === "test" || item === "review") &&
    isRecord(verifier) &&
    (verifier["kind"] === "test-suite" ||
      verifier["kind"] === "test-case" ||
      verifier["kind"] === "file" ||
      verifier["kind"] === "behavior" ||
      verifier["kind"] === "review")
  );
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FatalFailure(`${name} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
