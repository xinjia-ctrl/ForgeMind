import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventDataMap, EventType, ForgeMindEvent } from "../../src/core/events.js";
import { buildReportViewModel, MAX_REPORT_EVENTS } from "../../src/report/view-model.js";

describe("report view model", () => {
  it("projects timeline groups, gate rework, artifacts, and auditable statistics", () => {
    const events = [
      event(1, "run.started", {
        runId: "report-run",
        requirement: "Add observability",
        branch: "forgemind/report-run",
      }),
      event(2, "stage.started", { runId: "report-run", stage: "PLAN", attempt: 1 }),
      event(3, "llm.called", {
        runId: "report-run",
        stage: "PLAN",
        model: "test-model",
        inputTokens: 120,
        outputTokens: 30,
        promptFingerprint: "fingerprint",
      }),
      event(4, "tool.called", {
        runId: "report-run",
        stage: "PLAN",
        tool: "read_file",
        args: { path: "README.md" },
        result: { ok: true, value: "done" },
        policy: "read only",
      }),
      event(5, "artifact.produced", {
        runId: "report-run",
        stage: "PLAN",
        path: "plan.md",
        kind: "plan",
        summary: "Implementation plan",
      }),
      event(6, "stage.completed", {
        runId: "report-run",
        stage: "PLAN",
        status: "SUCCEEDED",
      }),
      event(7, "stage.started", { runId: "report-run", stage: "REVIEW", attempt: 1 }),
      event(8, "gate.rejected", {
        runId: "report-run",
        stage: "REVIEW",
        reason: "Missing test",
        feedback: "Add coverage",
      }),
      event(9, "stage.completed", {
        runId: "report-run",
        stage: "REVIEW",
        status: "SUCCEEDED",
      }),
      event(10, "stage.started", { runId: "report-run", stage: "CODE", attempt: 2 }),
      event(11, "stage.completed", {
        runId: "report-run",
        stage: "CODE",
        status: "SUCCEEDED",
      }),
      event(12, "stage.started", { runId: "report-run", stage: "REVIEW", attempt: 2 }),
      event(13, "gate.passed", {
        runId: "report-run",
        stage: "REVIEW",
        evidence: "Coverage added",
      }),
      event(14, "stage.completed", {
        runId: "report-run",
        stage: "REVIEW",
        status: "SUCCEEDED",
      }),
      event(15, "run.finished", {
        runId: "report-run",
        status: "SUCCEEDED",
        summary: "Complete",
      }),
    ] satisfies readonly ForgeMindEvent[];

    const report = buildReportViewModel(events);

    assert.equal(report.runId, "report-run");
    assert.equal(report.status, "SUCCEEDED");
    assert.deepEqual(
      report.timeline.map((group) => [group.stage, group.attempt]),
      [
        [null, null],
        ["PLAN", 1],
        ["REVIEW", 1],
        ["CODE", 2],
        ["REVIEW", 2],
        [null, null],
      ],
    );
    assert.deepEqual(
      report.gates.map((gate) => [gate.attempt, gate.passed, gate.rework]),
      [
        [1, false, true],
        [2, true, true],
      ],
    );
    assert.deepEqual(
      report.artifacts.map((artifact) => artifact.path),
      ["plan.md"],
    );
    assert.deepEqual(report.stats.total, {
      inputTokens: 120,
      outputTokens: 30,
      toolCalls: 1,
      durationMs: 14_000,
    });
    const plan = report.stats.perStage.find((stats) => stats.stage === "PLAN");
    const review = report.stats.perStage.find((stats) => stats.stage === "REVIEW");
    assert.deepEqual(plan, {
      stage: "PLAN",
      llmCalls: 1,
      inputTokens: 120,
      outputTokens: 30,
      toolCalls: 1,
      durationMs: 4_000,
    });
    assert.equal(review?.durationMs, 4_000);
  });

  it("locates typed failures without inventing a duration", () => {
    const report = buildReportViewModel([
      event(1, "run.started", {
        runId: "failed-run",
        requirement: "Fail safely",
        branch: "forgemind/failed-run",
      }),
      event(2, "stage.started", { runId: "failed-run", stage: "CODE", attempt: 1 }),
      event(3, "stage.failed", {
        runId: "failed-run",
        stage: "CODE",
        kind: "HARD",
        error: "Policy denied",
      }),
      event(4, "run.finished", {
        runId: "failed-run",
        status: "FAILED",
        summary: "Policy denied",
      }),
    ]);

    assert.deepEqual(report.failure, {
      stage: "CODE",
      kind: "HARD",
      message: "Policy denied",
    });
    assert.equal(report.stats.perStage.find((stats) => stats.stage === "CODE")?.durationMs, null);
  });

  it("projects bounded negotiation events into the auditable timeline", () => {
    const report = buildReportViewModel([
      event(1, "negotiation.started", {
        runId: "negotiation-report-run",
        negotiationId: "negotiation-id",
        trigger: "review-repeated-rejection",
        topic: "Resolve repeated review feedback",
      }),
      event(2, "negotiation.round", {
        runId: "negotiation-report-run",
        negotiationId: "negotiation-id",
        round: 1,
        status: "CONVERGED",
        proposal: "<redacted>",
        counter: "<redacted>",
      }),
      event(3, "negotiation.resolved", {
        runId: "negotiation-report-run",
        negotiationId: "negotiation-id",
        decisionRecordId: "decision-id",
        decision: "<redacted>",
      }),
    ]);
    const timeline = report.timeline.flatMap((group) => group.events);
    assert.deepEqual(
      timeline.map((item) => [item.type, item.outcome]),
      [
        ["negotiation.started", "started"],
        ["negotiation.round", "CONVERGED"],
        ["negotiation.resolved", "resolved"],
      ],
    );
    assert.deepEqual(timeline[1]?.details, {
      runId: "negotiation-report-run",
      negotiationId: "negotiation-id",
      round: 1,
      status: "CONVERGED",
      proposal: "<redacted>",
      counter: "<redacted>",
    });
  });

  it("projects approval events into a re-audited security panel", () => {
    const report = buildReportViewModel([
      event(1, "approval.requested", {
        runId: "security-run",
        stage: "COMMIT",
        tool: "git_commit",
        action: { args: { content: "PRIVATE" } },
        policy: "rule:8:approve",
        mode: "approve",
        actor: "alice",
        role: "approver",
      }),
      event(2, "approval.approved", {
        runId: "security-run",
        stage: "COMMIT",
        tool: "git_commit",
        action: { args: { content: "PRIVATE" } },
        policy: "rule:8:approve",
        mode: "approve",
        decisionSource: "auto",
        actor: "alice",
        role: "approver",
      }),
    ]);

    assert.deepEqual(
      report.security.map((item) => [item.decision, item.action, item.source]),
      [
        ["REQUESTED", "git_commit", undefined],
        ["APPROVED", "git_commit", "auto"],
      ],
    );
    assert.doesNotMatch(JSON.stringify(report.security), /PRIVATE/);
    assert.deepEqual(
      report.security.map((item) => [item.actor, item.role]),
      [
        ["alice", "approver"],
        ["alice", "approver"],
      ],
    );
  });

  it("projects memory, prompt versions, and source-labelled context without content", () => {
    const report = buildReportViewModel([
      event(1, "memory.recalled", {
        runId: "intelligence-run",
        stage: "PLAN",
        scope: "episodic",
        source: "runs/previous.jsonl",
        score: 1.25,
        reason: "requirement overlap: health",
        content: "<redacted:42 bytes>",
        used: true,
      }),
      event(2, "memory.stored", {
        runId: "intelligence-run",
        stage: "ARCH",
        scope: "project",
        kind: "decision",
        path: ".forgemind/memory/decisions.json",
      }),
      event(3, "context.assembled", {
        runId: "intelligence-run",
        stage: "CODE",
        sections: [
          {
            name: "Bounded workspace context",
            source: "retrieval",
            tokenEstimate: 128,
            references: ["src/router.ts"],
          },
        ],
        tokenEstimate: 128,
      }),
      event(4, "llm.called", {
        runId: "intelligence-run",
        stage: "CODE",
        model: "test-model",
        inputTokens: 128,
        outputTokens: 32,
        promptFingerprint: "fingerprint",
        promptVersion: "code.v1",
        structuredOutput: true,
      }),
    ]);

    assert.deepEqual(
      report.memory.map((item) => [item.operation, item.scope, item.source, item.used]),
      [
        ["RECALLED", "episodic", "runs/previous.jsonl", true],
        ["STORED", "project", ".forgemind/memory/decisions.json", undefined],
      ],
    );
    assert.deepEqual(report.prompts, [
      {
        seq: 4,
        stage: "CODE",
        model: "test-model",
        version: "code.v1",
        structuredOutput: true,
      },
    ]);
    assert.equal(report.contexts[0]?.sections[0]?.references[0], "src/router.ts");
    assert.doesNotMatch(JSON.stringify(report), /redacted:42/);
  });

  it("keeps historical failures honest and handles an empty log", () => {
    const historical = buildReportViewModel([
      event(1, "stage.failed", {
        runId: "legacy-run",
        stage: "TEST",
        error: "Old schema failure",
      }),
    ]);
    assert.equal(historical.failure?.kind, "UNKNOWN");

    const empty = buildReportViewModel([]);
    assert.equal(empty.runId, "unknown");
    assert.equal(empty.status, "RUNNING");
    assert.equal(empty.stats.total.durationMs, null);
    assert.equal(empty.timeline.length, 0);
  });

  it("caps long timelines while retaining gates and failures", () => {
    const events: ForgeMindEvent[] = [
      event(1, "run.started", {
        runId: "long-run",
        requirement: "Long workflow",
        branch: "forgemind/long-run",
      }),
      event(2, "stage.started", { runId: "long-run", stage: "CODE", attempt: 1 }),
    ];
    for (let seq = 3; seq <= 2_003; seq += 1) {
      events.push(
        event(seq, "llm.called", {
          runId: "long-run",
          stage: "CODE",
          model: "test-model",
          inputTokens: 1,
          outputTokens: 1,
          promptFingerprint: `fingerprint-${seq}`,
        }),
      );
    }
    events.push(
      event(2_004, "tool.called", {
        runId: "long-run",
        stage: "CODE",
        tool: "write_file",
        args: { path: "x" },
        result: { ok: false, error: "denied" },
        policy: "write scoped",
      }),
      event(2_005, "gate.rejected", {
        runId: "long-run",
        stage: "REVIEW",
        reason: "Defect",
        feedback: "Fix it",
      }),
      event(2_006, "stage.failed", {
        runId: "long-run",
        stage: "CODE",
        kind: "STAGE",
        error: "Stopped",
      }),
      event(2_007, "run.finished", {
        runId: "long-run",
        status: "FAILED",
        summary: "Stopped",
      }),
    );

    const report = buildReportViewModel(events);
    const displayedSequences = report.timeline.flatMap((group) =>
      group.events.map((item) => item.seq),
    );
    assert.equal(report.truncated, true);
    assert.equal(report.displayedEvents, MAX_REPORT_EVENTS);
    assert.equal(report.totalEvents, 2_007);
    for (const sequence of [2_004, 2_005, 2_006, 2_007]) {
      assert.ok(displayedSequences.includes(sequence), `missing critical event ${sequence}`);
    }
  });
});

function event<K extends EventType>(
  seq: number,
  type: K,
  data: EventDataMap[K],
): Extract<ForgeMindEvent, { readonly type: K }> {
  return {
    v: 1,
    seq,
    ts: new Date(seq * 1_000).toISOString(),
    type,
    data,
  } as Extract<ForgeMindEvent, { readonly type: K }>;
}
