import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { replay } from "../../src/core/replay.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { runProcess } from "../../src/tools/process.js";
import { runForgeMind } from "../../src/runtime/run.js";

it("runs requirement through real tests and creates a Git commit", async () => {
  const repo = await createDemoRepository();
  try {
    const provider = new FakeChatProvider([
      JSON.stringify({
        objective: "Implement integer addition",
        steps: [
          { id: "1", title: "Implement", description: "Implement add" },
          { id: "2", title: "Test", description: "Cover positive and negative values" },
        ],
        acceptanceCriteria: ["add returns the sum", "node tests pass"],
        summary: "Implement and test add",
      }),
      JSON.stringify({
        decisions: ["Keep the existing ESM module"],
        files: [
          { path: "src/math.js", purpose: "Addition implementation" },
          { path: "test/math.test.js", purpose: "Addition tests" },
        ],
        risks: ["Incorrect negative number handling"],
        summary: "Extend the existing math module and use node:test",
      }),
      JSON.stringify({
        summary: "Implemented addition with representative tests",
        operations: [
          {
            tool: "write_file",
            args: {
              path: "src/math.js",
              content: "export function add(left, right) {\n  return left + right;\n}\n",
            },
          },
          {
            tool: "write_file",
            args: {
              path: "test/math.test.js",
              content:
                "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.js';\n\ntest('adds integers', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-2, 1), -1);\n});\n",
            },
          },
        ],
      }),
      JSON.stringify({
        approved: true,
        reason: "Implementation is correct and scoped",
        feedback: "No changes required",
        evidence: "Reviewed implementation and meaningful node:test coverage",
      }),
    ]);

    const execution = await runForgeMind({
      repoPath: repo,
      requirement: "Add an integer addition function with tests",
      provider,
      model: "fake-model",
      runId: "e2e-run",
    });

    assert.equal(execution.result.status, "SUCCEEDED");
    assert.equal(provider.remainingResponses, 0);
    assert.equal(execution.result.context.repo.branch, "forgemind/e2e-run");
    assert.deepEqual(
      execution.result.context.gates.map((gate) => [gate.stage, gate.passed]),
      [
        ["REVIEW", true],
        ["TEST", true],
      ],
    );
    const head = await git(repo, ["rev-parse", "HEAD"]);
    assert.match(execution.result.summary, new RegExp(head.stdout.trim()));
    assert.match(await readFile(path.join(repo, "src/math.js"), "utf8"), /left \+ right/);

    const log = EventLog.open(path.dirname(execution.eventLogPath), "e2e-run");
    const timeline = replay(await log.load());
    assert.equal(timeline.status, "SUCCEEDED");
    assert.ok(timeline.entries.some((entry) => entry.type === "gate.passed"));
    assert.ok(timeline.entries.some((entry) => entry.type === "tool.called"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function createDemoRepository(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "forgemind-e2e-"));
  await mkdir(path.join(repo, "src"));
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(repo, "src/math.js"),
    "// Math operations are added here.\n",
    "utf8",
  );
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "ForgeMind Test"]);
  await git(repo, ["config", "user.email", "forgemind@example.invalid"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "chore: initial fixture"]);
  return repo;
}

async function git(cwd: string, args: readonly string[]) {
  const result = await runProcess("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxBytes: 32_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}
