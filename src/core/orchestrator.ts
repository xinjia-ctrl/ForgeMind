import {
  classifyFailure,
  errorMessage,
  FatalFailure,
  isCancellation,
  throwIfCancelled,
} from "./errors.js";
import type { AgentFactory } from "./agent-factory.js";
import { withArchitecture, withArtifacts, withAttempt, withGate, withPlan } from "./context.js";
import type { EventLog } from "./event-log.js";
import { evaluateRunQuality } from "../quality/metrics.js";
import { truncateUtf8 } from "./text.js";
import { assertAcceptanceSatisfied } from "./acceptance.js";
import type { RunCheckpoint, RunCheckpointStore, RunPhase } from "./run-checkpoint.js";
import type { RunResult, RunStatus, StageId, TaskContext } from "./types.js";
import type { RunBudgetTracker } from "./run-budget.js";
import { RunStopFailure } from "./run-budget.js";
import { assertResumeManifest, manifestForContext, type RunManifest } from "./run-manifest.js";
import type { RunProfile } from "./run-profile.js";

export const DEFAULT_MAX_REWORK = 6;

const MAX_REWORK_CONTEXT_BYTES = 24_000;

interface OrchestratorOptions {
  readonly eventLog: EventLog;
  readonly agentFactory: AgentFactory;
  readonly maxRework?: number;
  readonly signal?: AbortSignal;
  readonly checkpointStore?: RunCheckpointStore;
  readonly resume?: boolean;
  readonly includeArchitecture?: boolean;
  readonly runBudget?: RunBudgetTracker;
  readonly manifest?: RunManifest;
  readonly profile?: RunProfile;
  readonly profileReason?: string;
}

export class Orchestrator {
  readonly #eventLog: EventLog;
  readonly #agentFactory: AgentFactory;
  readonly #maxRework: number;
  readonly #signal: AbortSignal | undefined;
  readonly #checkpointStore: RunCheckpointStore | undefined;
  readonly #resume: boolean;
  readonly #includeArchitecture: boolean;
  readonly #runBudget: RunBudgetTracker | undefined;
  readonly #manifest: RunManifest | undefined;
  readonly #profile: RunProfile | undefined;
  readonly #profileReason: string | undefined;

  public constructor(options: OrchestratorOptions) {
    this.#eventLog = options.eventLog;
    this.#agentFactory = options.agentFactory;
    this.#maxRework = options.maxRework ?? DEFAULT_MAX_REWORK;
    this.#signal = options.signal;
    this.#checkpointStore = options.checkpointStore;
    this.#resume = options.resume ?? false;
    this.#includeArchitecture = options.includeArchitecture ?? true;
    this.#runBudget = options.runBudget;
    this.#manifest = options.manifest;
    this.#profile = options.profile;
    this.#profileReason = options.profileReason;
    if (!Number.isInteger(this.#maxRework) || this.#maxRework < 0) {
      throw new FatalFailure("maxRework must be a non-negative integer");
    }
  }

  public async run(initialContext: TaskContext): Promise<RunResult> {
    const restored = this.#resume ? await this.#checkpointStore?.load(initialContext.runId) : null;
    if (restored !== undefined && restored !== null) {
      assertResumeContext(initialContext, restored.context);
      if (restored.budget !== undefined) this.#runBudget?.restore(restored.budget);
      if (this.#manifest !== undefined) {
        if (restored.manifest === undefined) {
          throw new FatalFailure("Run checkpoint is missing its runtime manifest");
        }
        assertResumeManifest(this.#manifest, restored.manifest, restored.context);
      }
    }
    let state: OrchestratorState =
      restored === undefined || restored === null
        ? initialState(initialContext)
        : stateFrom(restored);
    if (restored === undefined || restored === null) {
      await this.#eventLog.append({
        type: "run.started",
        data: {
          runId: state.ctx.runId,
          requirement: state.ctx.requirement,
          branch: state.ctx.repo.branch,
          repo: state.ctx.repo.path,
          ...(this.#profile === undefined ? {} : { profile: this.#profile }),
          ...(this.#profileReason === undefined ? {} : { profileReason: this.#profileReason }),
        },
      });
      await this.checkpoint(state);
    } else {
      await this.#eventLog.append({
        type: "run.resumed",
        data: {
          runId: state.ctx.runId,
          phase: state.phase,
          attempt: state.attempt,
        },
      });
    }

    try {
      for (;;) {
        throwIfCancelled(this.#signal);
        switch (state.phase) {
          case "PLAN": {
            const ctx = withAttempt(state.ctx, "PLAN", 1);
            const output = await this.executeStage("PLAN", 1, ctx);
            if (output.kind !== "plan") throw new FatalFailure("PLAN returned wrong output kind");
            const next = withPlan(ctx, output.plan, output.artifact);
            state = {
              ...state,
              ctx: next,
              phase: this.#includeArchitecture ? "ARCH" : "CODE",
              attempt: 1,
            };
            await this.checkpoint(state);
            break;
          }
          case "ARCH": {
            const ctx = withAttempt(state.ctx, "ARCH", 1);
            const output = await this.executeStage("ARCH", 1, ctx);
            if (output.kind !== "architecture") {
              throw new FatalFailure("ARCH returned wrong output kind");
            }
            const next = withArchitecture(ctx, output.architecture, output.artifact);
            state = { ...state, ctx: next, phase: "CODE", attempt: 1 };
            await this.checkpoint(state);
            break;
          }
          case "CODE": {
            const ctx = withAttempt(state.ctx, "CODE", state.attempt);
            const output = await this.executeStage("CODE", state.attempt, ctx, state.feedback);
            if (output.kind !== "code") throw new FatalFailure("CODE returned wrong output kind");
            const next = withArtifacts(ctx, output.artifacts);
            state = { ...state, ctx: next, phase: "TEST" };
            await this.checkpoint(state);
            break;
          }
          case "REVIEW": {
            let ctx = withAttempt(state.ctx, "REVIEW", state.attempt);
            const output = await this.executeStage("REVIEW", state.attempt, ctx);
            if (output.kind !== "gate" || output.gate.stage !== "REVIEW") {
              throw new FatalFailure("REVIEW returned wrong output kind");
            }
            ctx = withGate(ctx, output.gate);
            if (output.gate.passed) {
              assertAcceptanceSatisfied(ctx);
              state = { ...state, ctx, phase: "COMMIT", attempt: 1 };
              await this.checkpoint(state);
              break;
            }
            const history = [...state.reworkHistory, { attempt: state.attempt, gate: output.gate }];
            if (state.attempt > this.#maxRework) {
              return await this.finish(
                ctx,
                "FAILED",
                new RunStopFailure(
                  "MAX_REWORK",
                  `review gate remained rejected after ${state.attempt} attempts`,
                ).message,
              );
            }
            state = {
              ...state,
              ctx,
              phase: "CODE",
              attempt: state.attempt + 1,
              feedback: cumulativeReworkEvidence(history),
              reworkHistory: history,
            };
            await this.checkpoint(state);
            break;
          }
          case "TEST": {
            let ctx = withAttempt(state.ctx, "TEST", state.attempt);
            const output = await this.executeStage("TEST", state.attempt, ctx);
            if (output.kind !== "gate" || output.gate.stage !== "TEST") {
              throw new FatalFailure("TEST returned wrong output kind");
            }
            ctx = withGate(ctx, output.gate);
            if (!output.gate.passed) {
              const history = [
                ...state.reworkHistory,
                { attempt: state.attempt, gate: output.gate },
              ];
              if (state.attempt > this.#maxRework) {
                return await this.finish(
                  ctx,
                  "FAILED",
                  new RunStopFailure(
                    "MAX_REWORK",
                    `test gate remained rejected after ${state.attempt} attempts`,
                  ).message,
                );
              }
              state = {
                ...state,
                ctx,
                phase: "CODE",
                attempt: state.attempt + 1,
                feedback: cumulativeReworkEvidence(history),
                reworkHistory: history,
              };
              await this.checkpoint(state);
              break;
            }
            state = { ...state, ctx, phase: "REVIEW" };
            await this.checkpoint(state);
            break;
          }
          case "COMMIT": {
            const ctx = withAttempt(state.ctx, "COMMIT", 1);
            const output = await this.executeStage("COMMIT", 1, ctx);
            if (output.kind !== "commit") {
              throw new FatalFailure("COMMIT returned wrong output kind");
            }
            const next = withArtifacts(ctx, [output.artifact]);
            return await this.finish(next, "SUCCEEDED", `Created commit ${output.commit}`);
          }
        }
      }
    } catch (error) {
      if (isCancellation(error)) {
        await this.checkpoint(state);
        throw error;
      }
      const status: RunStatus = classifyFailure(error) === "FATAL" ? "BLOCKED" : "FAILED";
      return await this.finish(state.ctx, status, errorMessage(error));
    }
  }

  private async executeStage(stage: StageId, attempt: number, ctx: TaskContext, feedback?: string) {
    const agent = this.#agentFactory.create(stage);
    return await agent.run({ attempt, ...(feedback === undefined ? {} : { feedback }) }, ctx);
  }

  private async checkpoint(state: OrchestratorState): Promise<void> {
    await this.#checkpointStore?.save({
      version: 1,
      runId: state.ctx.runId,
      phase: state.phase,
      attempt: state.attempt,
      context: state.ctx,
      ...(state.feedback === undefined ? {} : { feedback: state.feedback }),
      reworkHistory: state.reworkHistory,
      ...(this.#runBudget === undefined ? {} : { budget: this.#runBudget.snapshot() }),
      ...(this.#manifest === undefined
        ? {}
        : { manifest: manifestForContext(this.#manifest, state.ctx) }),
      updatedAt: new Date().toISOString(),
    });
  }

  private async finish(ctx: TaskContext, status: RunStatus, summary: string): Promise<RunResult> {
    await this.#eventLog.append({
      type: "run.finished",
      data: { runId: ctx.runId, status, summary },
    });
    const quality = evaluateRunQuality(await this.#eventLog.load());
    await this.#eventLog.append({ type: "run.quality", data: quality });
    await this.#checkpointStore?.clear(ctx.runId);
    return { status, context: ctx, summary };
  }
}

function reworkEvidence(gate: {
  readonly stage: "REVIEW" | "TEST";
  readonly reason: string;
  readonly feedback: string;
  readonly evidence: string;
}): string {
  return [
    `${gate.stage} reason: ${gate.reason}`,
    `Required rework: ${gate.feedback}`,
    `Previous evidence: ${gate.evidence}`,
  ].join("\n");
}

interface ReworkRecord {
  readonly attempt: number;
  readonly gate: {
    readonly stage: "REVIEW" | "TEST";
    readonly reason: string;
    readonly feedback: string;
    readonly evidence: string;
  };
}

interface OrchestratorState {
  readonly ctx: TaskContext;
  readonly phase: RunPhase;
  readonly attempt: number;
  readonly feedback?: string;
  readonly reworkHistory: readonly ReworkRecord[];
}

function initialState(ctx: TaskContext): OrchestratorState {
  return {
    ctx,
    phase: "PLAN",
    attempt: 1,
    reworkHistory: [],
  };
}

function stateFrom(checkpoint: RunCheckpoint): OrchestratorState {
  return {
    ctx: checkpoint.context,
    phase: checkpoint.phase,
    attempt: checkpoint.attempt,
    ...(checkpoint.feedback === undefined ? {} : { feedback: checkpoint.feedback }),
    reworkHistory: checkpoint.reworkHistory,
  };
}

function assertResumeContext(requested: TaskContext, restored: TaskContext): void {
  if (
    requested.runId !== restored.runId ||
    requested.requirement !== restored.requirement ||
    requested.repo.path !== restored.repo.path ||
    requested.repo.branch !== restored.repo.branch ||
    JSON.stringify(requested.requiredAcceptanceCriteria ?? []) !==
      JSON.stringify(restored.requiredAcceptanceCriteria ?? [])
  ) {
    throw new FatalFailure("Run checkpoint does not match the requested run context");
  }
}

function cumulativeReworkEvidence(history: readonly ReworkRecord[]): string {
  const header = [
    "Cumulative rework contract (oldest retained issue to newest).",
    "Every item remains required: preserve earlier fixes while resolving the newest rejection.",
  ].join("\n");
  const fixedBytes = Buffer.byteLength(header, "utf8");
  let remainingBytes = Math.max(0, MAX_REWORK_CONTEXT_BYTES - fixedBytes);
  const retained: string[] = [];

  for (let index = history.length - 1; index >= 0 && remainingBytes > 0; index -= 1) {
    const record = history[index];
    if (record === undefined) continue;
    const section = [
      `Attempt ${record.attempt} ${record.gate.stage} rejection:`,
      reworkEvidence(record.gate),
    ].join("\n");
    const separatorBytes = retained.length === 0 ? 0 : 2;
    if (remainingBytes <= separatorBytes) break;
    const bounded = truncateUtf8(section, remainingBytes - separatorBytes);
    retained.unshift(bounded.text);
    remainingBytes -= bounded.bytes + separatorBytes;
    if (bounded.truncated) break;
  }

  return `${header}\n\n${retained.join("\n\n")}`;
}
