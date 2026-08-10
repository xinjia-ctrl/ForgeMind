import { realpath } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import { runProcess } from "../tools/process.js";

export interface GitWorkspace {
  readonly root: string;
  readonly gitDirectory: string;
  readonly originalBranch: string;
  readonly branch: string;
}

export async function prepareGitWorkspace(
  requestedPath: string,
  runId: string,
): Promise<GitWorkspace> {
  const inspected = await inspectGitWorkspace(requestedPath);
  const status = await git(inspected.root, ["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    throw new HardFailure("Target repository must be clean before a ForgeMind run");
  }
  const branch = `forgemind/${runId}`;
  const check = await git(inspected.root, ["check-ref-format", "--branch", branch]);
  if (check.exitCode !== 0) throw new HardFailure(`Invalid run branch: ${branch}`);
  const switched = await git(inspected.root, ["switch", "-c", branch]);
  if (switched.exitCode !== 0) {
    throw new HardFailure(`Cannot create run branch ${branch}: ${switched.stderr.trim()}`);
  }
  return { ...inspected, branch };
}

export async function inspectGitWorkspace(
  requestedPath: string,
): Promise<Omit<GitWorkspace, "branch">> {
  const requested = await realpath(path.resolve(requestedPath));
  const rootResult = await git(requested, ["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) {
    throw new HardFailure(`${requested} is not inside a Git repository`);
  }
  const root = await realpath(rootResult.stdout.trim());
  const gitDirectoryResult = await git(root, ["rev-parse", "--absolute-git-dir"]);
  const branchResult = await git(root, ["branch", "--show-current"]);
  if (gitDirectoryResult.exitCode !== 0 || branchResult.exitCode !== 0) {
    throw new HardFailure("Cannot inspect Git repository metadata");
  }
  const originalBranch = branchResult.stdout.trim();
  if (originalBranch.length === 0) {
    throw new HardFailure("Detached HEAD workspaces are not supported");
  }
  return {
    root,
    gitDirectory: gitDirectoryResult.stdout.trim(),
    originalBranch,
  };
}

async function git(cwd: string, args: readonly string[]) {
  return await runProcess("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxBytes: 32_000,
  });
}
