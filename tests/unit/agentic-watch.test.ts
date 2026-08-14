import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { parseAgenticConfig } from "../../src/agentic/config.js";
import { AgenticTriggerEngine } from "../../src/agentic/trigger.js";
import {
  AgenticWatchService,
  EventLogAgenticAuditSink,
  type AgenticRunDispatcher,
  type DevelopmentEventPoller,
} from "../../src/agentic/watch.js";
import type { AgenticRunRequest, DevelopmentEvent } from "../../src/agentic/types.js";
import { queryAuditEvents } from "../../src/audit/query.js";
import { EventLog } from "../../src/core/event-log.js";

it("uses polling as a cursor-based fallback and audits every decision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-agentic-watch-"));
  try {
    const eventLog = await EventLog.create(directory, "agentic-watcher");
    const event = developmentEvent();
    const cursors: Array<string | undefined> = [];
    const poller: DevelopmentEventPoller = {
      id: "ci-fallback",
      poll(cursor) {
        cursors.push(cursor);
        return Promise.resolve({
          events: [event],
          cursor: cursor === undefined ? "cursor-1" : "cursor-2",
        });
      },
    };
    const dispatched: AgenticRunRequest[] = [];
    const dispatcher: AgenticRunDispatcher = {
      dispatch(request) {
        dispatched.push(request);
        return Promise.resolve({ runId: `run-${dispatched.length}` });
      },
    };
    const watch = new AgenticWatchService({
      trigger: new AgenticTriggerEngine({ config: agenticConfig() }),
      dispatcher,
      pollers: [poller],
      audit: new EventLogAgenticAuditSink(eventLog, "agentic-watcher"),
    });

    const first = await watch.pollOnce();
    const second = await watch.pollOnce();
    assert.equal(first[0]?.decision.kind, "TRIGGER");
    assert.equal(second[0]?.decision.reason, "duplicate-event");
    assert.deepEqual(cursors, [undefined, "cursor-1"]);
    assert.equal(watch.cursorFor("ci-fallback"), "cursor-2");
    assert.equal(dispatched.length, 1);

    const events = await eventLog.load();
    assert.deepEqual(
      events.map((entry) => entry.type),
      ["development.received", "trigger.decided", "development.received", "trigger.decided"],
    );
    const received = events[0];
    assert.ok(received?.type === "development.received");
    assert.equal(received.data.actor, "agentic");
    const firstTimestamp = Date.parse(events[0]?.ts ?? "");
    const lastTimestamp = Date.parse(events.at(-1)?.ts ?? "");
    const audit = await queryAuditEvents(directory, {
      from: new Date(firstTimestamp - 1_000).toISOString(),
      to: new Date(lastTimestamp + 1_000).toISOString(),
      actor: "agentic",
      repo: "acme/api",
    });
    assert.equal(audit.records.length, 4);
    assert.deepEqual([...new Set(audit.records.map((record) => record.outcome))].sort(), [
      "IGNORE",
      "RECEIVED",
      "TRIGGER",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not advance a polling cursor until a failed dispatch is retried", async () => {
  const event = developmentEvent();
  const cursors: Array<string | undefined> = [];
  const poller: DevelopmentEventPoller = {
    id: "retrying-ci",
    poll(cursor) {
      cursors.push(cursor);
      return Promise.resolve({ events: [event], cursor: "after-event" });
    },
  };
  let attempts = 0;
  const watch = new AgenticWatchService({
    trigger: new AgenticTriggerEngine({ config: agenticConfig() }),
    pollers: [poller],
    dispatcher: {
      dispatch() {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("dispatcher unavailable"))
          : Promise.resolve({ runId: "recovered-run" });
      },
    },
  });

  await assert.rejects(() => watch.pollOnce(), /dispatcher unavailable/);
  assert.equal(watch.cursorFor("retrying-ci"), undefined);
  assert.equal(watch.pendingDispatchCount, 1);

  const recovered = await watch.pollOnce();
  assert.equal(recovered[0]?.dispatch?.runId, "recovered-run");
  assert.equal(recovered[1]?.decision.reason, "duplicate-event");
  assert.equal(watch.cursorFor("retrying-ci"), "after-event");
  assert.deepEqual(cursors, [undefined, undefined]);
  assert.equal(watch.pendingDispatchCount, 0);
});

function agenticConfig() {
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

function developmentEvent(): DevelopmentEvent {
  return {
    id: "ci:delivery-1",
    source: "ci",
    type: "ci.failed",
    repo: "acme/api",
    object: { kind: "workflow", id: "build-7" },
    occurredAt: "2026-08-14T10:00:00.000Z",
    labels: [],
    context: {},
  };
}
