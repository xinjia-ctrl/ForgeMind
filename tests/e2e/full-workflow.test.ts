import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { replay } from "../../src/core/replay.js";
import { workflowSignature } from "../../src/core/reproducibility.js";
import { runDagForgeMind } from "../../src/dag/run.js";
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
    const events = await log.load();
    const timeline = replay(events);
    assert.equal(timeline.status, "SUCCEEDED");
    assert.ok(timeline.entries.some((entry) => entry.type === "gate.passed"));
    assert.ok(timeline.entries.some((entry) => entry.type === "tool.called"));
    assert.equal(
      events.some((event) => event.type.startsWith("memory.")),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "llm.called" &&
          event.data.promptVersion === "plan.v1" &&
          event.data.structuredOutput === true,
      ),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("reproduces the workflow sequence and gate decisions for identical input", async () => {
  const repositories = await Promise.all([createDemoRepository(), createDemoRepository()]);
  try {
    const executions = [];
    for (const [index, repo] of repositories.entries()) {
      executions.push(
        await runForgeMind({
          repoPath: repo,
          requirement: "Add an integer addition function with tests",
          provider: createDemoProvider(),
          model: "fake-model",
          runId: `reproducible-run-${index + 1}`,
          approveAll: true,
          processRunner: createSandboxRunner(),
        }),
      );
    }
    const eventSets = await Promise.all(
      executions.map((execution, index) =>
        EventLog.open(path.dirname(execution.eventLogPath), `reproducible-run-${index + 1}`).load(),
      ),
    );
    const firstEvents = eventSets[0];
    const secondEvents = eventSets[1];
    assert.ok(firstEvents);
    assert.ok(secondEvents);
    assert.equal(workflowSignature(firstEvents), workflowSignature(secondEvents));
    assert.deepEqual(
      executions.map((execution) =>
        execution.result.context.gates.map((gate) => [gate.stage, gate.attempt, gate.passed]),
      ),
      [
        [
          ["REVIEW", 1, true],
          ["TEST", 1, true],
        ],
        [
          ["REVIEW", 1, true],
          ["TEST", 1, true],
        ],
      ],
    );
  } finally {
    await Promise.all(repositories.map((repo) => rm(repo, { recursive: true, force: true })));
  }
});

it("persists the runtime failure classification in stage events", async () => {
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

it("fails a complete run when the commit approval is rejected and audits the decision", async () => {
  const repo = await createDemoRepository();
  try {
    const execution = await runForgeMind({
      repoPath: repo,
      requirement: "Add an integer addition function with tests",
      provider: createDemoProvider(),
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
    const toolExecutions = events.filter((event) => event.type === "tool.called");
    const testExecution = toolExecutions.find((event) => event.data.tool === "run_command");
    assert.ok(testExecution);
    assert.match(JSON.stringify(testExecution.data.result), /container/);
    assert.match(JSON.stringify(testExecution.data.result), /node@sha256/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("injects memory from the first run into PLAN and ARCH on the second run", async () => {
  const repo = await createDemoRepository();
  try {
    const first = await runForgeMind({
      repoPath: repo,
      requirement: "Add an integer addition function with tests",
      provider: createDemoProvider(),
      model: "fake-model",
      runId: "memory-first-run",
      approveAll: true,
      memory: true,
      processRunner: createSandboxRunner(),
    });
    const secondProvider = createDemoProvider();
    const second = await runForgeMind({
      repoPath: repo,
      requirement: "Add an integer addition function with tests",
      provider: secondProvider,
      model: "fake-model",
      runId: "memory-second-run",
      approveAll: true,
      memory: true,
      processRunner: createSandboxRunner(),
    });

    assert.equal(second.result.status, "SUCCEEDED");
    const planPrompt = secondProvider.calls[0]?.messages.find((message) => message.role === "user");
    const archPrompt = secondProvider.calls[1]?.messages.find((message) => message.role === "user");
    assert.match(planPrompt?.content ?? "", /Historical run memory-first-run/);
    assert.match(archPrompt?.content ?? "", /Historical run memory-first-run/);
    const firstEvents = await EventLog.open(
      path.dirname(first.eventLogPath),
      "memory-first-run",
    ).load();
    assert.ok(firstEvents.some((event) => event.type === "memory.stored"));
    const events = await EventLog.open(
      path.dirname(second.eventLogPath),
      "memory-second-run",
    ).load();
    assert.ok(
      events.some(
        (event) =>
          event.type === "memory.recalled" &&
          event.data.stage === "PLAN" &&
          event.data.scope === "episodic",
      ),
    );
    assert.ok(
      events.some((event) => event.type === "memory.recalled" && event.data.scope === "project"),
    );
    assert.ok(
      events.some((event) => event.type === "memory.recalled" && event.data.scope === "semantic"),
    );
    assert.equal(
      events.some((event) => event.type === "memory.stored"),
      false,
    );
    assert.equal(
      await git(repo, ["ls-files", ".forgemind/memory"]).then((result) => result.stdout.trim()),
      "",
    );
    assert.equal(await git(repo, ["status", "--short"]).then((result) => result.stdout.trim()), "");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("runs three isolated tasks across two repositories and produces an unmerged PR list", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "forgemind-dag-e2e-"));
  const repositories = await Promise.all([
    createDemoRepository(path.join(fixtureRoot, "service")),
    createDemoRepository(path.join(fixtureRoot, "web")),
  ]);
  const worktreesRoot = path.join(fixtureRoot, "worktrees");
  try {
    const originalBranches = await Promise.all(
      repositories.map((repository) => git(repository, ["branch", "--show-current"])),
    );
    const originalHeads = await Promise.all(
      repositories.map((repository) => git(repository, ["rev-parse", "HEAD"])),
    );
    const planner = new FakeChatProvider([
      JSON.stringify({
        summary: "Implement service and web changes, then verify integration",
        tasks: [
          {
            taskId: "service-api",
            deps: [],
            repo: repositories[0],
            requirement: "Implement the service API addition behavior",
          },
          {
            taskId: "web-client",
            deps: [],
            repo: repositories[1],
            requirement: "Implement the web client addition behavior",
          },
          {
            taskId: "integration",
            deps: ["service-api", "web-client"],
            repo: repositories[0],
            requirement: "Verify the integration addition behavior",
          },
        ],
      }),
    ]);

    const execution = await runDagForgeMind({
      repositories,
      requirement: "Ship addition behavior across service and web",
      provider: planner,
      providerForTask: () => createDemoProvider(),
      model: "fake-model",
      parentRunId: "multi-repo-e2e",
      maxConcurrency: 2,
      worktreesRoot,
      approveAll: true,
      processRunner: createSandboxRunner(),
    });

    assert.equal(planner.remainingResponses, 0);
    assert.equal(
      execution.result.status,
      "SUCCEEDED",
      JSON.stringify(execution.result.tasks, null, 2),
    );
    assert.equal(execution.result.tasks.length, 3);
    assert.equal(execution.result.prList.length, 3);
    assert.equal(execution.workspaces.length, 3);
    assert.equal(new Set(execution.workspaces.map((workspace) => workspace.root)).size, 3);
    assert.ok(execution.prListPath);
    assert.deepEqual(
      JSON.parse(await readFile(execution.prListPath, "utf8")),
      execution.result.prList,
    );

    for (const [index, repository] of repositories.entries()) {
      assert.equal(
        (await git(repository, ["branch", "--show-current"])).stdout.trim(),
        originalBranches[index]?.stdout.trim(),
      );
      assert.equal(
        (await git(repository, ["rev-parse", "HEAD"])).stdout.trim(),
        originalHeads[index]?.stdout.trim(),
      );
      assert.doesNotMatch(
        await readFile(path.join(repository, "src/math.js"), "utf8"),
        /left \+ right/,
      );
    }

    const sandboxIds = new Set<string>();
    for (const task of execution.result.tasks) {
      assert.equal(task.status, "SUCCEEDED");
      assert.ok(task.branch);
      const repository = repositories.find((candidate) => candidate === task.repo);
      assert.ok(repository);
      assert.equal(
        (
          await git(repository, [
            "rev-list",
            "--count",
            `${originalBranches[repositories.indexOf(repository)]?.stdout.trim()}..${task.branch}`,
          ])
        ).stdout.trim(),
        "1",
      );
      const events = await EventLog.open(
        path.join(repository, ".git", "forgemind", "runs"),
        task.runId,
      ).load();
      const started = events.find((event) => event.type === "run.started");
      assert.ok(started);
      assert.equal(started.data.parentRunId, "multi-repo-e2e");
      assert.equal(started.data.taskId, task.taskId);
      assert.ok(
        events.some((event) => event.type === "gate.passed" && event.data.stage === "TEST"),
      );
      const toolCalls = events.filter((event) => event.type === "tool.called");
      const testCall = toolCalls.find((event) => event.data.tool === "run_command");
      assert.ok(testCall);
      const toolResult = testCall.data.result as {
        readonly data?: { readonly sandbox?: { readonly containerId?: string } };
      };
      const sandbox = toolResult.data?.sandbox;
      assert.ok(sandbox?.containerId);
      sandboxIds.add(sandbox.containerId);
    }
    assert.equal(sandboxIds.size, 3);

    const parentEvents = await EventLog.open(
      path.dirname(execution.eventLogPath),
      "multi-repo-e2e",
    ).load();
    assert.equal(parentEvents.filter((event) => event.type === "task.started").length, 3);
    assert.equal(parentEvents.filter((event) => event.type === "task.completed").length, 3);
    assert.ok(
      parentEvents.some(
        (event) => event.type === "artifact.produced" && event.data.kind === "pr-candidate-list",
      ),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function createDemoProvider(): FakeChatProvider {
  return new FakeChatProvider([
    JSON.stringify({
      objective: "Implement integer addition",
      steps: [
        { id: "1", title: "Implement", description: "Implement add" },
        {
          id: "2",
          title: "Test",
          description: "Cover positive and negative values",
        },
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
}

async function createDemoRepository(explicitPath?: string): Promise<string> {
  const repo = explicitPath ?? (await mkdtemp(path.join(os.tmpdir(), "forgemind-e2e-")));
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
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
  const result = await runProcess("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxBytes: 32_000,
  });
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
