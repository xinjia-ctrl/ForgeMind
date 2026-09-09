import { StageFailure } from "../core/errors.js";
import type {
  ArchDecision,
  ArtifactRef,
  StageInput,
  StageOutput,
  TaskContext,
} from "../core/types.js";
import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";
import { objectArray, requiredString, stringArray } from "./validation.js";
import { renderAcceptanceContract } from "../core/acceptance.js";
import type { RunArtifactStore } from "../core/run-artifact-store.js";

export const ARCH_TOOLS = [] as const;

export class ArchitectureAgent extends BaseAgent {
  readonly #artifactStore: RunArtifactStore;

  public constructor(
    options: Omit<BaseAgentOptions, "id" | "tools"> & { readonly artifactStore: RunArtifactStore },
  ) {
    super({ ...options, id: "ARCH", tools: ARCH_TOOLS });
    this.#artifactStore = options.artifactStore;
  }

  protected async execute(_input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    if (ctx.plan === null) throw new StageFailure("ARCH requires a completed plan");
    const response = await this.completeJson(ctx, [
      {
        name: "Requirement",
        content: ctx.requirement,
        source: "contract",
        trust: ctx.requirementTrust ?? "trusted",
      },
      {
        name: "Plan summary",
        content: ctx.plan.summary,
        source: "contract",
        trust: "untrusted",
      },
      {
        name: "Acceptance criteria",
        content: renderAcceptanceContract(ctx.plan.acceptanceCriteria),
        source: "contract",
        trust: "untrusted",
      },
    ]);
    const architecture: ArchDecision = {
      decisions: stringArray(response, "decisions"),
      files: objectArray(response, "files").map((file) => ({
        path: requiredString(file, "path"),
        purpose: requiredString(file, "purpose"),
      })),
      risks: stringArray(response, "risks"),
      ...(response["alternatives"] === undefined
        ? {}
        : {
            alternatives: objectArray(response, "alternatives").map((alternative) => ({
              position: requiredString(alternative, "position"),
              tradeoffs: stringArray(alternative, "tradeoffs"),
            })),
          }),
      summary: requiredString(response, "summary"),
    };
    const artifactPath = await this.#artifactStore.write(
      "architecture.md",
      renderArchitecture(architecture),
    );
    const artifact: ArtifactRef = {
      path: artifactPath,
      kind: "architecture",
      stage: "ARCH",
      summary: architecture.summary,
    };
    return { kind: "architecture", architecture, artifact };
  }
}

function renderArchitecture(architecture: ArchDecision): string {
  const decisions = architecture.decisions.map((item) => `- ${item}`).join("\n");
  const files = architecture.files.map((file) => `- \`${file.path}\`: ${file.purpose}`).join("\n");
  const risks = architecture.risks.map((item) => `- ${item}`).join("\n");
  const alternatives =
    architecture.alternatives === undefined || architecture.alternatives.length === 0
      ? ""
      : `\n\n## Alternatives\n\n${architecture.alternatives
          .map(
            (alternative) =>
              `- ${alternative.position}\n  - Tradeoffs: ${alternative.tradeoffs.join("; ")}`,
          )
          .join("\n")}`;
  return `# Architecture Decision\n\n## Decisions\n\n${decisions}\n\n## Files\n\n${files}\n\n## Risks\n\n${risks}${alternatives}\n\n## Summary\n\n${architecture.summary}\n`;
}
