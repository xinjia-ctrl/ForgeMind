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

    assert.equal(
      execution.result.status,
      "SUCCEEDED",
      JSON.stringify({ summary: execution.result.summary, gates: execution.result.context.gates }),
    );
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
    assert.equal((await git(repo, ["ls-files", "docs/.forgemind"])).stdout.trim(), "");
    const planArtifact = execution.result.context.artifacts.find(
      (artifact) => artifact.kind === "plan",
    );
    assert.match(planArtifact?.path ?? "", /\.git\/forgemind\/runs\/e2e-run\/artifacts\/plan\.md$/);

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
          event.data.promptVersion === "plan.v4" &&
          event.data.structuredOutput === true,
      ),
    );
    const quality = events.find((event) => event.type === "run.quality");
    assert.ok(quality);
    assert.equal(quality.data.outcome, "succeeded");
    assert.equal(quality.data.evidenceCompleteness, 100);
    assert.equal(quality.data.verificationStrength, "strong");
    assert.equal(quality.data.coveragePercent, null);
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
    const toolExecutions = events.filter((event) => event.type === "tool.called");
    const testExecution = toolExecutions.find((event) => event.data.tool === "run_command");
    assert.ok(testExecution);
    assert.match(JSON.stringify(testExecution.data.result), /container/);
    assert.match(JSON.stringify(testExecution.data.result), /node@sha256/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("injects governed successful-run memory into PLAN and ARCH on the second run", async () => {
  const repo = await createDemoRepository();
  try {
    const first = await runForgeMind({
      repoPath: repo,
      requirement:
        "Add an integer addition function with tests while preserving the public API architecture",
      provider: createDemoProvider(true),
      model: "fake-model",
      runId: "memory-first-run",
      approveAll: true,
      memory: true,
      processRunner: createSandboxRunner(),
    });
    const secondProvider = createDemoProvider(true, true);
    const second = await runForgeMind({
      repoPath: repo,
      requirement:
        "Add an integer addition function with tests while preserving the public API architecture",
      provider: secondProvider,
      model: "fake-model",
      runId: "memory-second-run",
      approveAll: true,
      memory: true,
      processRunner: createSandboxRunner(),
    });

    assert.equal(first.result.status, "SUCCEEDED", first.result.summary);
    assert.equal(second.result.status, "SUCCEEDED", second.result.summary);
    const planPrompt = secondProvider.calls[0]?.messages.find((message) => message.role === "user");
    const archPrompt = secondProvider.calls[1]?.messages.find((message) => message.role === "user");
    assert.match(planPrompt?.content ?? "", /Historical run memory-first-run/);
    assert.match(archPrompt?.content ?? "", /Historical run memory-first-run/);
    assert.match(planPrompt?.content ?? "", /Independently verified run/);
    const firstEvents = await EventLog.open(
      path.dirname(first.eventLogPath),
      "memory-first-run",
    ).load();
    assert.ok(firstEvents.some((event) => event.type === "memory.stored"));
    const qualityLessons = JSON.parse(
      await readFile(path.join(repo, ".forgemind", "memory", "lessons.json"), "utf8"),
    ) as {
      readonly entries: readonly {
        readonly content: string;
        readonly validatedByRunIds: readonly string[];
      }[];
    };
    assert.ok(
      qualityLessons.entries.some((entry) => entry.content.includes("Independently verified run")),
    );
    assert.ok(
      qualityLessons.entries.some(
        (entry) =>
          entry.content.includes("Independently verified run") &&
          entry.validatedByRunIds.includes("memory-first-run") &&
          entry.validatedByRunIds.includes("memory-second-run"),
      ),
    );
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
    const recalledProject = events.find(
      (event) => event.type === "memory.recalled" && event.data.scope === "project",
    );
    assert.equal(recalledProject?.type, "memory.recalled");
    assert.ok(recalledProject.data.entryId.length > 0);
    assert.ok(recalledProject.data.confidence > 0);
    assert.ok(Number.isFinite(Date.parse(recalledProject.data.timestamp)));
    assert.ok(events.some((event) => event.type === "memory.stored"));
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
            acceptanceCriteria: additionCriteriaJson(),
          },
          {
            taskId: "web-client",
            deps: [],
            repo: repositories[1],
            requirement: "Implement the web client addition behavior",
            acceptanceCriteria: additionCriteriaJson(),
          },
          {
            taskId: "integration",
            deps: ["service-api", "web-client"],
            repo: repositories[0],
            requirement: "Verify the integration addition behavior",
            acceptanceCriteria: additionCriteriaJson(),
          },
        ],
      }),
    ]);

    const execution = await runDagForgeMind({
      repositories,
      requirement: "Ship addition behavior across service and web",
      provider: planner,
      providerForTask: (task) => createDemoProvider(true, task.taskId === "integration"),
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
    const integrationResult = execution.result.tasks.find((task) => task.taskId === "integration");
    assert.equal(integrationResult?.upstreamCommits?.length, 2);
    const serviceBranch = execution.result.tasks.find(
      (task) => task.taskId === "service-api",
    )?.branch;
    assert.equal(
      execution.result.prList.find((candidate) => candidate.taskId === "integration")?.baseBranch,
      serviceBranch,
    );
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
        task.taskId === "integration" ? "2" : "1",
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

it("does not conflate identical artifact paths from different repositories", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "forgemind-dag-negotiation-e2e-"));
  const repositories = await Promise.all([
    createDemoRepository(path.join(fixtureRoot, "service")),
    createDemoRepository(path.join(fixtureRoot, "web")),
  ]);
  try {
    const parentProvider = new FakeChatProvider([
      JSON.stringify({
        summary: "Implement the shared amount contract",
        tasks: [
          {
            taskId: "service-contract",
            deps: [],
            repo: repositories[0],
            requirement: "Represent payment amounts for the service",
            acceptanceCriteria: paymentCriteriaJson(),
          },
          {
            taskId: "web-contract",
            deps: [],
            repo: repositories[1],
            requirement: "Represent payment amounts for the web client",
            acceptanceCriteria: paymentCriteriaJson(),
          },
          {
            taskId: "integration-contract",
            deps: ["service-contract", "web-contract"],
            repo: repositories[0],
            requirement: "Integrate the negotiated payment amount representation",
            acceptanceCriteria: paymentCriteriaJson(),
          },
        ],
      }),
    ]);
    const execution = await runDagForgeMind({
      repositories,
      requirement: "Align payment amount semantics across service and web",
      provider: parentProvider,
      providerForTask: (task) =>
        createArtifactMismatchProvider(
          task.taskId === "service-contract"
            ? "Payment amount uses integer cents"
            : task.taskId === "web-contract"
              ? "Payment amount uses decimal dollars"
              : "Integration uses the inherited payment representation",
          task.taskId === "integration-contract",
        ),
      model: "fake-model",
      parentRunId: "dag-artifact-negotiation-e2e",
      maxConcurrency: 2,
      worktreesRoot: path.join(fixtureRoot, "worktrees"),
      approveAll: true,
      memory: true,
      processRunner: createSandboxRunner(),
    });

    assert.equal(
      execution.result.status,
      "SUCCEEDED",
      JSON.stringify(execution.result.tasks, null, 2),
    );
    assert.equal(parentProvider.remainingResponses, 0);
    assert.equal(execution.result.decisionRecords.length, 0);
    const parentEvents = await EventLog.open(
      path.dirname(execution.eventLogPath),
      "dag-artifact-negotiation-e2e",
    ).load();
    assert.equal(
      parentEvents.some((event) => event.type.startsWith("negotiation.")),
      false,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function createDemoProvider(includeArchitecture = false, integration = false): FakeChatProvider {
  return new FakeChatProvider([
    JSON.stringify({
      objective: "Implement integer addition",
      steps: [
        { title: "Implement", description: "Implement add" },
        {
          title: "Test",
          description: "Cover positive and negative values",
        },
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
      basedOnEvidence: integration
        ? "The upstream addition implementation is verified; this task still needs an integration marker"
        : "The existing math module is a placeholder and the plan requires implementation plus tests",
      todo: [],
      actions: integration
        ? [
            {
              kind: "write",
              path: "src/integration.js",
              content: "export const additionIntegrationVerified = true;\n",
            },
            { kind: "finish", evidence: "Recorded integration verification over upstream code" },
          ]
        : [
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
            {
              kind: "finish",
              evidence: "Implemented addition and signed integer regression tests",
            },
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

function createArtifactMismatchProvider(summary: string, integration = false): FakeChatProvider {
  return new FakeChatProvider([
    JSON.stringify({
      objective: "Implement the payment amount contract",
      steps: [{ title: "Implement", description: "Update the shared contract" }],
      acceptanceCriteria: paymentCriteriaJson(),
      summary: "Implement the payment amount contract",
    }),
    JSON.stringify({
      decisions: [summary],
      files: [{ path: "src/math.js", purpose: "Shared payment amount contract" }],
      risks: ["Cross-system representation mismatch"],
      summary,
    }),
    JSON.stringify({
      basedOnEvidence:
        "The contract file is still a placeholder and needs an explicit representation plus coverage",
      todo: [],
      actions: integration
        ? [
            {
              kind: "write",
              path: "src/integration.js",
              content: `export const integrationContract = ${JSON.stringify(summary)};\n`,
            },
            { kind: "finish", evidence: summary },
          ]
        : [
            {
              kind: "write",
              path: "src/math.js",
              content: `export const paymentAmountRepresentation = ${JSON.stringify(summary)};\n`,
            },
            {
              kind: "write",
              path: "test/math.test.js",
              content:
                "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { paymentAmountRepresentation } from '../src/math.js';\n\ntest('defines the payment amount representation', () => {\n  assert.equal(typeof paymentAmountRepresentation, 'string');\n});\n",
            },
            { kind: "finish", evidence: summary },
          ],
    }),
    JSON.stringify({
      approved: true,
      reason: "The contract is explicit",
      feedback: "No changes required",
      evidence: "Reviewed the payment amount representation",
      acceptanceCriteria: [
        {
          criterionId: "AC-1",
          satisfied: true,
          evidence: "src/math.js defines the payment amount representation explicitly",
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

function paymentCriteriaJson() {
  return [
    {
      description: "The payment amount representation is explicit",
      requiredEvidence: ["test", "review"],
      verifier: {
        kind: "file",
        path: "src/math.js",
        assertion: "contains",
        value: "paymentAmountRepresentation",
      },
    },
  ];
}

async function createDemoRepository(explicitPath?: string): Promise<string> {
  const repo = explicitPath ?? (await mkdtemp(path.join(os.tmpdir(), "forgemind-e2e-")));
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
