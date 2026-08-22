import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseAgenticConfig } from "../../src/agentic/config.js";
import { FileAgenticStateStore } from "../../src/agentic/state.js";
import { AgenticTriggerEngine } from "../../src/agentic/trigger.js";
import type { AgenticRunRequest, DevelopmentEvent } from "../../src/agentic/types.js";
import {
  AgenticWatchService,
  type AgenticRunDispatcher,
  type DevelopmentEventPoller,
} from "../../src/agentic/watch.js";
import { FatalFailure } from "../../src/core/errors.js";

describe("persistent agentic state", () => {
  it("restores polling cursors, dedupe, rate windows, and daily quota after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-agentic-state-"));
    try {
      const filePath = path.join(directory, "checkpoint.json");
      const store = new FileAgenticStateStore({ filePath });
      const now = Date.parse("2026-08-18T08:00:00.000Z");
      const dispatched: AgenticRunRequest[] = [];
      const dispatcher = captureDispatcher(dispatched);
      const firstEvent = event("delivery-1", "build-1");
      const firstPoller: DevelopmentEventPoller = {
        id: "ci",
        poll(cursor) {
          assert.equal(cursor, undefined);
          return Promise.resolve({ events: [firstEvent], cursor: "cursor-1" });
        },
      };
      const firstWatch = watch(store, dispatcher, firstPoller, now);
      assert.equal((await firstWatch.pollOnce())[0]?.decision.kind, "TRIGGER");
      assert.equal(dispatched.length, 1);

      const restoredCursors: Array<string | undefined> = [];
      const secondPoller: DevelopmentEventPoller = {
        id: "ci",
        poll(cursor) {
          restoredCursors.push(cursor);
          return Promise.resolve({
            events: [firstEvent, event("delivery-2", "build-2")],
            cursor: "cursor-2",
          });
        },
      };
      const secondWatch = watch(store, dispatcher, secondPoller, now);
      const restored = await secondWatch.pollOnce();

      assert.deepEqual(restoredCursors, ["cursor-1"]);
      assert.equal(restored[0]?.decision.reason, "duplicate-event");
      assert.equal(restored[1]?.decision.reason, "global-rate-limit");
      assert.equal(secondWatch.cursorFor("ci"), "cursor-2");
      assert.equal(dispatched.length, 1);

      const afterWindow = watch(store, dispatcher, undefined, now + 60_000);
      const drained = await afterWindow.pollOnce();
      assert.equal(drained[0]?.decision.kind, "TRIGGER");
      assert.equal(dispatched.length, 2);
      const quota = await afterWindow.accept(event("delivery-3", "build-3"));
      assert.equal(quota.decision.reason, "daily-task-quota");

      const checkpoint = await store.load();
      assert.ok(checkpoint);
      assert.equal(checkpoint.cursors["ci"], "cursor-2");
      assert.equal(checkpoint.trigger.dailyCounts["2026-08-18"], 2);
      assert.equal(checkpoint.trigger.recentRuns.length, 1);
      assert.ok(checkpoint.trigger.seenEvents["delivery-1"]);
      assert.ok(checkpoint.trigger.seenEvents["delivery-2"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed or oversized checkpoints", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-agentic-corrupt-"));
    try {
      const filePath = path.join(directory, "checkpoint.json");
      await writeFile(filePath, '{"version":1,"cursors":{}}', "utf8");
      await assert.rejects(() => new FileAgenticStateStore({ filePath }).load(), FatalFailure);
      await writeFile(filePath, "x".repeat(100), "utf8");
      await assert.rejects(
        () => new FileAgenticStateStore({ filePath, maxBytes: 32 }).load(),
        /exceeds 32 bytes/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to replay a persisted dispatch after rule configuration drift", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-agentic-drift-"));
    try {
      const store = new FileAgenticStateStore({
        filePath: path.join(directory, "checkpoint.json"),
      });
      const first = new AgenticWatchService({
        trigger: new AgenticTriggerEngine({ config: config() }),
        dispatcher: {
          dispatch() {
            return Promise.reject(new Error("offline"));
          },
        },
        stateStore: store,
      });
      await assert.rejects(() => first.accept(event("drift-event", "build-drift")), /offline/);

      const changed = new AgenticWatchService({
        trigger: new AgenticTriggerEngine({ config: config("Changed {{object.id}}") }),
        dispatcher: captureDispatcher([]),
        stateStore: store,
      });
      await assert.rejects(() => changed.restore(), /does not match rule diagnose/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function watch(
  stateStore: FileAgenticStateStore,
  dispatcher: AgenticRunDispatcher,
  poller: DevelopmentEventPoller | undefined,
  now: number,
): AgenticWatchService {
  return new AgenticWatchService({
    trigger: new AgenticTriggerEngine({ config: config(), clock: () => now }),
    dispatcher,
    pollers: poller === undefined ? [] : [poller],
    stateStore,
  });
}

function captureDispatcher(dispatched: AgenticRunRequest[]): AgenticRunDispatcher {
  return {
    dispatch(request) {
      dispatched.push(request);
      return Promise.resolve({ runId: `run-${dispatched.length}` });
    },
  };
}

function config(requirement = "Diagnose {{object.id}}") {
  return parseAgenticConfig({
    repositories: ["acme/api"],
    dailyTaskQuota: 2,
    rateLimit: { maxRuns: 1, windowMs: 60_000 },
    dedupeTtlMs: 86_400_000,
    guardrails: { allowedTools: ["read_file"], allowedCommands: [] },
    rules: [
      {
        id: "diagnose",
        match: { type: "ci.failed" },
        run: { requirement },
        cooldownMs: 60_000,
      },
    ],
  });
}

function event(id: string, objectId: string): DevelopmentEvent {
  return {
    id,
    source: "ci",
    type: "ci.failed",
    repo: "acme/api",
    object: { kind: "workflow", id: objectId },
    occurredAt: "2026-08-18T08:00:00.000Z",
    labels: [],
    context: {},
  };
}
