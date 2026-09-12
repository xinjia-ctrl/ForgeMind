import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { prepareGitWorkspace } from "../../src/runtime/git-workspace.js";
import { runProcess } from "../../src/tools/process.js";

it("rejects a repository without an initial commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgemind-unborn-test-"));
  try {
    await git(root, ["init", "-b", "main"]);
    await assert.rejects(() => prepareGitWorkspace(root, "unborn-run"), /at least one commit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("creates a dedicated run branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgemind-git-test-"));
  try {
    await writeFile(path.join(root, "source.txt"), "source\n", "utf8");
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "ForgeMind Test"]);
    await git(root, ["config", "user.email", "forgemind@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const workspace = await prepareGitWorkspace(root, "branch-run");

    assert.equal(workspace.originalBranch, "main");
    assert.equal(workspace.branch, "forgemind/branch-run");
    assert.equal(await git(root, ["branch", "--show-current"]), "forgemind/branch-run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxBytes: 32_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
