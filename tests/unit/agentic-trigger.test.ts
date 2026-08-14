import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgenticConfig } from "../../src/agentic/config.js";
import { AgenticTriggerEngine } from "../../src/agentic/trigger.js";
import type { DevelopmentEvent } from "../../src/agentic/types.js";
import { HardFailure } from "../../src/core/errors.js";

describe("agentic trigger engine", () => {
  it("deduplicates, merges objects, rate limits, queues, and enforces daily quota", () => {
    let now = Date.parse("2026-08-14T10:00:00Z");
    const engine = new AgenticTriggerEngine({
      config: config({ dailyTaskQuota: 2, rateLimit: { maxRuns: 1, windowMs: 60_000 } }),
      clock: () => now,
    });

    const first = event("event-1", "build-1");
    const triggered = engine.ingest(first);
    assert.equal(triggered.kind, "TRIGGER");
    assert.equal(triggered.request.requirement, "Diagnose build build-1 on acme/api (main)");
    assert.equal(triggered.request.actor, "agentic");

    assert.equal(engine.ingest(first).reason, "duplicate-event");
    assert.equal(engine.ingest(event("event-2", "build-1")).reason, "active-object-cooldown");

    const deferred = engine.ingest(event("event-3", "build-2"));
    assert.equal(deferred.reason, "global-rate-limit");
    assert.equal(engine.pendingCount, 1);
    assert.equal(engine.ingest(event("event-4", "build-2")).reason, "pending-object-merged");

    now += 60_000;
    const drained = engine.drainReady();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.kind, "TRIGGER");
    assert.deepEqual(drained[0].request.sourceEventIds, ["event-4"]);

    const quotaDeferred = engine.ingest(event("event-5", "build-3"));
    assert.equal(quotaDeferred.reason, "daily-task-quota");
    now = Date.parse("2026-08-15T00:00:00Z");
    assert.equal(engine.drainReady()[0]?.kind, "TRIGGER");
  });

  it("fails closed for unlisted repositories and unmatched events", () => {
    const engine = new AgenticTriggerEngine({ config: config({}) });
    assert.equal(
      engine.ingest(event("external", "1", "outside/repo")).reason,
      "repository-not-authorized",
    );
    assert.equal(
      engine.ingest({ ...event("issue", "2"), type: "issue.updated" }).reason,
      "no-matching-rule",
    );
  });

  it("strictly validates rule, repository, and guardrail configuration", () => {
    assert.throws(() => parseAgenticConfig({ ...rawConfig(), unexpected: true }), /Unknown option/);
    const invalid = rawConfig();
    invalid.rules[0] = {
      ...invalid.rules[0],
      match: { type: "ci.failed", repo: "outside/repo" },
    };
    assert.throws(() => parseAgenticConfig(invalid), HardFailure);
  });
});

function config(overrides: {
  readonly dailyTaskQuota?: number;
  readonly rateLimit?: { readonly maxRuns: number; readonly windowMs: number };
}) {
  return parseAgenticConfig({ ...rawConfig(), ...overrides });
}

function rawConfig(): {
  repositories: string[];
  dailyTaskQuota: number;
  rateLimit: { maxRuns: number; windowMs: number };
  dedupeTtlMs: number;
  guardrails: { allowedTools: string[]; allowedCommands: string[][] };
  rules: Array<Record<string, unknown>>;
} {
  return {
    repositories: ["acme/api"],
    dailyTaskQuota: 10,
    rateLimit: { maxRuns: 10, windowMs: 60_000 },
    dedupeTtlMs: 86_400_000,
    guardrails: {
      allowedTools: ["glob", "grep", "read_file", "write_file", "edit_file", "run_command"],
      allowedCommands: [["npm", "test"]],
    },
    rules: [
      {
        id: "diagnose-ci",
        match: { type: "ci.failed", labelsAll: ["forgemind:fix"] },
        run: {
          requirement: "Diagnose build {{object.id}} on {{repo}} ({{context.branch}})",
          priority: "high",
        },
        cooldownMs: 30_000,
      },
    ],
  };
}

function event(id: string, objectId: string, repo = "acme/api"): DevelopmentEvent {
  return {
    id,
    source: "ci",
    type: "ci.failed",
    repo,
    object: { kind: "workflow", id: objectId },
    occurredAt: "2026-08-14T10:00:00.000Z",
    labels: ["forgemind:fix"],
    context: { branch: "main" },
  };
}
