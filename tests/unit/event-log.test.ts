import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { assertValidTaskId, EventLog } from "../../src/core/event-log.js";

it("serializes concurrent event appends with contiguous sequence numbers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-event-log-"));
  try {
    const log = await EventLog.create(directory, "concurrent-run");
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        log.append({
          type: "run.finished",
          data: {
            runId: "concurrent-run",
            status: "SUCCEEDED",
            summary: `event-${index + 1}`,
          },
        }),
      ),
    );

    const events = await log.load();
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      events.map((event) => (event.type === "run.finished" ? event.data.summary : "")),
      Array.from({ length: 25 }, (_, index) => `event-${index + 1}`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("adds parent and task indexes to child run events without changing callers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-indexed-log-"));
  try {
    const log = await EventLog.create(directory, "child-run", {
      parentRunId: "parent-run",
      taskId: "backend",
    });
    await log.append({
      type: "run.started",
      data: {
        runId: "child-run",
        requirement: "Add API",
        branch: "forgemind/child-run",
      },
    });
    await log.append({
      type: "stage.started",
      data: { runId: "child-run", stage: "PLAN", attempt: 1 },
    });

    const events = await log.load();
    const started = events[0];
    const stage = events[1];
    assert.ok(started?.type === "run.started");
    assert.equal(started.data.parentRunId, "parent-run");
    assert.equal(started.data.taskId, "backend");
    assert.equal(stage?.data.taskId, "backend");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects invalid task ids before creating an indexed event log", () => {
  assert.throws(() => assertValidTaskId("invalid/task"), /Invalid task id/);
});
