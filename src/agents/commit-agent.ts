import { StageFailure } from "../core/errors.js";
import type {
  ArtifactRef,
  StageInput,
  StageOutput,
  TaskContext,
} from "../core/types.js";
import type { ToolResult } from "../tools/types.js";
import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";
import { diffFingerprint } from "./review-agent.js";

export const COMMIT_TOOLS = ["git_status", "git_diff", "git_commit"] as const;

export class CommitAgent extends BaseAgent {
  public constructor(options: Omit<BaseAgentOptions, "id" | "tools">) {
    super({ ...options, id: "COMMIT", tools: COMMIT_TOOLS });
  }

  protected async execute(
    _input: StageInput,
    ctx: TaskContext,
  ): Promise<StageOutput> {
    const review = [...ctx.gates].reverse().find((gate) => gate.stage === "REVIEW");
    const test = [...ctx.gates].reverse().find((gate) => gate.stage === "TEST");
    if (review?.passed !== true || test?.passed !== true) {
      throw new StageFailure("COMMIT requires passing REVIEW and TEST gates");
    }
    const reviewedFingerprint = /^diff-sha256:([a-f0-9]{64});/.exec(
      review.evidence,
    )?.[1];
    if (reviewedFingerprint === undefined) {
      throw new StageFailure("REVIEW evidence is missing the diff fingerprint");
    }
    const currentDiff = extractDiff(await this.requireTool("git_diff", {}));
    if (diffFingerprint(currentDiff) !== reviewedFingerprint) {
      throw new StageFailure(
        "Workspace changed after review; a new review and test cycle is required",
      );
    }
    const objective = ctx.plan?.objective ?? ctx.requirement;
    const message = `feat: ${objective.replace(/\s+/g, " ").slice(0, 72)}`;
    const result = await this.requireTool("git_commit", { message });
    const commit = extractCommit(result);
    const artifact: ArtifactRef = {
      path: commit,
      kind: "commit",
      stage: "COMMIT",
      summary: message,
    };
    return { kind: "commit", commit, artifact };
  }
}

function extractDiff(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("diff" in data)) {
    throw new StageFailure("git_diff did not return diff content");
  }
  if (typeof data.diff !== "string") {
    throw new StageFailure("git_diff returned invalid diff content");
  }
  return data.diff;
}

function extractCommit(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("commit" in data)) {
    throw new StageFailure("git_commit did not return a revision");
  }
  if (typeof data.commit !== "string" || data.commit.length === 0) {
    throw new StageFailure("git_commit returned an invalid revision");
  }
  return data.commit;
}
