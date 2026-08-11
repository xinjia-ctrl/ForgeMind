import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { GitCommitTool } from "../../src/tools/git-tools.js";
import { runProcess } from "../../src/tools/process.js";
import { ToolPolicy } from "../../src/tools/types.js";

it("runs Git hooks by default and skips them only when explicitly configured", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "forgemind-hooks-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "ForgeMind Test"]);
    await git(repo, ["config", "user.email", "forgemind@example.invalid"]);
    await writeFile(path.join(repo, "tracked.txt"), "initial\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "chore: initial"]);

    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(hook, 0o755);
    await writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");

    const tool = new GitCommitTool();
    const defaultResult = await tool.execute(
      { message: "feat: run hooks" },
      commitPolicy(repo, false),
    );
    assert.equal(defaultResult.ok, false);

    const skippedResult = await tool.execute(
      { message: "feat: explicitly skip hooks" },
      commitPolicy(repo, true),
    );
    assert.equal(skippedResult.ok, true, skippedResult.error);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

function commitPolicy(repo: string, skipGitHooks: boolean): ToolPolicy {
  return new ToolPolicy({
    workspaceRoot: repo,
    stage: "COMMIT",
    allowedTools: ["git_commit"],
    writable: true,
    skipGitHooks,
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runProcess("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxBytes: 32_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
}
