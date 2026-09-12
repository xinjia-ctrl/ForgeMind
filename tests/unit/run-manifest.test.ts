import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { testSuiteCriterion } from "../../src/core/acceptance.js";
import { createTaskContext, withPlan } from "../../src/core/context.js";
import {
  assertResumeManifest,
  manifestForContext,
  type RunManifest,
} from "../../src/core/run-manifest.js";

it("binds recovery to the generated acceptance contract and all runtime inputs", () => {
  let context = createTaskContext({
    runId: "manifest-run",
    requirement: "Add a feature",
    repoPath: "/repo",
    branch: "forgemind/manifest-run",
    tokenBudget: DEFAULT_TOKEN_BUDGETS,
  });
  context = withPlan(
    context,
    {
      objective: "Add a feature",
      steps: [{ id: "1", title: "Implement", description: "Implement it" }],
      acceptanceCriteria: [testSuiteCriterion("AC-1", "Tests pass")],
      summary: "Plan",
    },
    {
      path: "/git/runs/manifest-run/artifacts/plan.md",
      kind: "plan",
      stage: "PLAN",
      summary: "Plan",
    },
  );
  const base: RunManifest = {
    requirementHash: "requirement",
    acceptanceContractHash: "",
    initialHead: "head",
    provider: "provider",
    model: "model-a",
    promptVersions: { CODE: "code.v4" },
    policyHash: "policy",
    testCommandHash: "test",
    budgetHash: "budget",
  };
  const restored = manifestForContext(base, context);

  assert.doesNotThrow(() => assertResumeManifest(base, restored, context));
  assert.throws(
    () => assertResumeManifest({ ...base, model: "model-b" }, restored, context),
    /runtime configuration/,
  );
  assert.throws(
    () => assertResumeManifest(base, { ...restored, acceptanceContractHash: "tampered" }, context),
    /acceptance contract fingerprint/,
  );
});
