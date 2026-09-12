import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";

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
