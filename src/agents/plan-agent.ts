import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";
import { objectArray, requiredString, stringArray } from "./validation.js";
import { assertAcceptanceContract, renderAcceptanceContract } from "../core/acceptance.js";
import type {
  AcceptanceCriterion,
  AcceptanceVerifier,
  ArtifactRef,
  RequiredEvidence,
  StageInput,
  StageOutput,
  TaskContext,
  TaskPlan,
} from "../core/types.js";
import type { RunArtifactStore } from "../core/run-artifact-store.js";

export const PLAN_TOOLS = [] as const;

export class PlanAgent extends BaseAgent {
  readonly #artifactStore: RunArtifactStore;

  public constructor(
    options: Omit<BaseAgentOptions, "id" | "tools"> & { readonly artifactStore: RunArtifactStore },
  ) {
    super({ ...options, id: "PLAN", tools: PLAN_TOOLS });
    this.#artifactStore = options.artifactStore;
  }

  protected async execute(_input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    const requiredCriteria = ctx.requiredAcceptanceCriteria ?? [];
    const response = await this.completeJson(ctx, [
      {
        name: "Requirement",
        content: ctx.requirement,
        source: "contract",
        trust: ctx.requirementTrust ?? "trusted",
      },
      ...(requiredCriteria.length === 0
        ? []
        : [
            {
              name: "Required acceptance criteria",
              content: renderAcceptanceContract(requiredCriteria),
              source: "contract" as const,
              trust: ctx.requirementTrust ?? "trusted",
            },
          ]),
    ]);
    const plan: TaskPlan = {
      objective: requiredString(response, "objective"),
      steps: objectArray(response, "steps").map((step, index) => ({
        id: String(index + 1),
        title: requiredString(step, "title"),
        description: requiredString(step, "description"),
      })),
      acceptanceCriteria:
        requiredCriteria.length === 0 ? parseAcceptanceCriteria(response) : [...requiredCriteria],
      summary: requiredString(response, "summary"),
    };
    if (plan.acceptanceCriteria.length === 0) {
      throw new Error("PLAN must return at least one acceptance criterion");
    }
    assertAcceptanceContract(plan.acceptanceCriteria);
    const artifactPath = await this.#artifactStore.write("plan.md", renderPlan(plan));
    const artifact: ArtifactRef = {
      path: artifactPath,
      kind: "plan",
      stage: "PLAN",
      summary: plan.summary,
    };
    return { kind: "plan", plan, artifact };
  }
}

function renderPlan(plan: TaskPlan): string {
  const steps = plan.steps
    .map((step) => `${step.id}. **${step.title}** — ${step.description}`)
    .join("\n");
  const criteria = plan.acceptanceCriteria
    .map(
      (item) =>
        `- [ ] **${item.id}** ${item.description}\n  - evidence: ${item.requiredEvidence.join(", ")}\n  - verifier: \`${JSON.stringify(item.verifier)}\``,
    )
    .join("\n");
  return `# Task Plan\n\n## Objective\n\n${plan.objective}\n\n## Steps\n\n${steps}\n\n## Acceptance Criteria\n\n${criteria}\n\n## Summary\n\n${plan.summary}\n`;
}

function parseAcceptanceCriteria(
  response: Readonly<Record<string, unknown>>,
): readonly AcceptanceCriterion[] {
  return objectArray(response, "acceptanceCriteria").map((item, index) => ({
    id: `AC-${index + 1}`,
    description: requiredString(item, "description"),
    requiredEvidence: parseRequiredEvidence(item),
    verifier: parseVerifier(item["verifier"]),
  }));
}

function parseRequiredEvidence(
  item: Readonly<Record<string, unknown>>,
): readonly RequiredEvidence[] {
  const values = stringArray(item, "requiredEvidence");
  if (!values.every((value): value is RequiredEvidence => value === "test" || value === "review")) {
    throw new Error("Acceptance requiredEvidence must contain only test or review");
  }
  return values;
}

function parseVerifier(value: unknown): AcceptanceVerifier {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Acceptance verifier must be an object");
  }
  const verifier = value as Readonly<Record<string, unknown>>;
  const kind = requiredString(verifier, "kind");
  switch (kind) {
    case "test-suite":
      return { kind, commandId: requiredString(verifier, "commandId") };
    case "test-case":
      return {
        kind,
        commandId: requiredString(verifier, "commandId"),
        pattern: requiredString(verifier, "pattern"),
      };
    case "file": {
      const assertion = requiredString(verifier, "assertion");
      if (assertion !== "exists" && assertion !== "absent" && assertion !== "contains") {
        throw new Error("File verifier assertion must be exists, absent, or contains");
      }
      return {
        kind,
        path: requiredString(verifier, "path"),
        assertion,
        ...(verifier["value"] === undefined ? {} : { value: requiredString(verifier, "value") }),
      };
    }
    case "behavior":
      return { kind, probeId: requiredString(verifier, "probeId") };
    case "review":
      return { kind, rubric: requiredString(verifier, "rubric") };
    default:
      throw new Error(`Unknown acceptance verifier kind: ${kind}`);
  }
}
