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
      type: "context.assembled",
      data: {
        runId: "golden-run",
        stage: "PLAN",
        sections: [{ name: "Requirement", source: "contract", tokenEstimate: 6, references: [] }],
        tokenEstimate: 6,
      },
    });
    await log.append({
      type: "llm.called",
      data: {
        runId: "golden-run",
        stage: "PLAN",
        model: "test-model",
        inputTokens: 12,
        outputTokens: 4,
        promptFingerprint: "sha256",
        promptVersion: "plan.v4",
        structuredOutput: true,
      },
    });
    await log.append({
      type: "stage.failed",
      data: { runId: "golden-run", stage: "PLAN", kind: "STAGE", error: "Planning failed" },
    });
    await log.append({
      type: "run.finished",
      data: { runId: "golden-run", status: "FAILED", summary: "Planning failed" },
    });
    await log.append({
      type: "run.quality",
      data: {
        runId: "golden-run",
        requirement: "Add deterministic replay",
        outcome: "failed",
        evidenceCompleteness: 0,
        verificationStrength: "weak",
        coveragePercent: null,
        reworkRounds: 0,
        policyViolations: 0,
        confidence: 0,
      },
    });

    const snapshot = JSON.parse(
      await readFile("tests/golden/event-schema.snapshot.json", "utf8"),
    ) as unknown;
    assert.deepEqual(replay(await log.load()), snapshot);
    assert.deepEqual(
      (await log.load()).map((event) => event.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
