import {
  failedVerificationEvidence,
  renderAcceptanceContract,
  requiredCriteriaForStage,
} from "../core/acceptance.js";
import { StageFailure } from "../core/errors.js";
import type {
  GateResult,
  StageInput,
  StageOutput,
  TaskContext,
  VerificationEvidence,
} from "../core/types.js";
import { workspaceFingerprint } from "../core/workspace-fingerprint.js";
import type { ToolResult } from "../tools/types.js";
import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";
import { objectArray, requiredBoolean, requiredString } from "./validation.js";

export const REVIEW_TOOLS = ["git_status", "git_diff"] as const;

export class ReviewAgent extends BaseAgent {
  public constructor(options: Omit<BaseAgentOptions, "id" | "tools">) {
    super({ ...options, id: "REVIEW", tools: REVIEW_TOOLS });
  }

  protected async execute(input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    const diffResult = await this.requireTool("git_diff", {});
    const diff = extractDiff(diffResult);
    const fingerprint = workspaceFingerprint(diff);
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
          artifactFingerprint: fingerprint,
          verificationEvidence: failedVerificationEvidence(
            ctx.plan?.acceptanceCriteria ?? [],
            "REVIEW",
            fingerprint,
            "The complete diff was not available for review",
          ),
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
          artifactFingerprint: fingerprint,
          verificationEvidence: failedVerificationEvidence(
            ctx.plan?.acceptanceCriteria ?? [],
            "REVIEW",
            fingerprint,
            "No implementation diff was available",
          ),
        },
      };
    }
    const response = await this.completeJson(ctx, [
      {
        name: "Requirement",
        content: ctx.requirement,
        source: "contract",
        trust: ctx.requirementTrust ?? "trusted",
      },
      {
        name: "Plan",
        content: ctx.plan?.summary ?? "missing",
        source: "contract",
        trust: "untrusted",
      },
      {
        name: "Acceptance contract",
        content: renderAcceptanceContract(ctx.plan?.acceptanceCriteria ?? []),
        source: "contract",
        trust: "untrusted",
      },
      {
        name: "Architecture",
        content: ctx.architecture?.summary ?? "missing",
        source: "contract",
        trust: "untrusted",
      },
      {
        name: "Upstream handoff evidence",
        content:
          (ctx.upstreamHandoffs ?? [])
            .map((handoff) => `${handoff.taskId}@${handoff.commit}: ${handoff.summary}`)
            .join("\n") || "none",
        source: "retrieval",
        references: (ctx.upstreamHandoffs ?? []).map((handoff) => handoff.commit),
      },
      { name: "Reviewed diff", content: diff, source: "retrieval", references: ["git diff"] },
    ]);
    const approved = requiredBoolean(response, "approved");
    const verificationEvidence = reviewVerificationEvidence(response, ctx, fingerprint);
    const criteriaPassed = verificationEvidence.every((item) => item.passed);
    const gate: GateResult = {
      stage: "REVIEW",
      attempt: input.attempt,
      passed: approved && criteriaPassed,
      reason: requiredString(response, "reason"),
      feedback: requiredString(response, "feedback"),
      evidence: `diff-sha256:${fingerprint}; ${requiredString(response, "evidence")}`,
      artifactFingerprint: fingerprint,
      verificationEvidence,
    };
    return { kind: "gate", gate };
  }
}

function reviewVerificationEvidence(
  response: Readonly<Record<string, unknown>>,
  ctx: TaskContext,
  artifactFingerprint: string,
): readonly VerificationEvidence[] {
  if (ctx.plan === null) throw new StageFailure("REVIEW requires a completed plan");
  const expected = requiredCriteriaForStage(ctx.plan.acceptanceCriteria, "REVIEW");
  const raw = objectArray(response, "acceptanceCriteria");
  const byId = new Map<string, VerificationEvidence>();
  for (const item of raw) {
    const criterionId = requiredString(item, "criterionId");
    if (byId.has(criterionId)) {
      throw new StageFailure(`REVIEW returned duplicate evidence for ${criterionId}`);
    }
    const criterion = expected.find((candidate) => candidate.id === criterionId);
    if (criterion === undefined) {
      throw new StageFailure(`REVIEW returned unknown acceptance criterion ${criterionId}`);
    }
    byId.set(criterionId, {
      criterionId,
      verifierKind: criterion.verifier.kind,
      source: "review:model",
      artifactFingerprint,
      passed: requiredBoolean(item, "satisfied"),
      details: requiredString(item, "evidence"),
    });
  }
  if (byId.size !== expected.length) {
    const missing = expected.filter((criterion) => !byId.has(criterion.id)).map((item) => item.id);
    throw new StageFailure(`REVIEW omitted acceptance criteria: ${missing.join(", ")}`);
  }
  return expected.map((criterion) => byId.get(criterion.id)!);
}

function extractDiff(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("diff" in data)) return "";
  return typeof data.diff === "string" ? data.diff : "";
}
