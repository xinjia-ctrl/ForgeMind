import { StageFailure } from "./errors.js";

export interface RunBudget {
  readonly maxLlmCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxEstimatedCostUsd?: number;
  readonly maxDurationMs: number;
  readonly maxToolCalls: number;
}

export interface RunBudgetSnapshot {
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly toolCalls: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface LlmBudgetReservation {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

export type RunStopReason =
  "BUDGET_EXHAUSTED" | "NO_PROGRESS" | "MAX_REWORK" | "MAX_TOOL_FAILURES" | "MAX_STEPS" | "TIMEOUT";

export class RunStopFailure extends StageFailure {
  public constructor(
    public readonly stopReason: RunStopReason,
    message: string,
  ) {
    super(`${stopReason}: ${message}`);
  }
}

export const DEFAULT_RUN_BUDGET: RunBudget = Object.freeze({
  maxLlmCalls: 40,
  maxInputTokens: 240_000,
  maxOutputTokens: 64_000,
  maxDurationMs: 30 * 60 * 1_000,
  maxToolCalls: 500,
});

export class RunBudgetTracker {
  readonly #budget: RunBudget;
  #llmCalls = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #estimatedCostUsd = 0;
  #toolCalls = 0;
  #startedAt = new Date();

  public constructor(budget: RunBudget = DEFAULT_RUN_BUDGET) {
    assertBudget(budget);
    this.#budget = Object.freeze({ ...budget });
  }

  public get budget(): RunBudget {
    return this.#budget;
  }

  public beforeLlm(estimatedInputTokens: number, requestedOutputTokens = 0): LlmBudgetReservation {
    this.ensureActive();
    assertUsage(estimatedInputTokens, "estimated input tokens");
    assertUsage(requestedOutputTokens, "requested output tokens");
    if (this.#llmCalls + 1 > this.#budget.maxLlmCalls) {
      exhausted(`LLM call limit would exceed ${this.#budget.maxLlmCalls}`);
    }
    if (this.#inputTokens + estimatedInputTokens > this.#budget.maxInputTokens) {
      exhausted(`input token limit would exceed ${this.#budget.maxInputTokens}`);
    }
    if (this.#outputTokens + requestedOutputTokens > this.#budget.maxOutputTokens) {
      exhausted(`output token reservation would exceed ${this.#budget.maxOutputTokens}`);
    }
    const estimatedCostUsd = estimateCost(estimatedInputTokens, requestedOutputTokens);
    if (
      this.#budget.maxEstimatedCostUsd !== undefined &&
      this.#estimatedCostUsd + estimatedCostUsd > this.#budget.maxEstimatedCostUsd
    ) {
      exhausted(`estimated cost reservation would exceed $${this.#budget.maxEstimatedCostUsd}`);
    }
    this.#llmCalls += 1;
    this.#inputTokens += estimatedInputTokens;
    this.#outputTokens += requestedOutputTokens;
    this.#estimatedCostUsd += estimatedCostUsd;
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: requestedOutputTokens,
      estimatedCostUsd,
    };
  }

  public settleLlm(
    reservation: LlmBudgetReservation,
    inputTokens: number,
    outputTokens: number,
  ): void {
    this.ensureActive();
    this.applyLlmSettlement(reservation, inputTokens, outputTokens);
  }

  public failLlm(reservation: LlmBudgetReservation, inputTokens = reservation.inputTokens): void {
    this.applyLlmSettlement(reservation, inputTokens, 0);
  }

  private applyLlmSettlement(
    reservation: LlmBudgetReservation,
    inputTokens: number,
    outputTokens: number,
  ): void {
    assertReservation(reservation);
    assertUsage(inputTokens, "input tokens");
    assertUsage(outputTokens, "output tokens");
    const nextInput = this.#inputTokens - reservation.inputTokens + inputTokens;
    const nextOutput = this.#outputTokens - reservation.outputTokens + outputTokens;
    if (nextInput > this.#budget.maxInputTokens) {
      exhausted(`input token limit exceeded (${nextInput}/${this.#budget.maxInputTokens})`);
    }
    if (nextOutput > this.#budget.maxOutputTokens) {
      exhausted(`output token limit exceeded (${nextOutput}/${this.#budget.maxOutputTokens})`);
    }
    const estimatedCostUsd = estimateCost(inputTokens, outputTokens);
    const nextCost = this.#estimatedCostUsd - reservation.estimatedCostUsd + estimatedCostUsd;
    if (
      this.#budget.maxEstimatedCostUsd !== undefined &&
      nextCost > this.#budget.maxEstimatedCostUsd
    ) {
      exhausted(
        `estimated cost limit exceeded ($${nextCost.toFixed(6)}/$${this.#budget.maxEstimatedCostUsd})`,
      );
    }
    this.#inputTokens = nextInput;
    this.#outputTokens = nextOutput;
    this.#estimatedCostUsd = nextCost;
  }

  public consumeToolCall(): void {
    this.ensureActive();
    if (this.#toolCalls + 1 > this.#budget.maxToolCalls) {
      exhausted(`tool call limit would exceed ${this.#budget.maxToolCalls}`);
    }
    this.#toolCalls += 1;
  }

  public ensureActive(): void {
    if (Date.now() - this.#startedAt.getTime() > this.#budget.maxDurationMs) {
      throw new RunStopFailure("TIMEOUT", `run exceeded ${this.#budget.maxDurationMs}ms`);
    }
  }

  public restore(snapshot: RunBudgetSnapshot): void {
    if (this.#llmCalls !== 0 || this.#toolCalls !== 0) {
      throw new RunStopFailure("BUDGET_EXHAUSTED", "cannot restore over non-empty usage");
    }
    assertSnapshot(snapshot);
    this.#llmCalls = snapshot.llmCalls;
    this.#inputTokens = snapshot.inputTokens;
    this.#outputTokens = snapshot.outputTokens;
    this.#estimatedCostUsd = snapshot.estimatedCostUsd;
    this.#toolCalls = snapshot.toolCalls;
    this.#startedAt = new Date(snapshot.startedAt);
    this.ensureWithinLimits();
  }

  public snapshot(): RunBudgetSnapshot {
    return {
      llmCalls: this.#llmCalls,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      estimatedCostUsd: Number(this.#estimatedCostUsd.toFixed(9)),
      toolCalls: this.#toolCalls,
      startedAt: this.#startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private ensureWithinLimits(): void {
    if (
      this.#llmCalls > this.#budget.maxLlmCalls ||
      this.#inputTokens > this.#budget.maxInputTokens ||
      this.#outputTokens > this.#budget.maxOutputTokens ||
      this.#toolCalls > this.#budget.maxToolCalls ||
      (this.#budget.maxEstimatedCostUsd !== undefined &&
        this.#estimatedCostUsd > this.#budget.maxEstimatedCostUsd)
    ) {
      exhausted("restored usage exceeds the configured run budget");
    }
    this.ensureActive();
  }
}

function exhausted(message: string): never {
  throw new RunStopFailure("BUDGET_EXHAUSTED", message);
}

function assertBudget(budget: RunBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new StageFailure(`Run budget ${name} must be positive`);
    }
  }
  for (const name of [
    "maxLlmCalls",
    "maxInputTokens",
    "maxOutputTokens",
    "maxDurationMs",
    "maxToolCalls",
  ] as const) {
    if (!Number.isSafeInteger(budget[name])) {
      throw new StageFailure(`Run budget ${name} must be a positive safe integer`);
    }
  }
}

function assertUsage(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new StageFailure(`Invalid ${name}: ${value}`);
}

function assertReservation(reservation: LlmBudgetReservation): void {
  assertUsage(reservation.inputTokens, "reserved input tokens");
  assertUsage(reservation.outputTokens, "reserved output tokens");
  assertUsage(reservation.estimatedCostUsd, "reserved estimated cost");
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return inputTokens / 1_000_000 + (outputTokens * 4) / 1_000_000;
}

function assertSnapshot(snapshot: RunBudgetSnapshot): void {
  for (const value of [
    snapshot.llmCalls,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.estimatedCostUsd,
    snapshot.toolCalls,
  ]) {
    if (!Number.isFinite(value) || value < 0) throw new StageFailure("Invalid run budget snapshot");
  }
  if (!Number.isFinite(Date.parse(snapshot.startedAt))) {
    throw new StageFailure("Invalid run budget start time");
  }
}
