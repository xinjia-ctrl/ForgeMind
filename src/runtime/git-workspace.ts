import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import { assertValidRunId, assertValidTaskId } from "../core/event-log.js";
import { runProcess } from "../tools/process.js";

export interface GitWorkspace {
  readonly root: string;
  readonly gitDirectory: string;
  readonly commonGitDirectory: string;
  readonly originalBranch: string;
  readonly branch: string;
}

export interface TaskWorktreeOptions {
  readonly repositoryPath: string;
  readonly parentRunId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly worktreesRoot?: string;
}

export async function prepareGitWorkspace(
  requestedPath: string,
  runId: string,
): Promise<GitWorkspace> {
  const inspected = await inspectGitWorkspace(requestedPath);
  await assertGitWorkspaceClean(inspected.root);
  const branch = `forgemind/${runId}`;
  const check = await git(inspected.root, ["check-ref-format", "--branch", branch]);
  if (check.exitCode !== 0) throw new HardFailure(`Invalid run branch: ${branch}`);
  const switched = await git(inspected.root, ["switch", "-c", branch]);
  if (switched.exitCode !== 0) {
    throw new HardFailure(`Cannot create run branch ${branch}: ${switched.stderr.trim()}`);
  }
  return { ...inspected, branch };
}

export async function prepareTaskWorktree(options: TaskWorktreeOptions): Promise<GitWorkspace> {
  assertValidRunId(options.parentRunId);
  assertValidTaskId(options.taskId);
  assertValidRunId(options.runId);
  const inspected = await inspectGitWorkspace(options.repositoryPath);
  await assertGitWorkspaceClean(inspected.root);
  const branch = `forgemind/${options.runId}`;
  const check = await git(inspected.root, ["check-ref-format", "--branch", branch]);
  if (check.exitCode !== 0) throw new HardFailure(`Invalid run branch: ${branch}`);

  const repositoryKey = createHash("sha256").update(inspected.root).digest("hex").slice(0, 12);
  const requestedWorktreesRoot = path.resolve(
    options.worktreesRoot ?? path.join(os.tmpdir(), "forgemind-worktrees"),
  );
  await mkdir(requestedWorktreesRoot, { recursive: true });
  const worktreesRoot = await realpath(requestedWorktreesRoot);
  assertWorktreesRootOutsideRepository(inspected.root, worktreesRoot);
  const worktreePath = path.join(
    worktreesRoot,
    options.parentRunId,
    `${path.basename(inspected.root)}-${repositoryKey}`,
    options.taskId,
  );
  if (await pathExists(worktreePath)) {
    throw new HardFailure(`Task worktree already exists: ${worktreePath}`);
  }
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const created = await git(inspected.root, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    inspected.originalBranch,
  ]);
  if (created.exitCode !== 0) {
    throw new HardFailure(`Cannot create task worktree ${worktreePath}: ${created.stderr.trim()}`);
  }
  const worktree = await inspectGitWorkspace(worktreePath);
  if (worktree.originalBranch !== branch) {
    throw new HardFailure(`Task worktree checked out unexpected branch ${worktree.originalBranch}`);
  }
  return {
    ...worktree,
    originalBranch: inspected.originalBranch,
    branch,
  };
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
  const commonGitDirectoryResult = await git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const branchResult = await git(root, ["branch", "--show-current"]);
  if (
    gitDirectoryResult.exitCode !== 0 ||
    commonGitDirectoryResult.exitCode !== 0 ||
    branchResult.exitCode !== 0
  ) {
    throw new HardFailure("Cannot inspect Git repository metadata");
  }
  const originalBranch = branchResult.stdout.trim();
  if (originalBranch.length === 0) {
    throw new HardFailure("Detached HEAD workspaces are not supported");
  }
  return {
    root,
    gitDirectory: gitDirectoryResult.stdout.trim(),
    commonGitDirectory: commonGitDirectoryResult.stdout.trim(),
    originalBranch,
  };
}

export async function assertGitWorkspaceClean(repositoryRoot: string): Promise<void> {
  const status = await git(repositoryRoot, ["status", "--porcelain"]);
  if (status.exitCode !== 0) {
    throw new HardFailure(`Cannot inspect repository status: ${status.stderr.trim()}`);
  }
  if (status.stdout.trim().length > 0) {
    throw new HardFailure("Target repository must be clean before a ForgeMind run");
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertWorktreesRootOutsideRepository(repositoryRoot: string, worktreesRoot: string): void {
  const relative = path.relative(repositoryRoot, worktreesRoot);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new HardFailure("Task worktrees root must be outside the target repository");
  }
}

async function git(cwd: string, args: readonly string[]) {
  return await runProcess("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxBytes: 32_000,
  });
}
