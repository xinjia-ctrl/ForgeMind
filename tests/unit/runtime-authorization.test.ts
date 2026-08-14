import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { runForgeMind } from "../../src/runtime/run.js";
import { runProcess } from "../../src/tools/process.js";

it("denies an unauthorized actor before creating a run branch", async () => {
  const repository = await createRepository();
  try {
    const originalBranch = await git(repository, ["branch", "--show-current"]);
    await assert.rejects(
      () =>
        runForgeMind({
          repoPath: repository,
          requirement: "Unauthorized change",
          provider: new FakeChatProvider([]),
          model: "fake-model",
          runId: "unauthorized-run",
          actor: { id: "viewer", role: "viewer", repos: [repository] },
        }),
      /not authorized/,
    );
    assert.equal(await git(repository, ["branch", "--show-current"]), originalBranch);
    assert.equal(await git(repository, ["branch", "--list", "forgemind/unauthorized-run"]), "");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-auth-run-"));
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "src/index.js"), "export {};\n", "utf8");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.name", "ForgeMind Test"]);
  await git(repository, ["config", "user.email", "forgemind@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "chore: initial fixture"]);
  return await realpath(repository);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxBytes: 32_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
