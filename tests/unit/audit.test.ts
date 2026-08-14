import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { exportAuditResult, renderCsv } from "../../src/audit/export.js";
import { queryAuditEvents, type AuditRecord } from "../../src/audit/query.js";
import { EventLog } from "../../src/core/event-log.js";

describe("audit projection", () => {
  it("filters the event fact source by actor, repository, time, and result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-audit-"));
    try {
      await createRun(directory, {
        runId: "alice-run",
        actor: "alice",
        role: "approver",
        repo: "/repos/api",
        status: "SUCCEEDED",
      });
      await createRun(directory, {
        runId: "bob-run",
        actor: "bob",
        role: "developer",
        repo: "/repos/web",
        status: "FAILED",
      });

      const result = await queryAuditEvents(directory, {
        from: "2000-01-01T00:00:00.000Z",
        to: "2000-01-31T00:00:00.000Z",
        actor: "alice",
        repo: "/repos/api",
        status: "SUCCEEDED",
      });

      assert.equal(result.scannedFiles, 2);
      assert.equal(result.scannedEvents, 8);
      assert.equal(result.records.length, 4);
      assert.ok(result.records.every((record) => record.runId === "alice-run"));
      const approval = result.records.find((record) => record.type === "approval.approved");
      assert.deepEqual(approval, {
        runId: "alice-run",
        seq: 2,
        ts: "2000-01-02T00:00:01.000Z",
        type: "approval.approved",
        stage: "COMMIT",
        actor: "alice",
        role: "approver",
        risk: "high",
        repo: "/repos/api",
        status: "SUCCEEDED",
        operation: "git_commit",
        outcome: "APPROVED",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a valid bounded time window", async () => {
    await assert.rejects(
      () =>
        queryAuditEvents("/missing", {
          from: "2025-01-01T00:00:00.000Z",
          to: "2025-03-01T00:00:00.000Z",
        }),
      /cannot exceed 31 days/,
    );
    await assert.rejects(
      () => queryAuditEvents("/missing", { from: "invalid", to: "also-invalid" }),
      /valid ISO timestamps/,
    );
  });

  it("exports the same projection as JSON and injection-safe CSV", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-audit-export-"));
    const record: AuditRecord = {
      runId: '=HYPERLINK("https://invalid")',
      seq: 1,
      ts: "2000-01-02T00:00:00.000Z",
      type: "tool.called",
      stage: "CODE",
      operation: "write_file",
      outcome: "SUCCEEDED",
    };
    const result = {
      query: { from: "2000-01-01T00:00:00.000Z", to: "2000-01-31T00:00:00.000Z" },
      records: [record],
      scannedFiles: 1,
      scannedEvents: 1,
    } as const;
    try {
      const jsonPath = await exportAuditResult(result, {
        directory,
        name: "audit-json",
        format: "json",
      });
      const csvPath = await exportAuditResult(result, {
        directory,
        name: "audit-csv",
        format: "csv",
      });
      assert.deepEqual(JSON.parse(await readFile(jsonPath, "utf8")), result);
      const csv = await readFile(csvPath, "utf8");
      assert.equal(csv, renderCsv(result.records));
      assert.match(csv, /^runId,seq,/);
      assert.match(csv, /'=/);
      await assert.rejects(
        () => exportAuditResult(result, { directory, name: "audit-json", format: "json" }),
        /EEXIST/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function createRun(
  directory: string,
  options: {
    readonly runId: string;
    readonly actor: string;
    readonly role: "developer" | "approver";
    readonly repo: string;
    readonly status: "SUCCEEDED" | "FAILED";
  },
): Promise<void> {
  const log = await EventLog.create(directory, options.runId);
  const base = options.actor === "alice" ? 2 : 3;
  await log.append({
    type: "run.started",
    data: {
      runId: options.runId,
      requirement: "Audit fixture",
      branch: `forgemind/${options.runId}`,
      repo: options.repo,
      actor: options.actor,
    },
  });
  await log.append({
    type: "approval.approved",
    data: {
      runId: options.runId,
      stage: "COMMIT",
      tool: "git_commit",
      action: {},
      policy: "rule:high",
      mode: "approve",
      decisionSource: "auto",
      actor: options.actor,
      role: options.role,
      risk: "high",
    },
  });
  await log.append({
    type: "llm.called",
    data: {
      runId: options.runId,
      stage: "PLAN",
      model: "fake",
      inputTokens: base,
      outputTokens: base,
      promptFingerprint: "hash",
    },
  });
  await log.append({
    type: "run.finished",
    data: { runId: options.runId, status: options.status, summary: options.status },
  });
  const events = await log.load();
  const day = options.actor === "alice" ? "02" : "03";
  const rewritten = events
    .map((event, index) => ({
      ...event,
      ts: `2000-01-${day}T00:00:0${index}.000Z`,
    }))
    .map((event) => JSON.stringify(event))
    .join("\n");
  await writeFile(log.filePath, `${rewritten}\n`, "utf8");
}
