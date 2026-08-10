import type {
  GateResult,
  StageInput,
  StageOutput,
  TaskContext,
} from "../core/types.js";
import type { ToolResult } from "../tools/types.js";
import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";
import { requiredBoolean, requiredString } from "./validation.js";

export const REVIEW_TOOLS = ["git_status", "git_diff"] as const;

export class ReviewAgent extends BaseAgent {
  public constructor(options: Omit<BaseAgentOptions, "id" | "tools">) {
    super({ ...options, id: "REVIEW", tools: REVIEW_TOOLS });
  }

  protected async execute(
    input: StageInput,
    ctx: TaskContext,
  ): Promise<StageOutput> {
    const diffResult = await this.requireTool("git_diff", {});
    const diff = extractDiff(diffResult);
    if (diffResult.truncated === true) {
      return {
        kind: "gate",
        gate: {
          stage: "REVIEW",
          attempt: input.attempt,
          passed: false,
          reason: "Diff exceeds the bounded review context",
          feedback: "Split or reduce the change so the complete diff can be reviewed safely.",
          evidence: "git diff was truncated",
        },
      };
    }
    if (diff.trim().length === 0) {
      return {
        kind: "gate",
        gate: {
          stage: "REVIEW",
          attempt: input.attempt,
          passed: false,
          reason: "No code diff was produced",
          feedback: "Implement the requested code and tests before review.",
          evidence: "git diff was empty",
        },
      };
    }
    const response = await this.completeJson(
      ctx,
      [
        "You are ForgeMind's read-only code reviewer.",
        "Check correctness, security, maintainability, architectural consistency, and meaningful test coverage.",
        "Reject any material defect. Return JSON only with approved:boolean, reason, feedback, evidence.",
        "Feedback must be concrete and directly actionable.",
      ].join(" "),
      `Requirement: ${ctx.requirement}\nPlan: ${ctx.plan?.summary ?? "missing"}\nArchitecture: ${ctx.architecture?.summary ?? "missing"}\nDiff (possibly truncated):\n${diff}`,
    );
    const approved = requiredBoolean(response, "approved");
    const fingerprint = diffFingerprint(diff);
    const gate: GateResult = {
      stage: "REVIEW",
      attempt: input.attempt,
      passed: approved,
      reason: requiredString(response, "reason"),
      feedback: requiredString(response, "feedback"),
      evidence: `diff-sha256:${fingerprint}; ${requiredString(response, "evidence")}`,
    };
    return { kind: "gate", gate };
  }
}

export function diffFingerprint(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

function extractDiff(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("diff" in data)) return "";
  return typeof data.diff === "string" ? data.diff : "";
}
import { createHash } from "node:crypto";
