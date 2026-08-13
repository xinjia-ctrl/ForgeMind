import { StageFailure } from "../core/errors.js";
import { rankWorkspaceFiles, searchTerms, type GrepMatch } from "../context/assembler.js";
import { truncateUtf8 } from "../core/text.js";
import type { ArtifactRef, StageInput, StageOutput, TaskContext } from "../core/types.js";
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
const MAX_CONTEXT_BYTES = 80_000;

export class CodeAgent extends BaseAgent {
  public constructor(options: Omit<BaseAgentOptions, "id" | "tools">) {
    super({ ...options, id: "CODE", tools: CODE_TOOLS });
  }

  protected async execute(input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    if (ctx.plan === null || ctx.architecture === null) {
      throw new StageFailure("CODE requires plan and architecture decisions");
    }
    const workspaceContext = await this.collectWorkspaceContext(ctx);
    const response = await this.completeJson(
      ctx,
      [
        { name: "Requirement", content: ctx.requirement, source: "contract" },
        { name: "Plan", content: ctx.plan.summary, source: "contract" },
        { name: "Architecture", content: ctx.architecture.summary, source: "contract" },
        {
          name: "Expected files",
          content: ctx.architecture.files.map((file) => file.path).join(", "),
          source: "contract",
          references: ctx.architecture.files.map((file) => file.path),
        },
        {
          name: "Rework evidence",
          content: input.feedback ?? "none",
          source: "rework",
        },
        {
          name: "Bounded workspace context",
          content: workspaceContext.content,
          source: "retrieval",
          references: workspaceContext.references,
        },
      ],
      { maxOperations: String(MAX_OPERATIONS) },
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

  private async collectWorkspaceContext(
    ctx: TaskContext,
  ): Promise<{ readonly content: string; readonly references: readonly string[] }> {
    const glob = await this.requireTool("glob", { pattern: "**/*" });
    const files = extractFiles(glob).filter(
      (file) => !file.startsWith("docs/.forgemind/") && isLikelyText(file),
    );
    const preferred = ctx.architecture?.files.map((file) => file.path) ?? [];
    const queries = searchTerms(`${ctx.requirement} ${ctx.architecture?.summary ?? ""}`);
    const grepMatches: GrepMatch[] = [];
    if (queries.length > 0) {
      const result = await this.requireTool("grep", {
        queries,
        pattern: "**/*",
        caseSensitive: false,
      });
      grepMatches.push(...extractGrepMatches(result));
    }
    const selected = rankWorkspaceFiles({
      files,
      expectedFiles: preferred,
      query: `${ctx.requirement} ${ctx.architecture?.summary ?? ""}`,
      grepMatches,
      limit: MAX_CONTEXT_FILES,
    });
    const excerpts: string[] = [
      `Workspace files (${files.length}):\n${files.slice(0, 300).join("\n")}`,
    ];
    for (const file of selected) {
      const result = await this.requireTool("read_file", {
        path: file,
        startLine: 1,
        endLine: 400,
      });
      const content = extractReadContent(result);
      excerpts.push(`--- ${file} ---\n${content}`);
    }
    const matchSummary = grepMatches
      .slice(0, 30)
      .map((match) => `${match.path}:${match.line}: ${match.text}`)
      .join("\n");
    if (matchSummary.length > 0) excerpts.splice(1, 0, `Relevant grep matches:\n${matchSummary}`);
    return {
      content: truncateUtf8(excerpts.join("\n"), MAX_CONTEXT_BYTES).text,
      references: [
        ...selected,
        ...new Set(grepMatches.slice(0, 30).map((match) => `${match.path}:${match.line}`)),
      ],
    };
  }
}

function extractFiles(result: ToolResult): string[] {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("files" in data)) return [];
  const files = data.files;
  return Array.isArray(files) && files.every((item) => typeof item === "string") ? files : [];
}

function extractReadContent(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("content" in data)) return "";
  return typeof data.content === "string" ? data.content : "";
}

function extractGrepMatches(result: ToolResult): GrepMatch[] {
  const data = result.data;
  if (!isRecord(data)) return [];
  const matches: unknown = data["matches"];
  if (!Array.isArray(matches)) return [];
  return matches.filter((match: unknown): match is GrepMatch => {
    if (!isRecord(match)) return false;
    return (
      typeof match["path"] === "string" &&
      typeof match["line"] === "number" &&
      typeof match["text"] === "string"
    );
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLikelyText(file: string): boolean {
  return !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|lock)$/i.test(file);
}
