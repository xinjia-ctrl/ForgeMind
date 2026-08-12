import { errorMessage } from "../core/errors.js";
import { estimateTokens } from "../core/token-budget.js";
import type { ProcessRunner } from "../sandbox/types.js";
import { objectArgs, stringArg } from "./file-tools.js";
import type { Tool, ToolPolicy, ToolResult } from "./types.js";

export class RunCommandTool implements Tool {
  public readonly name = "run_command";
  public readonly description = "Run one exact command allowed by the stage policy";
  public readonly parameters = {
    type: "object",
    required: ["command", "args"],
    properties: {
      command: { type: "string" },
      args: { type: "array", items: { type: "string" } },
    },
  } as const;
  readonly #runner: ProcessRunner;

  public constructor(runner: ProcessRunner) {
    this.#runner = runner;
  }

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const command = stringArg(value, "command");
      const commandArgs = stringArrayArg(value, "args");
      const invocation = [command, ...commandArgs];
      if (!policy.allowsCommand(invocation)) {
        return { ok: false, error: `Command is not allowlisted: ${invocation.join(" ")}` };
      }
      const result = await this.#runner.run(
        { command, args: commandArgs },
        {
          cwd: policy.workspaceRoot,
          timeoutMs: policy.commandTimeoutMs,
          maxBytes: policy.maxResultBytes,
        },
      );
      const succeeded = result.exitCode === 0 && result.timedOut !== true;
      return {
        ok: succeeded,
        data: result,
        ...(succeeded
          ? {}
          : {
              error:
                result.timedOut === true
                  ? `Command timed out after ${policy.commandTimeoutMs}ms`
                  : `Command exited with ${result.exitCode}`,
            }),
        truncated: result.truncated,
        tokenCost: estimateTokens(`${result.stdout}\n${result.stderr}`),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

function stringArrayArg(value: Record<string, unknown>, key: string): string[] {
  const result = value[key];
  if (!Array.isArray(result) || !result.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return result;
}
