import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { runProcess } from "../../src/tools/process.js";

it("generates offline reports through the CLI for successful and failed runs", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "forgemind-report-e2e-"));
  try {
    await git(repo, ["init"]);
    const gitDirectory = path.join(repo, ".git");
    const runsDirectory = path.join(gitDirectory, "forgemind", "runs");
    await createSuccessfulRun(runsDirectory);
    await createFailedRun(runsDirectory);

    for (const runId of ["successful-report", "failed-report"]) {
      const execution = await runProcess(
        process.execPath,
        [path.resolve("dist/src/runtime/cli.js"), "report", "--repo", repo, "--run-id", runId],
        { cwd: process.cwd(), timeoutMs: 30_000, maxBytes: 64_000 },
      );
      assert.equal(execution.exitCode, 0, execution.stderr);
      const reportPath = path.join(gitDirectory, "forgemind", "reports", `${runId}.html`);
      assert.match(execution.stdout, new RegExp(escapeRegExp(reportPath)));
      const html = await readFile(reportPath, "utf8");
      assert.match(html, /^<!doctype html>/);
      assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
      if (runId === "failed-report") {
        assert.match(html, /FAILURE LOCATED/);
        assert.match(html, /TEST · STAGE/);
        assert.match(html, /Test command failed/);
      } else {
        assert.match(html, /SUCCEEDED/);
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function createSuccessfulRun(directory: string): Promise<void> {
  const log = await EventLog.create(directory, "successful-report");
  await log.append({
    type: "run.started",
    data: {
      runId: "successful-report",
      requirement: "Generate a report",
      branch: "forgemind/successful-report",
    },
  });
  await log.append({
    type: "run.finished",
    data: { runId: "successful-report", status: "SUCCEEDED", summary: "Complete" },
  });
}

async function createFailedRun(directory: string): Promise<void> {
  const log = await EventLog.create(directory, "failed-report");
  await log.append({
    type: "run.started",
    data: {
      runId: "failed-report",
      requirement: "Expose a test failure",
      branch: "forgemind/failed-report",
    },
  });
  await log.append({
    type: "stage.started",
    data: { runId: "failed-report", stage: "TEST", attempt: 1 },
  });
  await log.append({
    type: "stage.failed",
    data: {
      runId: "failed-report",
      stage: "TEST",
      kind: "STAGE",
      error: "Test command failed",
    },
  });
  await log.append({
    type: "run.finished",
    data: { runId: "failed-report", status: "FAILED", summary: "Test command failed" },
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxBytes: 32_000 });
  assert.equal(result.exitCode, 0, result.stderr);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
