import { RunCommandTool } from "./command-tools.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./file-tools.js";
import { GitCommitTool, GitDiffTool, GitStatusTool } from "./git-tools.js";
import { GlobTool, GrepTool } from "./search-tools.js";
import { ToolRegistry } from "./executor.js";

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new GrepTool(),
    new GlobTool(),
    new RunCommandTool(),
    new GitStatusTool(),
    new GitDiffTool(),
    new GitCommitTool(),
  ]);
}

export { ScopedToolExecutor, ToolRegistry } from "./executor.js";
export { ToolPolicy } from "./types.js";
export type { Tool, ToolResult } from "./types.js";
