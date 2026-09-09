import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { OneShotConflictResolver } from "../../src/negotiation/resolver.js";

it("resolves a conflict with one rubric-based model judgment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-conflict-resolver-"));
  try {
    const eventLog = await EventLog.create(directory, "conflict-run");
    const provider = new FakeChatProvider([
      JSON.stringify({
        selection: "proposal",
        decision: "Use integer cents",
        rationale: "It avoids floating-point rounding",
        risks: ["Display formatting must convert units"],
        requiredVerification: [
          {
            description: "Test negative and large amounts",
            verifier: { kind: "test-suite", commandId: "primary" },
          },
        ],
      }),
    ]);
    const resolver = new OneShotConflictResolver({
      provider,
      model: "test-model",
      eventLog,
    });

    const result = await resolver.negotiate({
      runId: "conflict-run",
      trigger: "artifact-mismatch",
      topic: "Payment amount representation",
      proposal: "Integer cents",
      counter: "Decimal dollars",
    });

    assert.equal(result.status, "RESOLVED");
    assert.match(result.decisionRecord?.decision ?? "", /integer cents/i);
    assert.match(result.decisionRecord?.decision ?? "", /avoids floating-point rounding/i);
    assert.deepEqual(result.decisionRecord?.requiredVerification, [
      {
        description: "Test negative and large amounts",
        verifier: { kind: "test-suite", commandId: "primary" },
      },
    ]);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(
      (await eventLog.load())
        .filter((event) => event.type.startsWith("negotiation."))
        .map((event) => event.type),
      ["negotiation.started", "negotiation.round", "negotiation.resolved"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("stops when a required verification cannot bind to a registered verifier", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-conflict-unbound-"));
  try {
    const eventLog = await EventLog.create(directory, "conflict-unbound");
    const provider = new FakeChatProvider([
      JSON.stringify({
        selection: "proposal",
        decision: "Use integer cents",
        rationale: "It is deterministic",
        risks: [],
        requiredVerification: [
          {
            description: "Run a custom probe",
            verifier: { kind: "behavior", probeId: "invented-probe" },
          },
        ],
      }),
    ]);
    const resolver = new OneShotConflictResolver({
      provider,
      model: "test-model",
      eventLog,
    });

    await assert.rejects(
      () =>
        resolver.negotiate({
          runId: "conflict-unbound",
          trigger: "artifact-mismatch",
          topic: "Payment amount representation",
          proposal: "Integer cents",
          counter: "Decimal dollars",
        }),
      /cannot be bound/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
