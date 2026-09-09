import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DagPlanner, parseDagPlan, validateDagTasks } from "../../src/dag/plan.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { testSuiteCriterion } from "../../src/core/acceptance.js";
import { RunBudgetTracker, RunStopFailure } from "../../src/core/run-budget.js";

describe("DAG planning", () => {
  it("parses a bounded multi-repository plan and sends a structured schema", async () => {
    const provider = new FakeChatProvider([
      JSON.stringify({
        summary: "Backend and frontend in parallel, then integration",
        tasks: [
          {
            taskId: "backend",
            deps: [],
            repo: "/repos/api",
            requirement: "Add API",
            acceptanceCriteria: [criterionJson("API is available")],
          },
          {
            taskId: "frontend",
            deps: [],
            repo: "/repos/web",
            requirement: "Add UI",
            acceptanceCriteria: [criterionJson("UI is available")],
          },
          {
            taskId: "integration",
            deps: ["backend", "frontend"],
            repo: "/repos/web",
            requirement: "Integrate UI",
            acceptanceCriteria: [criterionJson("UI uses the API")],
          },
        ],
      }),
    ]);
    const plan = await new DagPlanner({ provider, model: "fake-model" }).plan("Ship feature", [
      "/repos/api",
      "/repos/web",
    ]);

    assert.deepEqual(
      plan.tasks.map((task) => task.taskId),
      ["backend", "frontend", "integration"],
    );
    assert.equal(provider.calls[0]?.options.structuredOutput?.name, "forgemind_dag_plan_v1");
  });

  it("rejects unknown repositories, dependencies, duplicate ids, and cycles", () => {
    assert.throws(
      () =>
        parseDagPlan(
          JSON.stringify({
            summary: "bad repo",
            tasks: [
              {
                taskId: "a",
                deps: [],
                repo: "/unknown",
                requirement: "x",
                acceptanceCriteria: [criterionJson("x works")],
              },
            ],
          }),
          ["/repo"],
        ),
      /unknown repository/,
    );
    assert.throws(
      () =>
        validateDagTasks([
          {
            taskId: "a",
            deps: ["missing"],
            repo: "/repo",
            requirement: "x",
            acceptanceCriteria: [testSuiteCriterion("AC-1", "x works")],
          },
        ]),
      /unknown task missing/,
    );
    assert.throws(
      () =>
        validateDagTasks([
          {
            taskId: "same",
            deps: [],
            repo: "/repo",
            requirement: "x",
            acceptanceCriteria: [testSuiteCriterion("AC-1", "x works")],
          },
          {
            taskId: "same",
            deps: [],
            repo: "/repo",
            requirement: "y",
            acceptanceCriteria: [testSuiteCriterion("AC-1", "y works")],
          },
        ]),
      /Duplicate task id/,
    );
    assert.throws(
      () =>
        validateDagTasks([
          {
            taskId: "a",
            deps: ["b"],
            repo: "/repo",
            requirement: "x",
            acceptanceCriteria: [testSuiteCriterion("AC-1", "x works")],
          },
          {
            taskId: "b",
            deps: ["a"],
            repo: "/repo",
            requirement: "y",
            acceptanceCriteria: [testSuiteCriterion("AC-1", "y works")],
          },
        ]),
      /dependency cycle/,
    );
  });

  it("charges DAG planning to the shared run budget", async () => {
    const provider = new FakeChatProvider([
      JSON.stringify({
        summary: "one task",
        tasks: [
          {
            taskId: "only",
            deps: [],
            repo: "/repo",
            requirement: "Do it",
            acceptanceCriteria: [criterionJson("it works")],
          },
        ],
      }),
    ]);
    const budget = new RunBudgetTracker({
      maxLlmCalls: 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 5_000,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
    });
    const planner = new DagPlanner({ provider, model: "fake-model", runBudget: budget });
    await planner.plan("Do it", ["/repo"]);
    await assert.rejects(
      () => planner.plan("Do it again", ["/repo"]),
      (error: unknown) =>
        error instanceof RunStopFailure && error.stopReason === "BUDGET_EXHAUSTED",
    );
  });
});

function criterionJson(description: string) {
  const criterion = testSuiteCriterion("AC-1", description);
  return {
    description: criterion.description,
    requiredEvidence: criterion.requiredEvidence,
    verifier: criterion.verifier,
  };
}
