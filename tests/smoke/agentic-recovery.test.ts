import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { parseAgenticConfig } from "../../src/agentic/config.js";
import { FileAgenticStateStore } from "../../src/agentic/state.js";
import { AgenticTriggerEngine } from "../../src/agentic/trigger.js";
import type { DevelopmentEvent } from "../../src/agentic/types.js";
import { AgenticWatchService } from "../../src/agentic/watch.js";

it("recovers a persisted dispatch after process reconstruction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-recovery-smoke-"));
  try {
    const store = new FileAgenticStateStore({
      filePath: path.join(directory, "agentic-checkpoint.json"),
    });
    const requestIds: string[] = [];
    const failed = service(store, {
      dispatch(request) {
        requestIds.push(request.id);
        return Promise.reject(new Error("simulated dispatcher outage"));
      },
    });

    await assert.rejects(() => failed.accept(event()), /simulated dispatcher outage/);
    assert.equal((await store.load())?.dispatchRetries.length, 1);

    const recovered = service(store, {
      dispatch(request) {
        requestIds.push(request.id);
        return Promise.resolve({ runId: "recovered-run" });
      },
    });
    const outcomes = await recovered.pollOnce();
    const outcome = outcomes[0];
    assert.ok(outcome);
    assert.equal(outcome.dispatch?.runId, "recovered-run");
    assert.equal(outcome.decision.kind, "TRIGGER");
    assert.equal(requestIds[0], requestIds[1]);
    assert.equal((await store.load())?.dispatchRetries.length, 0);

    const verified = service(store, {
      dispatch() {
        return Promise.reject(new Error("completed dispatch must not run again"));
      },
    });
    assert.deepEqual(await verified.pollOnce(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function service(
  stateStore: FileAgenticStateStore,
  dispatcher: ConstructorParameters<typeof AgenticWatchService>[0]["dispatcher"],
): AgenticWatchService {
  return new AgenticWatchService({
    trigger: new AgenticTriggerEngine({ config: config() }),
    dispatcher,
    stateStore,
  });
}

function config() {
  return parseAgenticConfig({
    repositories: ["acme/api"],
    guardrails: { allowedTools: ["read_file"], allowedCommands: [] },
    rules: [
      {
        id: "diagnose",
        match: { type: "ci.failed" },
        run: { requirement: "Diagnose {{object.id}}" },
        cooldownMs: 60_000,
      },
    ],
  });
}

function event(): DevelopmentEvent {
  return {
    id: "ci:recovery-smoke",
    source: "ci",
    type: "ci.failed",
    repo: "acme/api",
    object: { kind: "workflow", id: "build-recovery" },
    occurredAt: new Date().toISOString(),
    labels: [],
    context: {},
  };
}
