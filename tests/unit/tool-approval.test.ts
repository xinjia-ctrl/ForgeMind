import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import type { ApprovalDecision, ApprovalGateway } from "../../src/policy/gateway.js";
import type { ApprovalContext } from "../../src/auth/types.js";
import { RulePolicyResolver } from "../../src/policy/resolver.js";
import type { ActionRequest } from "../../src/policy/types.js";
import { ScopedToolExecutor, ToolRegistry } from "../../src/tools/executor.js";
import { ToolPolicy, type Tool } from "../../src/tools/types.js";

describe("tool approval audit", () => {
  it("records requested and approved before execution", async () => {
    const fixture = await createFixture("approve", "APPROVED");
    try {
      const result = await fixture.executor.execute("dangerous", { content: "private" });
      assert.equal(result.ok, true);
      assert.equal(fixture.tool.executions, 1);
      const events = await fixture.log.load();
      assert.deepEqual(
        events.map((event) => event.type),
        ["approval.requested", "approval.approved", "tool.called"],
      );
      const requested = events[0];
      assert.ok(requested);
      assert.equal(requested.type, "approval.requested");
      assert.doesNotMatch(JSON.stringify(requested.data.action), /private/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("records policy and human rejection without executing", async () => {
    for (const [mode, decision] of [
      ["deny", "APPROVED"],
      ["approve", "DENIED"],
    ] as const) {
      const fixture = await createFixture(mode, decision);
      try {
        const result = await fixture.executor.execute("dangerous", {});
        assert.equal(result.ok, false);
        assert.equal(fixture.tool.executions, 0);
        const events = await fixture.log.load();
        assert.ok(events.some((event) => event.type === "approval.rejected"));
        assert.equal(events.at(-1)?.type, "tool.called");
      } finally {
        await fixture.cleanup();
      }
    }
  });

  it("denies an underprivileged actor before calling the approval gateway", async () => {
    const fixture = await createFixture("approve", "APPROVED", {
      actor: { id: "dev", role: "developer", repos: ["/repo"] },
      scope: { repo: "/repo" },
      risk: "high",
    });
    try {
      const result = await fixture.executor.execute("dangerous", {});
      assert.equal(result.ok, false);
      assert.equal(fixture.gateway.requests, 0);
      assert.equal(fixture.tool.executions, 0);
      const events = await fixture.log.load();
      const rejected = events.find((event) => event.type === "approval.rejected");
      assert.ok(rejected);
      assert.equal(rejected.data.actor, "dev");
      assert.equal(rejected.data.role, "developer");
      assert.equal(rejected.data.decisionSource, "policy");
    } finally {
      await fixture.cleanup();
    }
  });

  it("records an authorized actor and role on approval events", async () => {
    for (const [role, risk, expectedGatewayRequests] of [
      ["developer", "medium", 1],
      ["approver", "high", 1],
      ["viewer", "low", 0],
    ] as const) {
      const fixture = await createFixture("approve", "APPROVED", {
        actor: { id: role, role, repos: ["/repo"] },
        scope: { repo: "/repo" },
        risk,
      });
      try {
        const result = await fixture.executor.execute("dangerous", {});
        assert.equal(result.ok, true);
        assert.equal(fixture.gateway.requests, expectedGatewayRequests);
        const events = await fixture.log.load();
        const approved = events.find((event) => event.type === "approval.approved");
        assert.ok(approved);
        assert.equal(approved.data.actor, role);
        assert.equal(approved.data.role, role);
        assert.equal(approved.data.decisionSource, risk === "low" ? "config" : "auto");
      } finally {
        await fixture.cleanup();
      }
    }
  });

  it("records policy risk even when legacy callers do not provide an actor", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-policy-risk-"));
    const log = await EventLog.create(directory, "policy-risk");
    try {
      const tool = new CountingTool();
      const executor = new ScopedToolExecutor({
        registry: new ToolRegistry([tool]),
        eventLog: log,
        runId: "policy-risk",
        stage: "CODE",
        agentTools: ["dangerous"],
        policy: new ToolPolicy({
          workspaceRoot: directory,
          stage: "CODE",
          allowedTools: ["dangerous"],
          writable: true,
        }),
        policyResolver: new RulePolicyResolver("deny", [
          { match: { tool: "dangerous" }, mode: "approve", risk: "medium" },
        ]),
        approvalGateway: new FakeGateway("APPROVED"),
      });
      assert.equal((await executor.execute("dangerous", {})).ok, true);
      const requested = (await log.load()).find((event) => event.type === "approval.requested");
      assert.ok(requested);
      assert.equal(requested.data.risk, "medium");
      assert.equal(requested.data.actor, undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function createFixture(
  mode: "approve" | "deny",
  decision: ApprovalDecision,
  approvalContext?: ApprovalContext,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-approval-"));
  const log = await EventLog.create(directory, `approval-${mode}`);
  const tool = new CountingTool();
  const gateway = new FakeGateway(decision);
  return {
    log,
    tool,
    gateway,
    executor: new ScopedToolExecutor({
      registry: new ToolRegistry([tool]),
      eventLog: log,
      runId: `approval-${mode}`,
      stage: "CODE",
      agentTools: ["dangerous"],
      policy: new ToolPolicy({
        workspaceRoot: directory,
        stage: "CODE",
        allowedTools: ["dangerous"],
        writable: true,
      }),
      policyResolver: new RulePolicyResolver("deny", [{ match: { tool: "dangerous" }, mode }]),
      approvalGateway: gateway,
      ...(approvalContext === undefined ? {} : { approvalContext }),
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

class FakeGateway implements ApprovalGateway {
  public readonly source = "auto";
  public requests = 0;

  public constructor(private readonly decision: ApprovalDecision) {}

  public request(_action: ActionRequest, _context?: ApprovalContext): Promise<ApprovalDecision> {
    this.requests += 1;
    return Promise.resolve(this.decision);
  }
}

class CountingTool implements Tool {
  public readonly name = "dangerous";
  public readonly description = "A test action";
  public readonly parameters = {};
  public executions = 0;

  public execute(): Promise<{ ok: true }> {
    this.executions += 1;
    return Promise.resolve({ ok: true });
  }
}
