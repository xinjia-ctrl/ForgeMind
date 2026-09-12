import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { PlanAgent, PLAN_TOOLS } from "../../src/agents/plan-agent.js";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { createTaskContext } from "../../src/core/context.js";
import { EventLog } from "../../src/core/event-log.js";
import { RunBudgetTracker } from "../../src/core/run-budget.js";
import { FileRunArtifactStore } from "../../src/core/run-artifact-store.js";
import type { AcceptanceCriterion } from "../../src/core/types.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { AutoApprovalGateway } from "../../src/policy/auto-gateway.js";
import { RulePolicyResolver } from "../../src/policy/resolver.js";
import { ScopedToolExecutor, ToolRegistry } from "../../src/tools/executor.js";
import { ToolPolicy } from "../../src/tools/types.js";

it("preserves externally supplied acceptance criteria byte-for-byte", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-plan-agent-"));
  try {
    const eventLog = await EventLog.create(directory, "plan-run");
    const external: readonly AcceptanceCriterion[] = [
      {
        id: "AC-7",
        description: "PWNED.txt is absent",
        requiredEvidence: ["test"],
        verifier: { kind: "file", path: "PWNED.txt", assertion: "absent" },
      },
    ];
    const provider = new FakeChatProvider([
      JSON.stringify({
        objective: "Implement safely",
        steps: [{ title: "Implement", description: "Make the scoped change" }],
        acceptanceCriteria: "malformed model criteria must be ignored",
        summary: "Safe plan",
      }),
    ]);
    const executor = new ScopedToolExecutor({
      registry: new ToolRegistry([]),
      eventLog,
      runId: "plan-run",
      stage: "PLAN",
      agentTools: PLAN_TOOLS,
      policy: new ToolPolicy({
        workspaceRoot: directory,
        stage: "PLAN",
        allowedTools: PLAN_TOOLS,
        writable: false,
      }),
      policyResolver: new RulePolicyResolver("deny", []),
      approvalGateway: new AutoApprovalGateway(),
    });
    const agent = new PlanAgent({
      provider,
      model: "test-model",
      eventLog,
      toolExecutor: executor,
      budget: DEFAULT_TOKEN_BUDGETS.PLAN,
      artifactStore: new FileRunArtifactStore(path.join(directory, "artifacts")),
    });
    const context = createTaskContext({
      runId: "plan-run",
      requirement: "Implement safely",
      requiredAcceptanceCriteria: external,
      repoPath: directory,
      branch: "forgemind/plan-run",
      tokenBudget: DEFAULT_TOKEN_BUDGETS,
    });

    const output = await agent.run({ attempt: 1 }, context);

    assert.equal(output.kind, "plan");
    assert.deepEqual(output.plan.acceptanceCriteria, external);
    assert.match(provider.calls[0]?.messages.at(-1)?.content ?? "", /AC-7/);
    assert.match(output.artifact.path, /artifacts\/plan\.md$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("releases a failed model reservation so a later stage can use the shared budget", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-plan-budget-"));
  try {
    const sharedBudget = new RunBudgetTracker({
      maxLlmCalls: 2,
      maxInputTokens: 50_000,
      maxOutputTokens: DEFAULT_TOKEN_BUDGETS.PLAN.output,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
    });
    const external: readonly AcceptanceCriterion[] = [
      {
        id: "AC-1",
        description: "The task produces a plan",
        requiredEvidence: ["review"],
        verifier: { kind: "review", rubric: "Confirm the plan is concrete" },
      },
    ];
    const createAgent = async (runId: string, provider: FakeChatProvider): Promise<PlanAgent> => {
      const eventLog = await EventLog.create(directory, runId);
      const executor = new ScopedToolExecutor({
        registry: new ToolRegistry([]),
        eventLog,
        runId,
        stage: "PLAN",
        agentTools: PLAN_TOOLS,
        policy: new ToolPolicy({
          workspaceRoot: directory,
          stage: "PLAN",
          allowedTools: PLAN_TOOLS,
          writable: false,
        }),
        policyResolver: new RulePolicyResolver("deny", []),
        approvalGateway: new AutoApprovalGateway(),
      });
      return new PlanAgent({
        provider,
        model: "test-model",
        eventLog,
        toolExecutor: executor,
        budget: DEFAULT_TOKEN_BUDGETS.PLAN,
        runBudget: sharedBudget,
        artifactStore: new FileRunArtifactStore(path.join(directory, "artifacts", runId)),
      });
    };
    const createContext = (runId: string) =>
      createTaskContext({
        runId,
        requirement: "Create a safe plan",
        requiredAcceptanceCriteria: external,
        repoPath: directory,
        branch: `forgemind/${runId}`,
        tokenBudget: DEFAULT_TOKEN_BUDGETS,
      });

    const failedAgent = await createAgent("failed-stage", new FakeChatProvider([]));
    await assert.rejects(
      failedAgent.run({ attempt: 1 }, createContext("failed-stage")),
      /response queue exhausted/,
    );
    assert.equal(sharedBudget.snapshot().outputTokens, 0);

    const nextAgent = await createAgent(
      "next-stage",
      new FakeChatProvider([
        JSON.stringify({
          objective: "Create a safe plan",
          steps: [{ title: "Plan", description: "Describe the scoped change" }],
          summary: "Plan ready",
        }),
      ]),
    );
    const output = await nextAgent.run({ attempt: 1 }, createContext("next-stage"));

    assert.equal(output.kind, "plan");
    assert.equal(sharedBudget.snapshot().llmCalls, 2);
    assert.ok(sharedBudget.snapshot().outputTokens > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
