import { createHash } from "node:crypto";
import type { EventLog } from "../core/event-log.js";
import { classifyFailure, errorMessage, StageFailure } from "../core/errors.js";
import { estimateTokens, TokenBudgetTracker } from "../core/token-budget.js";
import type {
  AgentLifecycle,
  ArtifactRef,
  StageAgent,
  StageId,
  StageInput,
  StageOutput,
  TaskContext,
  TokenBudget,
} from "../core/types.js";
import type { ChatCompletion, ChatMessage, ChatProvider } from "../llm/chat-provider.js";
import type { ScopedToolExecutor } from "../tools/executor.js";
import type { ToolResult } from "../tools/types.js";

export interface BaseAgentOptions {
  readonly id: StageId;
  readonly tools: readonly string[];
  readonly provider: ChatProvider;
  readonly model: string;
  readonly eventLog: EventLog;
  readonly toolExecutor: ScopedToolExecutor;
  readonly budget: TokenBudget;
}

export abstract class BaseAgent implements StageAgent {
  public readonly id: StageId;
  public readonly tools: readonly string[];
  protected readonly toolExecutor: ScopedToolExecutor;
  readonly #provider: ChatProvider;
  readonly #model: string;
  readonly #eventLog: EventLog;
  readonly #budget: TokenBudget;
  #lifecycle: AgentLifecycle = "CREATED";

  protected constructor(options: BaseAgentOptions) {
    this.id = options.id;
    this.tools = Object.freeze([...options.tools]);
    this.#provider = options.provider;
    this.#model = options.model;
    this.#eventLog = options.eventLog;
    this.toolExecutor = options.toolExecutor;
    this.#budget = options.budget;
  }

  public get lifecycle(): AgentLifecycle {
    return this.#lifecycle;
  }

  public async run(input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    if (this.#lifecycle !== "CREATED") {
      throw new StageFailure(`${this.id} agent instance has already run`);
    }
    this.#lifecycle = "RUNNING";
    await this.#eventLog.append({
      type: "stage.started",
      data: { runId: ctx.runId, stage: this.id, attempt: input.attempt },
    });
    try {
      const result = await this.execute(input, ctx);
      await this.recordOutput(ctx, result);
      await this.#eventLog.append({
        type: "stage.completed",
        data: { runId: ctx.runId, stage: this.id, status: "SUCCEEDED" },
      });
      this.#lifecycle = "SUCCEEDED";
      return result;
    } catch (error) {
      this.#lifecycle = "FAILED";
      await this.#eventLog.append({
        type: "stage.failed",
        data: {
          runId: ctx.runId,
          stage: this.id,
          kind: classifyFailure(error),
          error: errorMessage(error),
          ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        },
      });
      throw error;
    }
  }

  protected abstract execute(input: StageInput, ctx: TaskContext): Promise<StageOutput>;

  protected async completeJson(
    ctx: TaskContext,
    system: string,
    user: string,
  ): Promise<Record<string, unknown>> {
    const messages: readonly ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const tracker = new TokenBudgetTracker(this.#budget);
    const estimatedInput = estimateTokens(messages.map((item) => item.content).join("\n"));
    tracker.ensureInputFits(estimatedInput);
    const promptFingerprint = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    let completion: ChatCompletion;
    try {
      completion = await this.#provider.complete(messages, {
        model: this.#model,
        temperature: 0,
        maxOutputTokens: this.#budget.output,
        seed: 42,
      });
    } catch (error) {
      await this.recordLlmCall(ctx, estimatedInput, 0, promptFingerprint);
      throw error;
    }
    const inputTokens = completion.usage.inputTokens || estimatedInput;
    const outputTokens = completion.usage.outputTokens || estimateTokens(completion.content);
    await this.recordLlmCall(ctx, inputTokens, outputTokens, promptFingerprint);
    tracker.consumeInput(inputTokens);
    tracker.consumeOutput(outputTokens);
    return parseJsonObject(completion.content);
  }

  private async recordLlmCall(
    ctx: TaskContext,
    inputTokens: number,
    outputTokens: number,
    promptFingerprint: string,
  ): Promise<void> {
    await this.#eventLog.append({
      type: "llm.called",
      data: {
        runId: ctx.runId,
        stage: this.id,
        model: this.#model,
        inputTokens,
        outputTokens,
        promptFingerprint,
      },
    });
  }

  protected async requireTool(name: string, args: unknown): Promise<ToolResult> {
    const result = await this.toolExecutor.execute(name, args);
    if (!result.ok) {
      throw new StageFailure(`${name} failed: ${result.error ?? "unknown error"}`);
    }
    return result;
  }

  private async recordOutput(ctx: TaskContext, output: StageOutput): Promise<void> {
    for (const artifact of outputArtifacts(output)) {
      await this.#eventLog.append({
        type: "artifact.produced",
        data: {
          runId: ctx.runId,
          stage: artifact.stage,
          path: artifact.path,
          kind: artifact.kind,
          summary: artifact.summary,
        },
      });
    }
    if (output.kind === "gate") {
      await this.#eventLog.append(
        output.gate.passed
          ? {
              type: "gate.passed",
              data: {
                runId: ctx.runId,
                stage: output.gate.stage,
                evidence: output.gate.evidence,
              },
            }
          : {
              type: "gate.rejected",
              data: {
                runId: ctx.runId,
                stage: output.gate.stage,
                reason: output.gate.reason,
                feedback: output.gate.feedback,
              },
            },
      );
    }
  }
}

function outputArtifacts(output: StageOutput): readonly ArtifactRef[] {
  switch (output.kind) {
    case "plan":
    case "architecture":
    case "commit":
      return [output.artifact];
    case "code":
      return output.artifacts;
    case "gate":
      return [];
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new StageFailure("Agent response is not a JSON object");
  }
  try {
    const value = JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("JSON root must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new StageFailure("Agent returned invalid JSON", { cause: error });
  }
}
