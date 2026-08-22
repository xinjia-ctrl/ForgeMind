import type { GateResult, StageInput, StageOutput, TaskContext } from "../core/types.js";
import type { ToolResult } from "../tools/types.js";
import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";

export const TEST_TOOLS = ["run_command"] as const;

export class TestAgent extends BaseAgent {
  readonly #testCommand: readonly string[];

  public constructor(
    options: Omit<BaseAgentOptions, "id" | "tools"> & {
      readonly testCommand: readonly string[];
    },
  ) {
    super({ ...options, id: "TEST", tools: TEST_TOOLS });
    this.#testCommand = options.testCommand;
  }

  protected async execute(input: StageInput, _ctx: TaskContext): Promise<StageOutput> {
    const [command, ...args] = this.#testCommand;
    if (command === undefined) throw new Error("Test command cannot be empty");
    const result = await this.toolExecutor.execute("run_command", { command, args });
    const output = processOutput(result).slice(-4_000);
    const coveragePercent = extractCoveragePercent(output);
    const gate: GateResult = {
      stage: "TEST",
      attempt: input.attempt,
      passed: result.ok,
      reason: result.ok ? "Configured test command passed" : "Configured test command failed",
      feedback: result.ok
        ? "No test rework required."
        : `Fix the failing tests or implementation. Test output:\n${output}`,
      evidence: `${this.#testCommand.join(" ")}\n${output}`,
      ...(coveragePercent === null ? {} : { coveragePercent }),
    };
    return { kind: "gate", gate };
  }
}

export function extractCoveragePercent(output: string): number | null {
  const matches = [...output.matchAll(/(?:^|\s)FORGEMIND_COVERAGE\s*=\s*(\d+(?:\.\d+)?)(?=\s|$)/g)];
  const value = matches.at(-1)?.[1];
  if (value === undefined) return null;
  const coverage = Number(value);
  return Number.isFinite(coverage) && coverage >= 0 && coverage <= 100 ? coverage : null;
}

function processOutput(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null) return result.error ?? "";
  const stdout = "stdout" in data && typeof data.stdout === "string" ? data.stdout : "";
  const stderr = "stderr" in data && typeof data.stderr === "string" ? data.stderr : "";
  return `${stdout}\n${stderr}`.trim();
}
