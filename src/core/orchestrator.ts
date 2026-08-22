import { classifyFailure, errorMessage, FatalFailure } from "./errors.js";
import type { AgentFactory } from "./agent-factory.js";
import {
  withArchitecture,
  withArtifacts,
  withAttempt,
  withGate,
  withPlan,
  withUpdatedArchitecture,
} from "./context.js";
import type { EventLog } from "./event-log.js";
import type { MemoryProvider } from "../memory/memory-provider.js";
import { persistDecisionRecord } from "../negotiation/record.js";
import {
  detectArchitectureConflict,
  detectRepeatedReviewRejection,
} from "../negotiation/triggers.js";
import type {
  DecisionRecord,
  NegotiationCoordinator,
  NegotiationEvidence,
} from "../negotiation/types.js";
import { evaluateRunQuality } from "../quality/metrics.js";
import type { ArtifactRef, RunResult, RunStatus, StageId, TaskContext } from "./types.js";

interface OrchestratorOptions {
  readonly eventLog: EventLog;
  readonly agentFactory: AgentFactory;
  readonly memory: MemoryProvider;
  readonly maxRework?: number;
  readonly actor?: { readonly id: string };
  readonly negotiation?: NegotiationCoordinator;
  readonly reviewNegotiationThreshold?: number;
}

export class Orchestrator {
  readonly #eventLog: EventLog;
  readonly #agentFactory: AgentFactory;
  readonly #memory: MemoryProvider;
  readonly #maxRework: number;
  readonly #actor: { readonly id: string } | undefined;
  readonly #negotiation: NegotiationCoordinator | undefined;
  readonly #reviewNegotiationThreshold: number;

  public constructor(options: OrchestratorOptions) {
    this.#eventLog = options.eventLog;
    this.#agentFactory = options.agentFactory;
    this.#memory = options.memory;
    this.#maxRework = options.maxRework ?? 3;
    this.#actor = options.actor;
    this.#negotiation = options.negotiation;
    this.#reviewNegotiationThreshold = options.reviewNegotiationThreshold ?? 2;
    if (!Number.isInteger(this.#maxRework) || this.#maxRework < 0) {
      throw new FatalFailure("maxRework must be a non-negative integer");
    }
    if (
      !Number.isInteger(this.#reviewNegotiationThreshold) ||
      this.#reviewNegotiationThreshold < 2
    ) {
      throw new FatalFailure("reviewNegotiationThreshold must be an integer of at least 2");
    }
  }

  public async run(initialContext: TaskContext): Promise<RunResult> {
    let ctx = initialContext;
    await this.#eventLog.append({
      type: "run.started",
      data: {
        runId: ctx.runId,
        requirement: ctx.requirement,
        branch: ctx.repo.branch,
        repo: ctx.repo.path,
        ...(this.#actor === undefined ? {} : { actor: this.#actor.id }),
      },
    });

    try {
      ctx = withAttempt(ctx, "PLAN", 1);
      const planOutput = await this.executeStage("PLAN", 1, ctx);
      if (planOutput.kind !== "plan") throw new FatalFailure("PLAN returned wrong output kind");
      ctx = withPlan(ctx, planOutput.plan, planOutput.artifact);
      await this.remember(ctx, [planOutput.artifact]);

      ctx = withAttempt(ctx, "ARCH", 1);
      const architectureOutput = await this.executeStage("ARCH", 1, ctx);
      if (architectureOutput.kind !== "architecture") {
        throw new FatalFailure("ARCH returned wrong output kind");
      }
      ctx = withArchitecture(ctx, architectureOutput.architecture, architectureOutput.artifact);
      const architectureConflict = detectArchitectureConflict(architectureOutput.architecture);
      if (architectureConflict !== null && this.#negotiation !== undefined) {
        const record = await this.negotiate(ctx, architectureConflict);
        if (record === null) {
          return await this.finish(ctx, "FAILED", "Architecture negotiation was not approved");
        }
        ctx = withUpdatedArchitecture(ctx, applyArchitectureDecision(ctx, record));
      }
      await this.remember(ctx, [architectureOutput.artifact]);

      let feedback: string | undefined;
      let reviewNegotiated = false;
      for (let attempt = 1; attempt <= this.#maxRework + 1; attempt += 1) {
        ctx = withAttempt(ctx, "CODE", attempt);
        const codeOutput = await this.executeStage("CODE", attempt, ctx, feedback);
        if (codeOutput.kind !== "code") {
          throw new FatalFailure("CODE returned wrong output kind");
        }
        ctx = withArtifacts(ctx, codeOutput.artifacts);
        await this.remember(ctx, codeOutput.artifacts);

        ctx = withAttempt(ctx, "REVIEW", attempt);
        const reviewOutput = await this.executeStage("REVIEW", attempt, ctx);
        if (reviewOutput.kind !== "gate" || reviewOutput.gate.stage !== "REVIEW") {
          throw new FatalFailure("REVIEW returned wrong output kind");
        }
        ctx = withGate(ctx, reviewOutput.gate);
        await this.#memory.rememberGate?.(ctx, reviewOutput.gate);
        if (!reviewOutput.gate.passed) {
          if (attempt > this.#maxRework) {
            return await this.finish(
              ctx,
              "FAILED",
              `Review gate remained rejected after ${attempt} attempts`,
            );
          }
          const repeatedRejection = detectRepeatedReviewRejection(
            ctx,
            this.#reviewNegotiationThreshold,
          );
          if (repeatedRejection !== null && this.#negotiation !== undefined && !reviewNegotiated) {
            reviewNegotiated = true;
            const record = await this.negotiate(ctx, repeatedRejection);
            if (record === null) {
              return await this.finish(ctx, "FAILED", "Review negotiation was not approved");
            }
            feedback = `${reworkEvidence(reviewOutput.gate)}\nNegotiated decision: ${record.decision}`;
          } else {
            feedback = reworkEvidence(reviewOutput.gate);
          }
          continue;
        }

        ctx = withAttempt(ctx, "TEST", attempt);
        const testOutput = await this.executeStage("TEST", attempt, ctx);
        if (testOutput.kind !== "gate" || testOutput.gate.stage !== "TEST") {
          throw new FatalFailure("TEST returned wrong output kind");
        }
        ctx = withGate(ctx, testOutput.gate);
        await this.#memory.rememberGate?.(ctx, testOutput.gate);
        if (!testOutput.gate.passed) {
          if (attempt > this.#maxRework) {
            return await this.finish(
              ctx,
              "FAILED",
              `Test gate remained rejected after ${attempt} attempts`,
            );
          }
          feedback = reworkEvidence(testOutput.gate);
          continue;
        }

        ctx = withAttempt(ctx, "COMMIT", 1);
        const commitOutput = await this.executeStage("COMMIT", 1, ctx);
        if (commitOutput.kind !== "commit") {
          throw new FatalFailure("COMMIT returned wrong output kind");
        }
        ctx = withArtifacts(ctx, [commitOutput.artifact]);
        await this.remember(ctx, [commitOutput.artifact]);
        return await this.finish(ctx, "SUCCEEDED", `Created commit ${commitOutput.commit}`);
      }
      throw new FatalFailure("Unreachable orchestrator state");
    } catch (error) {
      const status: RunStatus = classifyFailure(error) === "FATAL" ? "BLOCKED" : "FAILED";
      return await this.finish(ctx, status, errorMessage(error));
    }
  }

  private async executeStage(stage: StageId, attempt: number, ctx: TaskContext, feedback?: string) {
    const agent = this.#agentFactory.create(stage);
    return await agent.run({ attempt, ...(feedback === undefined ? {} : { feedback }) }, ctx);
  }

  private async remember(ctx: TaskContext, artifacts: readonly ArtifactRef[]): Promise<void> {
    for (const artifact of artifacts) await this.#memory.remember(ctx, artifact);
  }

  private async negotiate(
    ctx: TaskContext,
    evidence: NegotiationEvidence,
  ): Promise<DecisionRecord | null> {
    if (this.#negotiation === undefined) return null;
    const negotiation = await this.#negotiation.negotiate({
      runId: ctx.runId,
      ...evidence,
    });
    if (negotiation.decisionRecord !== null) {
      await persistDecisionRecord(this.#memory, negotiation.decisionRecord);
    }
    return negotiation.decisionRecord;
  }

  private async finish(ctx: TaskContext, status: RunStatus, summary: string): Promise<RunResult> {
    await this.#eventLog.append({
      type: "run.finished",
      data: { runId: ctx.runId, status, summary },
    });
    const quality = evaluateRunQuality(await this.#eventLog.load());
    await this.#eventLog.append({ type: "run.quality", data: quality });
    await this.#memory.rememberQuality?.(quality);
    return { status, context: ctx, summary };
  }
}

function applyArchitectureDecision(ctx: TaskContext, record: DecisionRecord) {
  if (ctx.architecture === null) throw new FatalFailure("Architecture decision is missing");
  return {
    ...ctx.architecture,
    decisions: [...ctx.architecture.decisions, `Negotiated: ${record.decision}`],
    summary: `${ctx.architecture.summary} Negotiated decision: ${record.decision}`,
  };
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
