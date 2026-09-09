import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CodeAgent, CODE_TOOLS } from "../../src/agents/code-agent.js";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { createTaskContext, withArchitecture, withPlan } from "../../src/core/context.js";
import { testSuiteCriterion } from "../../src/core/acceptance.js";
import {
  FileActionJournal,
  type ActionJournal,
  type ActionJournalRecord,
} from "../../src/core/action-journal.js";
import { EventLog } from "../../src/core/event-log.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { NoopMemoryProvider } from "../../src/memory/noop-memory-provider.js";
import { AutoApprovalGateway } from "../../src/policy/auto-gateway.js";
import { RulePolicyResolver } from "../../src/policy/resolver.js";
import { ScopedToolExecutor, ToolRegistry } from "../../src/tools/executor.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "../../src/tools/file-tools.js";
import { GitDiffTool } from "../../src/tools/git-tools.js";
import { runProcess } from "../../src/tools/process.js";
import { GlobTool, GrepTool, WorkspaceFileIndex } from "../../src/tools/search-tools.js";
import { ToolPolicy } from "../../src/tools/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CodeAgent edit recovery", () => {
  it("refreshes the changed file and regenerates a stale edit instead of failing the stage", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forgemind-code-recovery-"));
    temporaryDirectories.push(workspace);
    const eventsDirectory = await mkdtemp(path.join(os.tmpdir(), "forgemind-code-events-"));
    temporaryDirectories.push(eventsDirectory);
    await writeFile(path.join(workspace, "example.js"), "const value = 1;\n", "utf8");
    await runProcess("git", ["init"], { cwd: workspace, timeoutMs: 30_000, maxBytes: 32_000 });
    const eventLog = await EventLog.create(eventsDirectory, "code-recovery");
    const provider = new FakeChatProvider([
      JSON.stringify({
        basedOnEvidence: "example.js still contains value 1",
        todo: ["Edit"],
        actions: [
          {
            kind: "edit",
            path: "example.js",
            oldText: "const value = 1;",
            newText: "const value = 2;",
          },
          {
            kind: "edit",
            path: "example.js",
            oldText: "const value = 1;",
            newText: "const value = 3;",
          },
        ],
      }),
      JSON.stringify({
        basedOnEvidence: "The refreshed file now contains value 2 after the stale edit failed",
        todo: [],
        actions: [
          {
            kind: "edit",
            path: "example.js",
            oldText: "const value = 2;",
            newText: "const value = 3;",
          },
          { kind: "finish", evidence: "example.js now contains the required value 3" },
        ],
      }),
    ]);
    const fileIndex = new WorkspaceFileIndex();
    const executor = new ScopedToolExecutor({
      registry: new ToolRegistry([
        new GlobTool(fileIndex),
        new GrepTool(fileIndex),
        new ReadFileTool(),
        new WriteFileTool(),
        new EditFileTool(),
        new GitDiffTool(),
      ]),
      eventLog,
      runId: "code-recovery",
      stage: "CODE",
      agentTools: CODE_TOOLS,
      policy: new ToolPolicy({
        workspaceRoot: workspace,
        stage: "CODE",
        allowedTools: CODE_TOOLS,
        writable: true,
        maxResultBytes: 128_000,
      }),
      policyResolver: new RulePolicyResolver("allow", []),
      approvalGateway: new AutoApprovalGateway(),
    });
    const agent = new CodeAgent({
      provider,
      model: "test-model",
      eventLog,
      toolExecutor: executor,
      budget: DEFAULT_TOKEN_BUDGETS.CODE,
      memory: new NoopMemoryProvider(),
    });
    let context = createTaskContext({
      runId: "code-recovery",
      requirement: "Update the example value",
      repoPath: workspace,
      branch: "forgemind/code-recovery",
      tokenBudget: DEFAULT_TOKEN_BUDGETS,
    });
    context = withPlan(
      context,
      {
        objective: "Update the value",
        steps: [{ id: "1", title: "Edit", description: "Edit example.js" }],
        acceptanceCriteria: [testSuiteCriterion("AC-1", "Value is 3")],
        summary: "Update example.js",
      },
      { path: "plan.md", kind: "plan", stage: "PLAN", summary: "Plan" },
    );
    context = withArchitecture(
      context,
      {
        decisions: ["Use the existing file"],
        files: [{ path: "example.js", purpose: "Implementation" }],
        risks: ["Stale edits"],
        summary: "Edit example.js in place",
      },
      {
        path: "architecture.md",
        kind: "architecture",
        stage: "ARCH",
        summary: "Architecture",
      },
    );

    const output = await agent.run({ attempt: 1 }, context);

    assert.equal(output.kind, "code");
    assert.equal(await readFile(path.join(workspace, "example.js"), "utf8"), "const value = 3;\n");
    assert.equal(provider.calls.length, 2);
    const recoveryPrompt = provider.calls[1]?.messages.map((message) => message.content).join("\n");
    assert.match(recoveryPrompt ?? "", /latest observation/i);
    assert.match(recoveryPrompt ?? "", /Expected 1 occurrences but found 0/);
    assert.match(recoveryPrompt ?? "", /const value = 2;/);
    const events = await eventLog.load();
    assert.equal(
      events.some((event) => event.type === "stage.failed"),
      false,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool.called" &&
          event.data.tool === "edit_file" &&
          typeof event.data.result === "object" &&
          event.data.result !== null &&
          "ok" in event.data.result &&
          event.data.result.ok === false,
      ),
      true,
    );
  });

  for (const crashPoint of ["after-planned", "before-executed"] as const) {
    it(`recovers a write crash ${crashPoint} without duplicating or overwriting it`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "forgemind-code-journal-"));
      temporaryDirectories.push(workspace);
      const eventsDirectory = await mkdtemp(
        path.join(os.tmpdir(), "forgemind-code-journal-events-"),
      );
      temporaryDirectories.push(eventsDirectory);
      await writeFile(path.join(workspace, "example.js"), "export const value = 1;\n", "utf8");
      await runProcess("git", ["init"], {
        cwd: workspace,
        timeoutMs: 30_000,
        maxBytes: 32_000,
      });
      const eventLog = await EventLog.create(eventsDirectory, `journal-${crashPoint}`);
      const journal = new CrashOnceActionJournal(
        new FileActionJournal(path.join(eventsDirectory, "actions.json")),
        crashPoint,
      );
      const response = JSON.stringify({
        basedOnEvidence: "example.js requires the requested value",
        todo: [],
        actions: [
          { kind: "write", path: "example.js", content: "export const value = 2;\n" },
          { kind: "finish", evidence: "example.js now exports value 2" },
        ],
      });
      const context = codeContext(workspace, `journal-${crashPoint}`);

      await assert.rejects(
        () =>
          codeAgent(
            workspace,
            eventLog,
            `journal-${crashPoint}`,
            new FakeChatProvider([response]),
            journal,
          ).run({ attempt: 1 }, context),
        /simulated crash/,
      );

      const output = await codeAgent(
        workspace,
        eventLog,
        `journal-${crashPoint}`,
        new FakeChatProvider([response]),
        journal,
      ).run({ attempt: 1 }, context);

      assert.equal(output.kind, "code");
      assert.equal(
        await readFile(path.join(workspace, "example.js"), "utf8"),
        "export const value = 2;\n",
      );
      assert.equal((await journal.get("CODE:1:1:1"))?.state, "VERIFIED");
    });
  }

  it("blocks recovery when the file matches neither the journaled before nor after state", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forgemind-code-conflict-"));
    temporaryDirectories.push(workspace);
    const eventsDirectory = await mkdtemp(
      path.join(os.tmpdir(), "forgemind-code-conflict-events-"),
    );
    temporaryDirectories.push(eventsDirectory);
    await writeFile(path.join(workspace, "example.js"), "export const value = 1;\n", "utf8");
    await runProcess("git", ["init"], {
      cwd: workspace,
      timeoutMs: 30_000,
      maxBytes: 32_000,
    });
    const runId = "journal-conflict";
    const eventLog = await EventLog.create(eventsDirectory, runId);
    const journal = new CrashOnceActionJournal(
      new FileActionJournal(path.join(eventsDirectory, "actions.json")),
      "after-planned",
    );
    const response = JSON.stringify({
      basedOnEvidence: "example.js requires the requested value",
      todo: [],
      actions: [
        { kind: "write", path: "example.js", content: "export const value = 2;\n" },
        { kind: "finish", evidence: "example.js now exports value 2" },
      ],
    });
    const context = codeContext(workspace, runId);
    await assert.rejects(
      () =>
        codeAgent(workspace, eventLog, runId, new FakeChatProvider([response]), journal).run(
          { attempt: 1 },
          context,
        ),
      /simulated crash/,
    );
    await writeFile(path.join(workspace, "example.js"), "export const value = 3;\n", "utf8");

    await assert.rejects(
      () =>
        codeAgent(workspace, eventLog, runId, new FakeChatProvider([response]), journal).run(
          { attempt: 1 },
          context,
        ),
      /matches neither beforeHash nor expectedAfterHash/,
    );
    assert.equal(
      await readFile(path.join(workspace, "example.js"), "utf8"),
      "export const value = 3;\n",
    );
  });
});

class CrashOnceActionJournal implements ActionJournal {
  #crashed = false;

  public constructor(
    private readonly delegate: FileActionJournal,
    private readonly crashPoint: "after-planned" | "before-executed",
  ) {}

  public get(id: string): Promise<ActionJournalRecord | null> {
    return this.delegate.get(id);
  }

  public async planned(
    id: string,
    signature: string,
    expectation: { readonly beforeHash: string; readonly expectedAfterHash: string },
  ): Promise<ActionJournalRecord> {
    const record = await this.delegate.planned(id, signature, expectation);
    if (!this.#crashed && this.crashPoint === "after-planned") {
      this.#crashed = true;
      throw new Error("simulated crash after PLANNED");
    }
    return record;
  }

  public executed(id: string): Promise<ActionJournalRecord> {
    if (!this.#crashed && this.crashPoint === "before-executed") {
      this.#crashed = true;
      return Promise.reject(new Error("simulated crash before EXECUTED"));
    }
    return this.delegate.executed(id);
  }

  public verified(id: string, workspaceFingerprint: string): Promise<ActionJournalRecord> {
    return this.delegate.verified(id, workspaceFingerprint);
  }
}

function codeAgent(
  workspace: string,
  eventLog: EventLog,
  runId: string,
  provider: FakeChatProvider,
  actionJournal: ActionJournal,
): CodeAgent {
  const fileIndex = new WorkspaceFileIndex();
  const executor = new ScopedToolExecutor({
    registry: new ToolRegistry([
      new GlobTool(fileIndex),
      new GrepTool(fileIndex),
      new ReadFileTool(),
      new WriteFileTool(),
      new EditFileTool(),
      new GitDiffTool(),
    ]),
    eventLog,
    runId,
    stage: "CODE",
    agentTools: CODE_TOOLS,
    policy: new ToolPolicy({
      workspaceRoot: workspace,
      stage: "CODE",
      allowedTools: CODE_TOOLS,
      writable: true,
      maxResultBytes: 128_000,
    }),
    policyResolver: new RulePolicyResolver("allow", []),
    approvalGateway: new AutoApprovalGateway(),
  });
  return new CodeAgent({
    provider,
    model: "test-model",
    eventLog,
    toolExecutor: executor,
    budget: DEFAULT_TOKEN_BUDGETS.CODE,
    memory: new NoopMemoryProvider(),
    actionJournal,
  });
}

function codeContext(workspace: string, runId: string) {
  let context = createTaskContext({
    runId,
    requirement: "Update the example value",
    repoPath: workspace,
    branch: `forgemind/${runId}`,
    tokenBudget: DEFAULT_TOKEN_BUDGETS,
  });
  context = withPlan(
    context,
    {
      objective: "Update the value",
      steps: [{ id: "1", title: "Edit", description: "Edit example.js" }],
      acceptanceCriteria: [testSuiteCriterion("AC-1", "Value is 2")],
      summary: "Update example.js",
    },
    { path: "plan.md", kind: "plan", stage: "PLAN", summary: "Plan" },
  );
  return withArchitecture(
    context,
    {
      decisions: ["Use the existing file"],
      files: [{ path: "example.js", purpose: "Implementation" }],
      risks: ["Crashes"],
      summary: "Edit example.js in place",
    },
    { path: "architecture.md", kind: "architecture", stage: "ARCH", summary: "Architecture" },
  );
}
