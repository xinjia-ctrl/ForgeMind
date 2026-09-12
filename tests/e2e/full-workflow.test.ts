import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { replay } from "../../src/core/replay.js";
import { workflowSignature } from "../../src/core/reproducibility.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { runForgeMind } from "../../src/runtime/run.js";
import { ContainerProcessRunner } from "../../src/sandbox/docker.js";
import { runProcess } from "../../src/tools/process.js";

const TEST_IMAGE = `node@sha256:${"a".repeat(64)}`;

it("runs requirement through real tests and creates a Git commit", async () => {
  const repo = await createDemoRepository();
  try {
    const provider = createDemoProvider();
    const execution = await runForgeMind({
      repoPath: repo,
      requirement: "Add an integer addition function with tests",
      provider,
      model: "fake-model",
      runId: "e2e-run",
      approveAll: true,
      processRunner: createSandboxRunner(),
    });

    assert.equal(execution.result.status, "SUCCEEDED", execution.result.summary);
    assert.equal(provider.remainingResponses, 0);
    assert.equal(execution.result.context.repo.branch, "forgemind/e2e-run");
    assert.deepEqual(
      execution.result.context.gates.map((gate) => [gate.stage, gate.passed]),
      [
        ["TEST", true],
        ["REVIEW", true],
      ],
    );
    const head = await git(repo, ["rev-parse", "HEAD"]);
    assert.match(execution.result.summary, new RegExp(head.stdout.trim()));
    assert.match(await readFile(path.join(repo, "src/math.js"), "utf8"), /left \+ right/);
    const plan = execution.result.context.artifacts.find((artifact) => artifact.kind === "plan");
    assert.match(plan?.path ?? "", /\.git\/forgemind\/runs\/e2e-run\/artifacts\/plan\.md$/);

    const events = await EventLog.open(path.dirname(execution.eventLogPath), "e2e-run").load();
    assert.equal(replay(events).status, "SUCCEEDED");
    assert.ok(events.some((event) => event.type === "gate.passed"));
    assert.ok(events.some((event) => event.type === "tool.called"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "llm.called" &&
          event.data.promptVersion === "plan.v4" &&
          event.data.structuredOutput === true,
      ),
    );
    const quality = events.find((event) => event.type === "run.quality");
    assert.ok(quality);
    assert.equal(quality.data.outcome, "succeeded");
    assert.equal(quality.data.evidenceCompleteness, 100);
    assert.equal(quality.data.verificationStrength, "strong");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("reproduces the workflow sequence and gate decisions for identical input", async () => {
  const repositories = await Promise.all([createDemoRepository(), createDemoRepository()]);
  try {
    const executions = await Promise.all(
      repositories.map((repo, index) =>
        runForgeMind({
          repoPath: repo,
          requirement: "Add an integer addition function with tests",
          provider: createDemoProvider(),
          model: "fake-model",
          runId: `reproducible-run-${index + 1}`,
          approveAll: true,
          processRunner: createSandboxRunner(),
        }),
      ),
    );
    const eventSets = await Promise.all(
      executions.map((execution, index) =>
        EventLog.open(path.dirname(execution.eventLogPath), `reproducible-run-${index + 1}`).load(),
      ),
    );
    assert.equal(workflowSignature(eventSets[0] ?? []), workflowSignature(eventSets[1] ?? []));
    assert.deepEqual(
      executions.map((execution) =>
        execution.result.context.gates.map((gate) => [gate.stage, gate.attempt, gate.passed]),
      ),
      [
        [
          ["TEST", 1, true],
          ["REVIEW", 1, true],
        ],
        [
          ["TEST", 1, true],
          ["REVIEW", 1, true],
        ],
      ],
    );
  } finally {
    await Promise.all(repositories.map((repo) => rm(repo, { recursive: true, force: true })));
  }
});

it("persists runtime failures in stage events", async () => {
  const repo = await createDemoRepository();
  try {
    const execution = await runForgeMind({
      repoPath: repo,
      requirement: "Expose provider failure",
      provider: new FakeChatProvider([]),
      model: "fake-model",
      runId: "classified-failure",
      processRunner: createSandboxRunner(),
    });

    assert.equal(execution.result.status, "FAILED");
    const events = await EventLog.open(
      path.dirname(execution.eventLogPath),
      "classified-failure",
    ).load();
    const failure = events.find((event) => event.type === "stage.failed");
    assert.ok(failure);
    assert.equal(failure.data.kind, "STAGE");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("stops when commit approval is rejected", async () => {
  const repo = await createDemoRepository();
  try {
    const execution = await runForgeMind({
      repoPath: repo,
      requirement:
        "Add an integer addition function with tests while preserving the public API architecture",
      provider: createDemoProvider(true),
      model: "fake-model",
      runId: "approval-rejected-run",
      noApprove: true,
      processRunner: createSandboxRunner(),
    });

    assert.equal(execution.result.status, "FAILED");
    assert.match(execution.result.summary, /Policy denied COMMIT\/git_commit/);
    const events = await EventLog.open(
      path.dirname(execution.eventLogPath),
      "approval-rejected-run",
    ).load();
    assert.ok(events.some((event) => event.type === "approval.requested"));
    assert.ok(
      events.some(
        (event) => event.type === "approval.rejected" && event.data.decisionSource === "disabled",
      ),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

function createDemoProvider(includeArchitecture = false): FakeChatProvider {
  return new FakeChatProvider([
    JSON.stringify({
      objective: "Implement integer addition",
      steps: [
        { title: "Implement", description: "Implement add" },
        { title: "Test", description: "Cover positive and negative values" },
      ],
      acceptanceCriteria: additionCriteriaJson(),
      summary: "Implement and test add",
    }),
    ...(includeArchitecture
      ? [
          JSON.stringify({
            decisions: ["Keep the existing ESM module"],
            files: [
              { path: "src/math.js", purpose: "Addition implementation" },
              { path: "test/math.test.js", purpose: "Addition tests" },
            ],
            risks: ["Incorrect negative number handling"],
            summary: "Extend the existing math module and use node:test",
          }),
        ]
      : []),
    JSON.stringify({
      basedOnEvidence: "The math module is a placeholder and needs implementation plus tests",
      todo: [],
      actions: [
        {
          kind: "write",
          path: "src/math.js",
          content: "export function add(left, right) {\n  return left + right;\n}\n",
        },
        {
          kind: "write",
          path: "test/math.test.js",
          content:
            "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.js';\n\ntest('adds integers', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-2, 1), -1);\n});\n",
        },
        { kind: "finish", evidence: "Implemented addition and signed integer tests" },
      ],
    }),
    JSON.stringify({
      approved: true,
      reason: "Implementation is correct and scoped",
      feedback: "No changes required",
      evidence: "Reviewed implementation and meaningful node:test coverage",
      acceptanceCriteria: [
        {
          criterionId: "AC-1",
          satisfied: true,
          evidence: "src/math.js implements addition and test/math.test.js asserts the sum",
        },
      ],
    }),
  ]);
}

function additionCriteriaJson() {
  return [
    {
      description: "add returns the sum for positive and signed integers",
      requiredEvidence: ["test", "review"],
      verifier: { kind: "test-case", commandId: "primary", pattern: "adds integers" },
    },
    {
      description: "node tests pass",
      requiredEvidence: ["test"],
      verifier: { kind: "test-suite", commandId: "primary" },
    },
  ];
}

async function createDemoRepository(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "forgemind-e2e-"));
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node test/math.test.js" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(repo, "forgemind.config.json"),
    `${JSON.stringify(
      {
        defaultMode: "deny",
        sandbox: {
          mode: "container",
          runtime: "docker",
          image: TEST_IMAGE,
          cpu: 1,
          memoryMb: 256,
          pidsLimit: 64,
          network: false,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(repo, "src/math.js"), "// Math operations are added here.\n", "utf8");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "ForgeMind Test"]);
  await git(repo, ["config", "user.email", "forgemind@example.invalid"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "chore: initial fixture"]);
  return await realpath(repo);
}

async function git(cwd: string, args: readonly string[]) {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxBytes: 32_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}

function createSandboxRunner(): ContainerProcessRunner {
  return new ContainerProcessRunner({
    runtime: "docker",
    image: TEST_IMAGE,
    cpu: 1,
    memoryMb: 256,
    pidsLimit: 64,
    network: false,
    hostRunner: (_runtime, runtimeArgs, options) => {
      const separator = runtimeArgs.indexOf("forgemind-entrypoint");
      const command = runtimeArgs[separator + 1];
      assert.ok(separator >= 0 && command !== undefined, "missing sandbox command boundary");
      return runProcess(command, runtimeArgs.slice(separator + 2), options);
    },
  });
}
