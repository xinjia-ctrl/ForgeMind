import { RunCommandTool } from "./command-tools.js";
import type { ProcessRunner } from "../sandbox/types.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./file-tools.js";
import { GitCommitTool, GitDiffTool, GitStatusTool } from "./git-tools.js";
import { GlobTool, GrepTool, WorkspaceFileIndex } from "./search-tools.js";
import { ToolRegistry } from "./executor.js";

export function createDefaultToolRegistry(processRunner: ProcessRunner): ToolRegistry {
  const fileIndex = new WorkspaceFileIndex();
  return new ToolRegistry([
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new GrepTool(fileIndex),
    new GlobTool(fileIndex),
    new RunCommandTool(processRunner),
    new GitStatusTool(),
    new GitDiffTool(),
    new GitCommitTool(),
  ]);
}

export { ScopedToolExecutor, ToolRegistry } from "./executor.js";
export { ToolPolicy } from "./types.js";
export type { Tool, ToolResult } from "./types.js";
