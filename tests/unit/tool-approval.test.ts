import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import type { ApprovalDecision, ApprovalGateway } from "../../src/policy/gateway.js";
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
});

async function createFixture(mode: "approve" | "deny", decision: ApprovalDecision) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-approval-"));
  const log = await EventLog.create(directory, `approval-${mode}`);
  const tool = new CountingTool();
  const gateway = new FakeGateway(decision);
  return {
    log,
    tool,
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
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

class FakeGateway implements ApprovalGateway {
  public readonly source = "auto";

  public constructor(private readonly decision: ApprovalDecision) {}

  public request(_action: ActionRequest): Promise<ApprovalDecision> {
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
