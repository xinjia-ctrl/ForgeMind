import { requiredCriteriaForStage } from "../core/acceptance.js";
import { StageFailure } from "../core/errors.js";
import type { GateResult, StageInput, StageOutput, TaskContext } from "../core/types.js";
import { workspaceFingerprint } from "../core/workspace-fingerprint.js";
import type { ToolResult } from "../tools/types.js";
import type { AcceptanceVerifierRegistry } from "../verification/acceptance-verifier.js";
import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";

export const TEST_TOOLS = ["run_command", "git_diff"] as const;

/** Deterministic acceptance gate. It never calls the chat provider. */
export class TestGate extends BaseAgent {
  readonly #testCommand: readonly string[];
  readonly #verifiers: AcceptanceVerifierRegistry;

  public constructor(
    options: Omit<BaseAgentOptions, "id" | "tools"> & {
      readonly testCommand: readonly string[];
      readonly verifiers: AcceptanceVerifierRegistry;
    },
  ) {
    super({ ...options, id: "TEST", tools: TEST_TOOLS });
    this.#testCommand = options.testCommand;
    this.#verifiers = options.verifiers;
  }

  protected async execute(input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    if (ctx.plan === null) throw new StageFailure("TEST requires a completed acceptance contract");
    const before = workspaceFingerprint(extractDiff(await this.requireTool("git_diff", {})));
    const commandResults = new Map<string, Promise<ToolResult>>();
    const runCommand = async (command: readonly string[]): Promise<ToolResult> => {
      const key = JSON.stringify(command);
      let pending = commandResults.get(key);
      if (pending === undefined) {
        const [executable, ...args] = command;
        if (executable === undefined) throw new StageFailure("Verifier command cannot be empty");
        pending = this.toolExecutor.execute("run_command", { command: executable, args });
        commandResults.set(key, pending);
      }
      return await pending;
    };
    const primaryResult = await runCommand(this.#testCommand);
    const initialEvidence = await this.#verifiers.verify(
      requiredCriteriaForStage(ctx.plan.acceptanceCriteria, "TEST"),
      before,
      runCommand,
    );
    const after = workspaceFingerprint(extractDiff(await this.requireTool("git_diff", {})));
    const workspaceStable = before === after;
    const verificationEvidence = initialEvidence.map((item) => ({
      ...item,
      artifactFingerprint: after,
      ...(workspaceStable
        ? {}
        : {
            passed: false,
            details: `${item.details}; test execution changed the workspace fingerprint`,
          }),
    }));
    const output = processOutput(primaryResult).slice(-4_000);
    const coveragePercent = extractCoveragePercent(output);
    const criteriaPassed = verificationEvidence.every((item) => item.passed);
    const passed = primaryResult.ok && criteriaPassed && workspaceStable;
    const gate: GateResult = {
      stage: "TEST",
      attempt: input.attempt,
      passed,
      reason: passed
        ? "Configured test command and all deterministic acceptance verifiers passed"
        : !primaryResult.ok
          ? "Configured test command failed"
          : !workspaceStable
            ? "Test execution changed the workspace"
            : "One or more acceptance verifiers failed",
      feedback: passed
        ? "No test rework required."
        : renderFailureFeedback(primaryResult, verificationEvidence, workspaceStable, output),
      evidence: `diff-sha256:${after}; command:${this.#testCommand.join(" ")}; ok=${primaryResult.ok}\n${output}`,
      artifactFingerprint: after,
      verificationEvidence,
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

function renderFailureFeedback(
  primaryResult: ToolResult,
  evidence: GateResult["verificationEvidence"],
  workspaceStable: boolean,
  output: string,
): string {
  const failures = evidence
    .filter((item) => !item.passed)
    .map((item) => `${item.criterionId} (${item.verifierKind}): ${item.details}`);
  return [
    ...(primaryResult.ok ? [] : [`Fix the failing test command. Output:\n${output}`]),
    ...(workspaceStable
      ? []
      : ["Tests modified tracked or untracked source files; make tests hermetic."]),
    ...failures,
  ].join("\n");
}

function extractDiff(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("diff" in data)) {
    throw new StageFailure("git_diff did not return diff content");
  }
  if (typeof data.diff !== "string") throw new StageFailure("git_diff returned invalid content");
  return data.diff;
}

function processOutput(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null) return result.error ?? "";
  const stdout = "stdout" in data && typeof data.stdout === "string" ? data.stdout : "";
  const stderr = "stderr" in data && typeof data.stderr === "string" ? data.stderr : "";
  return `${stdout}\n${stderr}`.trim();
}
