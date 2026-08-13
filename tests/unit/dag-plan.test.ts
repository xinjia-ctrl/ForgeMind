import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DagPlanner, parseDagPlan, validateDagTasks } from "../../src/dag/plan.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";

describe("DAG planning", () => {
  it("parses a bounded multi-repository plan and sends a structured schema", async () => {
    const provider = new FakeChatProvider([
      JSON.stringify({
        summary: "Backend and frontend in parallel, then integration",
        tasks: [
          { taskId: "backend", deps: [], repo: "/repos/api", requirement: "Add API" },
          { taskId: "frontend", deps: [], repo: "/repos/web", requirement: "Add UI" },
          {
            taskId: "integration",
            deps: ["backend", "frontend"],
            repo: "/repos/web",
            requirement: "Integrate UI",
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
            tasks: [{ taskId: "a", deps: [], repo: "/unknown", requirement: "x" }],
          }),
          ["/repo"],
        ),
      /unknown repository/,
    );
    assert.throws(
      () => validateDagTasks([{ taskId: "a", deps: ["missing"], repo: "/repo", requirement: "x" }]),
      /unknown task missing/,
    );
    assert.throws(
      () =>
        validateDagTasks([
          { taskId: "same", deps: [], repo: "/repo", requirement: "x" },
          { taskId: "same", deps: [], repo: "/repo", requirement: "y" },
        ]),
      /Duplicate task id/,
    );
    assert.throws(
      () =>
        validateDagTasks([
          { taskId: "a", deps: ["b"], repo: "/repo", requirement: "x" },
          { taskId: "b", deps: ["a"], repo: "/repo", requirement: "y" },
        ]),
      /dependency cycle/,
    );
  });
});
