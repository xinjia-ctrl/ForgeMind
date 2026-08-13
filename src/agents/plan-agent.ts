import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";
import { objectArray, requiredString, stringArray } from "./validation.js";
import type { ArtifactRef, StageInput, StageOutput, TaskContext, TaskPlan } from "../core/types.js";

export const PLAN_TOOLS = ["write_file"] as const;

export class PlanAgent extends BaseAgent {
  public constructor(options: Omit<BaseAgentOptions, "id" | "tools">) {
    super({ ...options, id: "PLAN", tools: PLAN_TOOLS });
  }

  protected async execute(_input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    const response = await this.completeJson(ctx, [
      { name: "Requirement", content: ctx.requirement, source: "contract" },
    ]);
    const plan: TaskPlan = {
      objective: requiredString(response, "objective"),
      steps: objectArray(response, "steps").map((step) => ({
        id: requiredString(step, "id"),
        title: requiredString(step, "title"),
        description: requiredString(step, "description"),
      })),
      acceptanceCriteria: stringArray(response, "acceptanceCriteria"),
      summary: requiredString(response, "summary"),
    };
    const artifact: ArtifactRef = {
      path: `docs/.forgemind/${ctx.runId}/plan.md`,
      kind: "plan",
      stage: "PLAN",
      summary: plan.summary,
    };
    await this.requireTool("write_file", {
      path: artifact.path,
      content: renderPlan(plan),
    });
    return { kind: "plan", plan, artifact };
  }
}

function renderPlan(plan: TaskPlan): string {
  const steps = plan.steps
    .map((step) => `${step.id}. **${step.title}** — ${step.description}`)
    .join("\n");
  const criteria = plan.acceptanceCriteria.map((item) => `- [ ] ${item}`).join("\n");
  return `# Task Plan\n\n## Objective\n\n${plan.objective}\n\n## Steps\n\n${steps}\n\n## Acceptance Criteria\n\n${criteria}\n\n## Summary\n\n${plan.summary}\n`;
}
