import { createHash } from "node:crypto";
import type { EventLog } from "../core/event-log.js";
import { classifyFailure, errorMessage, StageFailure, throwIfCancelled } from "../core/errors.js";
import { estimateTokens, TokenBudgetTracker } from "../core/token-budget.js";
import type { RunBudgetTracker } from "../core/run-budget.js";
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
import { assemblePromptInput, type ContextSection } from "../context/assembler.js";
import type { ChatCompletion, ChatMessage, ChatProvider } from "../llm/chat-provider.js";
import { supportsStructuredOutput } from "../llm/capabilities.js";
import { loadPrompt, structuredOutputFor } from "../prompts/index.js";
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
  readonly signal?: AbortSignal;
  readonly runBudget?: RunBudgetTracker;
}

export abstract class BaseAgent implements StageAgent {
  public readonly id: StageId;
  public readonly tools: readonly string[];
  protected readonly toolExecutor: ScopedToolExecutor;
  readonly #provider: ChatProvider;
  readonly #model: string;
  readonly #eventLog: EventLog;
  readonly #signal: AbortSignal | undefined;
  readonly #stageBudget: TokenBudgetTracker;
  readonly #runBudget: RunBudgetTracker | undefined;
  #lifecycle: AgentLifecycle = "CREATED";

  protected constructor(options: BaseAgentOptions) {
    this.id = options.id;
    this.tools = Object.freeze([...options.tools]);
    this.#provider = options.provider;
    this.#model = options.model;
    this.#eventLog = options.eventLog;
    this.toolExecutor = options.toolExecutor;
    this.#signal = options.signal;
    this.#stageBudget = new TokenBudgetTracker(options.budget);
    this.#runBudget = options.runBudget;
  }

  public get lifecycle(): AgentLifecycle {
    return this.#lifecycle;
  }

  public async run(input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    if (this.#lifecycle !== "CREATED") {
      throw new StageFailure(`${this.id} agent instance has already run`);
    }
    this.#lifecycle = "RUNNING";
    throwIfCancelled(this.#signal);
    await this.#eventLog.append({
      type: "stage.started",
      data: { runId: ctx.runId, stage: this.id, attempt: input.attempt },
    });
    try {
      const result = await this.execute(input, ctx);
      throwIfCancelled(this.#signal);
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
    sections: readonly ContextSection[],
    promptVariables: Readonly<Record<string, string>> = {},
  ): Promise<Record<string, unknown>> {
    const prompt = await loadPrompt(this.id, promptVariables);
    const promptInput = assemblePromptInput(sections);
    await this.recordContext(ctx, promptInput.sections, promptInput.tokenEstimate);
    const messages: readonly ChatMessage[] = [
      { role: "system", content: prompt.content },
      { role: "user", content: promptInput.content },
    ];
    const estimatedInput = estimateTokens(messages.map((item) => item.content).join("\n"));
    this.#stageBudget.ensureInputFits(estimatedInput);
    const maxOutputTokens = this.#stageBudget.remainingOutput;
    this.#stageBudget.ensureOutputFits(1);
    const runReservation = this.#runBudget?.beforeLlm(estimatedInput, maxOutputTokens);
    const promptFingerprint = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    let completion: ChatCompletion;
    const structured = supportsStructuredOutput(this.#provider);
    try {
      completion = await this.#provider.complete(messages, {
        model: this.#model,
        temperature: 0,
        maxOutputTokens,
        seed: 42,
        ...(structured ? { structuredOutput: structuredOutputFor(this.id) } : {}),
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      });
    } catch (error) {
      if (runReservation !== undefined) {
        this.#runBudget?.failLlm(runReservation, estimatedInput);
      }
      await this.recordLlmCall(
        ctx,
        estimatedInput,
        0,
        promptFingerprint,
        prompt.version,
        structured,
      );
      throw error;
    }
    const inputTokens = completion.usage.inputTokens || estimatedInput;
    const outputTokens = completion.usage.outputTokens || estimateTokens(completion.content);
    await this.recordLlmCall(
      ctx,
      inputTokens,
      outputTokens,
      promptFingerprint,
      prompt.version,
      structured,
    );
    this.#stageBudget.consumeInput(inputTokens);
    this.#stageBudget.consumeOutput(outputTokens);
    if (runReservation !== undefined) {
      this.#runBudget?.settleLlm(runReservation, inputTokens, outputTokens);
    }
    return parseJsonObject(completion.content);
  }

  private async recordLlmCall(
    ctx: TaskContext,
    inputTokens: number,
    outputTokens: number,
    promptFingerprint: string,
    promptVersion: string,
    structuredOutput: boolean,
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
        promptVersion,
        structuredOutput,
      },
    });
  }

  private async recordContext(
    ctx: TaskContext,
    sections: readonly ContextSection[],
    tokenEstimate: number,
  ): Promise<void> {
    await this.#eventLog.append({
      type: "context.assembled",
      data: {
        runId: ctx.runId,
        stage: this.id,
        sections: sections.map((section) => ({
          name: section.name,
          source: section.source,
          trust: section.trust ?? (section.source === "contract" ? "trusted" : "untrusted"),
          tokenEstimate: estimateTokens(section.content),
          references: section.references ?? [],
        })),
        tokenEstimate,
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
                artifactFingerprint: output.gate.artifactFingerprint,
                verificationEvidence: output.gate.verificationEvidence,
                ...(output.gate.coveragePercent === undefined
                  ? {}
                  : { coveragePercent: output.gate.coveragePercent }),
              },
            }
          : {
              type: "gate.rejected",
              data: {
                runId: ctx.runId,
                stage: output.gate.stage,
                reason: output.gate.reason,
                feedback: output.gate.feedback,
                artifactFingerprint: output.gate.artifactFingerprint,
                verificationEvidence: output.gate.verificationEvidence,
                ...(output.gate.coveragePercent === undefined
                  ? {}
                  : { coveragePercent: output.gate.coveragePercent }),
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
