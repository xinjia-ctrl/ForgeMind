import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { assertAcceptanceSatisfied, assertCompleteEvidence } from "../../src/core/acceptance.js";
import { createTaskContext, withGate, withPlan } from "../../src/core/context.js";
import type { AcceptanceCriterion } from "../../src/core/types.js";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { AcceptanceVerifierRegistry } from "../../src/verification/acceptance-verifier.js";

describe("acceptance verifier registry", () => {
  it("blocks acceptance when the test suite exits zero but a dedicated file verifier fails", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forgemind-verifier-"));
    try {
      await writeFile(path.join(workspace, "PWNED.txt"), "unexpected\n", "utf8");
      const criterion: AcceptanceCriterion = {
        id: "AC-1",
        description: "PWNED.txt is not created",
        requiredEvidence: ["test"],
        verifier: { kind: "file", path: "PWNED.txt", assertion: "absent" },
      };
      const registry = new AcceptanceVerifierRegistry({
        workspaceRoot: workspace,
        commands: { primary: ["node", "--test"] },
      });
      const evidence = await registry.verify([criterion], "workspace-v1", () =>
        Promise.resolve({ ok: true, data: { stdout: "all tests passed", stderr: "" } }),
      );

      const fileEvidence = evidence[0];
      assert.ok(fileEvidence);
      assert.equal(fileEvidence.passed, false);
      assert.match(fileEvidence.details, /absent=false/);

      let context = createTaskContext({
        runId: "verifier-run",
        requirement: "Do not create PWNED.txt",
        repoPath: workspace,
        branch: "forgemind/verifier-run",
        tokenBudget: DEFAULT_TOKEN_BUDGETS,
      });
      context = withPlan(
        context,
        {
          objective: "Keep the file absent",
          steps: [{ id: "1", title: "Implement", description: "Implement safely" }],
          acceptanceCriteria: [criterion],
          summary: "Verify absence",
        },
        { path: "plan.md", kind: "plan", stage: "PLAN", summary: "Plan" },
      );
      context = withGate(context, {
        stage: "TEST",
        attempt: 1,
        passed: false,
        reason: "Dedicated verifier failed",
        feedback: "Remove PWNED.txt",
        evidence: "primary command exited 0",
        artifactFingerprint: "workspace-v1",
        verificationEvidence: evidence,
      });
      context = withGate(context, {
        stage: "REVIEW",
        attempt: 1,
        passed: true,
        reason: "Approved",
        feedback: "None",
        evidence: "Reviewed",
        artifactFingerprint: "workspace-v1",
        verificationEvidence: [],
      });

      assert.throws(() => assertAcceptanceSatisfied(context), /passing TEST and REVIEW gates/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires a test-case pattern and executes a registered behavior probe", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forgemind-verifier-pattern-"));
    try {
      const registry = new AcceptanceVerifierRegistry({
        workspaceRoot: workspace,
        commands: { primary: ["node", "--test"] },
        probes: [{ id: "signed-sum", command: ["node", "probe.js"] }],
      });
      const calls: string[] = [];
      const evidence = await registry.verify(
        [
          {
            id: "AC-1",
            description: "named regression executes",
            requiredEvidence: ["test"],
            verifier: { kind: "test-case", commandId: "primary", pattern: "signed sums" },
          },
          {
            id: "AC-2",
            description: "signed sum behavior is correct",
            requiredEvidence: ["test"],
            verifier: { kind: "behavior", probeId: "signed-sum" },
          },
        ],
        "workspace-v2",
        (command) => {
          calls.push(command.join(" "));
          return Promise.resolve({
            ok: true,
            data: {
              stdout: command.includes("probe.js") ? "behavior ok" : "other test passed",
              stderr: "",
            },
          });
        },
      );

      assert.deepEqual(
        evidence.map((item) => item.passed),
        [false, true],
      );
      assert.deepEqual(calls, ["node --test", "node probe.js"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects evidence whose source does not match the criterion verifier", () => {
    const criterion: AcceptanceCriterion = {
      id: "AC-1",
      description: "the named test is observed",
      requiredEvidence: ["test"],
      verifier: { kind: "test-case", commandId: "primary", pattern: "named test" },
    };
    assert.throws(
      () =>
        assertCompleteEvidence([criterion], "TEST", {
          artifactFingerprint: "workspace-v3",
          verificationEvidence: [
            {
              criterionId: "AC-1",
              verifierKind: "test-case",
              source: "test:command:primary",
              artifactFingerprint: "workspace-v3",
              passed: true,
              details: "generic suite passed but the named case was not bound",
            },
          ],
        }),
      /invalid verification evidence/,
    );
  });
});
