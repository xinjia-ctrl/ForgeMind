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
import { objectArray, requiredString } from "./validation.js";

export const CODE_TOOLS = [
  "glob",
  "grep",
  "read_file",
  "write_file",
  "edit_file",
  "git_status",
] as const;

const MAX_OPERATIONS = 30;
const MAX_CONTEXT_FILES = 8;

export class CodeAgent extends BaseAgent {
  public constructor(options: Omit<BaseAgentOptions, "id" | "tools">) {
    super({ ...options, id: "CODE", tools: CODE_TOOLS });
  }

  protected async execute(
    input: StageInput,
    ctx: TaskContext,
  ): Promise<StageOutput> {
    if (ctx.plan === null || ctx.architecture === null) {
      throw new StageFailure("CODE requires plan and architecture decisions");
    }
    const workspaceContext = await this.collectWorkspaceContext(ctx);
    const response = await this.completeJson(
      ctx,
      [
        "You are ForgeMind's coding agent.",
        "Produce a complete, minimal implementation and its tests in one bounded operation batch.",
        "Return JSON only with summary and operations[].",
        "Each operation is {tool:'write_file',args:{path,content}} or {tool:'edit_file',args:{path,search,replacement,expectedOccurrences}}.",
        `At most ${MAX_OPERATIONS} operations are allowed. Never edit .git or docs/.forgemind run artifacts.`,
        "Preserve existing architecture and do not omit tests.",
      ].join(" "),
      [
        `Requirement: ${ctx.requirement}`,
        `Plan: ${ctx.plan.summary}`,
        `Architecture: ${ctx.architecture.summary}`,
        `Expected files: ${ctx.architecture.files.map((file) => file.path).join(", ")}`,
        `Rework feedback: ${input.feedback ?? "none"}`,
        `Bounded workspace context:\n${workspaceContext}`,
      ].join("\n"),
    );
    const operations = objectArray(response, "operations");
    if (operations.length === 0 || operations.length > MAX_OPERATIONS) {
      throw new StageFailure(`CODE must return 1-${MAX_OPERATIONS} operations`);
    }
    const changedPaths = new Set<string>();
    for (const operation of operations) {
      const tool = requiredString(operation, "tool");
      if (tool !== "write_file" && tool !== "edit_file") {
        throw new StageFailure(`CODE operation uses unsupported tool: ${tool}`);
      }
      const args = operation["args"];
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new StageFailure("CODE operation args must be an object");
      }
      const pathValue = (args as Record<string, unknown>)["path"];
      if (typeof pathValue !== "string") {
        throw new StageFailure("CODE operation path must be a string");
      }
      if (pathValue.startsWith("docs/.forgemind/")) {
        throw new StageFailure("CODE cannot modify orchestration artifacts");
      }
      await this.requireTool(tool, args);
      changedPaths.add(pathValue);
    }
    const summary = requiredString(response, "summary");
    const artifacts: ArtifactRef[] = [...changedPaths].sort().map((path) => ({
      path,
      kind: "source",
      stage: "CODE",
      summary,
    }));
    return { kind: "code", summary, artifacts };
  }

  private async collectWorkspaceContext(ctx: TaskContext): Promise<string> {
    const glob = await this.requireTool("glob", { pattern: "**/*" });
    const files = extractFiles(glob).filter(
      (file) => !file.startsWith("docs/.forgemind/") && isLikelyText(file),
    );
    const preferred = ctx.architecture?.files.map((file) => file.path) ?? [];
    const selected = [...new Set([...preferred, ...files])]
      .filter((file) => files.includes(file))
      .slice(0, MAX_CONTEXT_FILES);
    const excerpts: string[] = [`Workspace files (${files.length}):\n${files.slice(0, 300).join("\n")}`];
    for (const file of selected) {
      const result = await this.requireTool("read_file", {
        path: file,
        startLine: 1,
        endLine: 400,
      });
      const content = extractReadContent(result);
      excerpts.push(`--- ${file} ---\n${content}`);
    }
    return excerpts.join("\n").slice(0, 80_000);
  }
}

function extractFiles(result: ToolResult): string[] {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("files" in data)) return [];
  const files = data.files;
  return Array.isArray(files) && files.every((item) => typeof item === "string")
    ? files
    : [];
}

function extractReadContent(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("content" in data)) return "";
  return typeof data.content === "string" ? data.content : "";
}

function isLikelyText(file: string): boolean {
  return !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|lock)$/i.test(file);
}
