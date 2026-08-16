import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { createTaskContext, withArchitecture, withGate } from "../../src/core/context.js";
import { EventLog } from "../../src/core/event-log.js";
import type { ArtifactRef } from "../../src/core/types.js";
import { EpisodicMemory } from "../../src/memory/episodic-memory.js";
import { LayeredMemory } from "../../src/memory/layered-memory.js";
import type { MemoryProvider, Retrieval } from "../../src/memory/memory-provider.js";
import { ProjectMemory } from "../../src/memory/project-memory.js";
import { createDecisionRecord } from "../../src/negotiation/record.js";

describe("layered memory", () => {
  it("stores deterministic project decisions and rejected-gate lessons only when enabled", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-project-memory-"));
    try {
      const events = await EventLog.create(repository, "memory-events");
      const enabled = new ProjectMemory({
        repositoryRoot: repository,
        writeEnabled: true,
        eventLog: events,
      });
      const architectureArtifact: ArtifactRef = {
        path: "architecture.md",
        kind: "architecture",
        stage: "ARCH",
        summary: "Use existing modules",
      };
      const base = createTaskContext({
        runId: "memory-run",
        requirement: "Add health endpoint",
        repoPath: repository,
        branch: "forgemind/memory-run",
        tokenBudget: DEFAULT_TOKEN_BUDGETS,
      });
      const context = withArchitecture(
        base,
        {
          decisions: ["Reuse the HTTP router"],
          files: [{ path: "src/router.ts", purpose: "Register health route" }],
          risks: ["Route collision"],
          summary: "Extend router",
        },
        architectureArtifact,
      );
      await enabled.remember(context, architectureArtifact);
      await enabled.remember(context, architectureArtifact);
      const rejected = {
        stage: "REVIEW" as const,
        attempt: 1,
        passed: false,
        reason: "Missing coverage",
        feedback: "Add a router test",
        evidence: "diff",
      };
      await enabled.rememberGate(withGate(context, rejected), rejected);

      const decisions = JSON.parse(
        await readFile(path.join(repository, ".forgemind/memory/decisions.json"), "utf8"),
      ) as { entries: unknown[] };
      assert.equal(decisions.entries.length, 2);
      assert.equal((await enabled.recall("router", { scopes: ["project"] })).length, 2);
      assert.match(
        (await enabled.recall("coverage", { scopes: ["project"] }))[0]?.content ?? "",
        /Add a router test/,
      );
      assert.equal(
        (await events.load()).filter((event) => event.type === "memory.stored").length,
        3,
      );

      const disabledRepository = await mkdtemp(
        path.join(os.tmpdir(), "forgemind-project-memory-disabled-"),
      );
      try {
        await new ProjectMemory({
          repositoryRoot: disabledRepository,
          writeEnabled: false,
        }).remember(context, architectureArtifact);
        await assert.rejects(
          () => readFile(path.join(disabledRepository, ".forgemind/memory/decisions.json")),
          /ENOENT/,
        );
      } finally {
        await rm(disabledRepository, { recursive: true, force: true });
      }
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("retrieves historical outcomes by requirement keywords and status", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-episodic-memory-"));
    try {
      const log = await EventLog.create(directory, "historical-run");
      await log.append({
        type: "run.started",
        data: {
          runId: "historical-run",
          requirement: "Add health endpoint",
          branch: "forgemind/historical-run",
        },
      });
      await log.append({
        type: "gate.rejected",
        data: {
          runId: "historical-run",
          stage: "REVIEW",
          reason: "Missing test",
          feedback: "Cover the health endpoint",
        },
      });
      await log.append({
        type: "run.finished",
        data: { runId: "historical-run", status: "FAILED", summary: "Review failed" },
      });
      const memory = new EpisodicMemory({ eventsDirectory: directory });
      const results = await memory.recall("health endpoint", {
        scopes: ["episodic"],
        statuses: ["FAILED"],
      });
      assert.equal(results.length, 1);
      const result = results[0];
      assert.ok(result);
      assert.equal(result.scope, "episodic");
      assert.match(result.content, /Missing test/);
      assert.equal((await memory.recall("health endpoint", { statuses: ["SUCCEEDED"] })).length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("filters layers by scope and skips absent semantic memory", async () => {
    const episodic = new StaticMemory({
      content: "episode",
      source: "run.jsonl",
      score: 1,
      scope: "episodic",
      reason: "match",
    });
    const project = new StaticMemory({
      content: "decision",
      source: "decisions.json",
      score: 2,
      scope: "project",
      reason: "tag",
    });
    const memory = new LayeredMemory({ layers: { episodic, project, semantic: null } });
    assert.deepEqual(
      (await memory.recall("x", { scopes: ["project", "semantic"] })).map((item) => item.scope),
      ["project"],
    );
  });

  it("stores and recalls deterministic negotiation decision records", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-negotiation-memory-"));
    try {
      const memory = new ProjectMemory({ repositoryRoot: repository, writeEnabled: true });
      const record = createDecisionRecord({
        runId: "negotiation-memory-run",
        topic: "Choose a bounded protocol",
        trigger: "arch-conflict",
        rounds: [
          {
            round: 1,
            proposal: "Use an orchestrator-owned bounded protocol",
            counter: "Put negotiation loops inside stage agents",
            status: "CONVERGED",
          },
        ],
        decision: "Use an orchestrator-owned bounded protocol",
        escalated: false,
        createdAt: "2026-08-14T00:00:00.000Z",
      });
      await memory.rememberDecisionRecord(record);
      await memory.rememberDecisionRecord(record);
      const recalled = await memory.recall("bounded protocol", { scopes: ["project"] });
      assert.equal(recalled.length, 1);
      assert.match(recalled[0]?.content ?? "", /orchestrator-owned bounded protocol/);
      const document = JSON.parse(
        await readFile(path.join(repository, ".forgemind/memory/decisions.json"), "utf8"),
      ) as { entries: unknown[] };
      assert.equal(document.entries.length, 1);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("fails fast instead of overwriting a malformed project memory document", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-invalid-memory-"));
    try {
      const directory = path.join(repository, ".forgemind", "memory");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "decisions.json"), "{not-json}\n", "utf8");
      const memory = new ProjectMemory({ repositoryRoot: repository, writeEnabled: true });
      await assert.rejects(
        () => memory.recall("anything"),
        /Unable to read project memory document: decisions.json/,
      );
      assert.equal(await readFile(path.join(directory, "decisions.json"), "utf8"), "{not-json}\n");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

class StaticMemory implements MemoryProvider {
  public constructor(private readonly retrieval: Retrieval) {}
  public remember(): Promise<void> {
    return Promise.resolve();
  }
  public recall(): Promise<readonly Retrieval[]> {
    return Promise.resolve([this.retrieval]);
  }
}
