import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseAgenticConfig } from "../../src/agentic/config.js";
import { agenticRunGovernance, escalateAgenticRisk } from "../../src/agentic/guardrail.js";
import type { ApprovalContext } from "../../src/auth/types.js";
import { EventLog } from "../../src/core/event-log.js";
import type { ApprovalGateway } from "../../src/policy/gateway.js";
import { RulePolicyResolver } from "../../src/policy/resolver.js";
import type { ActionRequest } from "../../src/policy/types.js";
import { ScopedToolExecutor, ToolRegistry } from "../../src/tools/executor.js";
import { ToolPolicy, type Tool } from "../../src/tools/types.js";

describe("agentic guardrails", () => {
  it("escalates risk and projects an explicit actor/tool/command allowlist", () => {
    assert.equal(escalateAgenticRisk("low"), "medium");
    assert.equal(escalateAgenticRisk("medium"), "high");
    assert.equal(escalateAgenticRisk("high"), "high");
    const governance = agenticRunGovernance(config(), "acme/api");
    assert.equal(governance.actor.id, "agentic");
    assert.equal(governance.actor.role, "developer");
    assert.deepEqual(governance.toolAllowlist, ["read_file"]);
    assert.deepEqual(governance.commandAllowlist, []);
    assert.throws(() => agenticRunGovernance(config(), "outside/repo"), /not authorized/);
  });

  it("applies risk escalation before RBAC and approval dispatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-agentic-risk-"));
    try {
      const eventLog = await EventLog.create(directory, "agentic-risk");
      const contexts: ApprovalContext[] = [];
      const gateway: ApprovalGateway = {
        source: "auto",
        request(_action: ActionRequest, context?: ApprovalContext) {
          if (context !== undefined) contexts.push(context);
          return Promise.resolve("APPROVED");
        },
      };
      const tool: Tool = {
        name: "safe_tool",
        description: "fixture",
        parameters: {},
        execute() {
          return Promise.resolve({ ok: true });
        },
      };
      const executor = new ScopedToolExecutor({
        registry: new ToolRegistry([tool]),
        eventLog,
        runId: "agentic-risk",
        stage: "CODE",
        agentTools: ["safe_tool"],
        policy: new ToolPolicy({
          workspaceRoot: directory,
          stage: "CODE",
          allowedTools: ["safe_tool"],
          writable: false,
        }),
        policyResolver: new RulePolicyResolver("deny", [
          { match: { tool: "safe_tool" }, mode: "approve", risk: "low" },
        ]),
        approvalGateway: gateway,
        approvalContext: {
          actor: { id: "agentic", role: "developer", repos: ["acme/api"] },
          scope: { repo: "acme/api" },
          risk: "low",
        },
        riskTransform: escalateAgenticRisk,
      });

      assert.equal((await executor.execute("safe_tool", {})).ok, true);
      assert.equal(contexts[0]?.risk, "medium");
      const requested = (await eventLog.load()).find(
        (event) => event.type === "approval.requested",
      );
      assert.ok(requested?.type === "approval.requested");
      assert.equal(requested.data.risk, "medium");
      assert.equal(requested.data.actor, "agentic");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function config() {
  return parseAgenticConfig({
    repositories: ["acme/api"],
    guardrails: { allowedTools: ["read_file"], allowedCommands: [] },
    rules: [
      {
        id: "issue",
        match: { type: "issue.updated" },
        run: { requirement: "Inspect issue" },
      },
    ],
  });
}
