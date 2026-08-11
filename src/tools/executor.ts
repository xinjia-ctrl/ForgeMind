import type { EventLog } from "../core/event-log.js";
import type { StageId } from "../core/types.js";
import type { Tool, ToolPolicy, ToolResult } from "./types.js";

export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, Tool>;

  public constructor(tools: readonly Tool[]) {
    const entries = tools.map((tool) => [tool.name, tool] as const);
    if (new Set(entries.map(([name]) => name)).size !== entries.length) {
      throw new Error("Tool names must be unique");
    }
    this.#tools = new Map(entries);
  }

  public get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }
}

interface ScopedExecutorOptions {
  readonly registry: ToolRegistry;
  readonly eventLog: EventLog;
  readonly runId: string;
  readonly stage: StageId;
  readonly agentTools: readonly string[];
  readonly policy: ToolPolicy;
}

export class ScopedToolExecutor {
  readonly #options: ScopedExecutorOptions;

  public constructor(options: ScopedExecutorOptions) {
    this.#options = options;
  }

  public async execute(name: string, args: unknown): Promise<ToolResult> {
    let result: ToolResult;
    const tool = this.#options.registry.get(name);
    if (tool === undefined) {
      result = { ok: false, error: `Unknown tool: ${name}` };
    } else if (
      !this.#options.agentTools.includes(name) ||
      !this.#options.policy.allowedTools.has(name)
    ) {
      result = {
        ok: false,
        error: `Tool ${name} is not allowed during ${this.#options.stage}`,
      };
    } else {
      try {
        result = await tool.execute(args, this.#options.policy);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    await this.#options.eventLog.append({
      type: "tool.called",
      data: {
        runId: this.#options.runId,
        stage: this.#options.stage,
        tool: name,
        args: auditValue(args),
        result: auditValue(result),
        policy: this.#options.policy.describe(),
      },
    });
    return result;
  }
}

function auditValue(value: unknown, key = ""): unknown {
  if (/content|token|secret|password|api.?key/i.test(key)) {
    if (typeof value === "string") return `<redacted:${Buffer.byteLength(value)} bytes>`;
  }
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}<truncated>` : value;
  }
  if (Array.isArray(value)) return value.map((item) => auditValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, auditValue(child, childKey)]),
    );
  }
  return value;
}
