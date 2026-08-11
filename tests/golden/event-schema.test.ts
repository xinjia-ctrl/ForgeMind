import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { replay } from "../../src/core/replay.js";

it("keeps the versioned event and replay contract stable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-golden-"));
  try {
    const log = await EventLog.create(directory, "golden-run");
    await log.append({
      type: "run.started",
      data: {
        runId: "golden-run",
        requirement: "Add deterministic replay",
        branch: "forgemind/golden-run",
      },
    });
    await log.append({
      type: "stage.started",
      data: { runId: "golden-run", stage: "PLAN", attempt: 1 },
    });
    await log.append({
      type: "stage.failed",
      data: {
        runId: "golden-run",
        stage: "PLAN",
        kind: "STAGE",
        error: "Planning failed",
      },
    });
    await log.append({
      type: "run.finished",
      data: { runId: "golden-run", status: "FAILED", summary: "Planning failed" },
    });
    const snapshot = JSON.parse(
      await readFile("tests/golden/event-schema.snapshot.json", "utf8"),
    ) as unknown;
    assert.deepEqual(replay(await log.load()), snapshot);
    const rawEvents = await log.load();
    assert.deepEqual(
      rawEvents.map((event) => event.seq),
      [1, 2, 3, 4],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
