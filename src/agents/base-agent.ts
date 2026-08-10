import { createHash } from "node:crypto";
import type { EventLog } from "../core/event-log.js";
import { StageFailure } from "../core/errors.js";
import { estimateTokens, TokenBudgetTracker } from "../core/token-budget.js";
import type {
  AgentLifecycle,
  StageAgent,
  StageId,
  StageInput,
  StageOutput,
  TaskContext,
  TokenBudget,
} from "../core/types.js";
import type { ChatMessage, ChatProvider } from "../llm/chat-provider.js";
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
    try {
      const result = await this.execute(input, ctx);
      this.#lifecycle = "SUCCEEDED";
      return result;
    } catch (error) {
      this.#lifecycle = "FAILED";
      throw error;
    }
  }

  protected abstract execute(
    input: StageInput,
    ctx: TaskContext,
  ): Promise<StageOutput>;

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
    const completion = await this.#provider.complete(messages, {
      model: this.#model,
      temperature: 0,
      maxOutputTokens: this.#budget.output,
      seed: 42,
    });
    const inputTokens = completion.usage.inputTokens || estimatedInput;
    const outputTokens = completion.usage.outputTokens || estimateTokens(completion.content);
    tracker.consumeInput(inputTokens);
    tracker.consumeOutput(outputTokens);

    await this.#eventLog.append({
      type: "llm.called",
      data: {
        runId: ctx.runId,
        stage: this.id,
        model: this.#model,
        inputTokens,
        outputTokens,
        promptFingerprint: createHash("sha256")
          .update(JSON.stringify(messages))
          .digest("hex"),
      },
    });
    return parseJsonObject(completion.content);
  }

  protected async requireTool(name: string, args: unknown): Promise<ToolResult> {
    const result = await this.toolExecutor.execute(name, args);
    if (!result.ok) {
      throw new StageFailure(`${name} failed: ${result.error ?? "unknown error"}`);
    }
    return result;
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
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
