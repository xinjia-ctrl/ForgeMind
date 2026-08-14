import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { inspectGitWorkspace, prepareTaskWorktree } from "../../src/runtime/git-workspace.js";
import { runProcess } from "../../src/tools/process.js";

it("creates an isolated task worktree without switching the source repository", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const source = await inspectGitWorkspace(fixture.repository);
    const sourceHead = await git(fixture.repository, ["rev-parse", "HEAD"]);
    const worktree = await prepareTaskWorktree({
      repositoryPath: fixture.repository,
      parentRunId: "parent-run",
      taskId: "api",
      runId: "child-run",
      worktreesRoot: fixture.worktreesRoot,
    });

    assert.notEqual(worktree.root, source.root);
    assert.equal(worktree.branch, "forgemind/child-run");
    assert.equal(worktree.originalBranch, source.originalBranch);
    assert.equal(worktree.commonGitDirectory, source.commonGitDirectory);
    assert.notEqual(worktree.gitDirectory, source.gitDirectory);
    assert.equal(
      await git(fixture.repository, ["branch", "--show-current"]),
      source.originalBranch,
    );
    assert.equal(await git(worktree.root, ["rev-parse", "HEAD"]), sourceHead);

    await writeFile(path.join(worktree.root, "task.txt"), "isolated\n", "utf8");
    assert.equal(await readFile(path.join(fixture.repository, "source.txt"), "utf8"), "source\n");
    await assert.rejects(() => readFile(path.join(fixture.repository, "task.txt"), "utf8"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("refuses to reuse an existing task worktree path", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const options = {
      repositoryPath: fixture.repository,
      parentRunId: "parent-run",
      taskId: "api",
      runId: "child-run",
      worktreesRoot: fixture.worktreesRoot,
    } as const;
    await prepareTaskWorktree(options);
    await assert.rejects(() => prepareTaskWorktree(options), /already exists/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("refuses to place task worktrees inside the source repository", async () => {
  const fixture = await createRepositoryFixture();
  try {
    await assert.rejects(
      () =>
        prepareTaskWorktree({
          repositoryPath: fixture.repository,
          parentRunId: "parent-run",
          taskId: "api",
          runId: "child-run",
          worktreesRoot: path.join(fixture.repository, ".worktrees"),
        }),
      /must be outside/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createRepositoryFixture(): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly worktreesRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgemind-worktree-test-"));
  const repository = path.join(root, "repository");
  const worktreesRoot = path.join(root, "worktrees");
  await mkdir(repository);
  await writeFile(path.join(repository, "source.txt"), "source\n", "utf8");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.name", "ForgeMind Test"]);
  await git(repository, ["config", "user.email", "forgemind@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "chore: initial fixture"]);
  return { root, repository, worktreesRoot };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxBytes: 32_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
