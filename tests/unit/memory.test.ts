import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { createTaskContext, withArchitecture, withGate, withPlan } from "../../src/core/context.js";
import { EventLog } from "../../src/core/event-log.js";
import type { ArtifactRef } from "../../src/core/types.js";
import { EpisodicMemory } from "../../src/memory/episodic-memory.js";
import { LayeredMemory } from "../../src/memory/layered-memory.js";
import type { MemoryProvider, Retrieval } from "../../src/memory/memory-provider.js";
import { ProjectMemory } from "../../src/memory/project-memory.js";
import { readProjectMemoryDocument } from "../../src/memory/project-memory-document.js";
import { createDecisionRecord } from "../../src/negotiation/record.js";

describe("layered memory", () => {
  it("promotes project decisions only after independent gates and keeps a rejection episodic", async () => {
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
      const planned = withPlan(
        base,
        {
          objective: "Add health endpoint",
          steps: [{ id: "STEP-1", title: "Add route", description: "Register the route" }],
          acceptanceCriteria: [
            {
              id: "AC-1",
              description: "The health route exists",
              requiredEvidence: ["test"],
              verifier: {
                kind: "file",
                path: "src/router.ts",
                assertion: "contains",
                value: "health",
              },
            },
            {
              id: "AC-2",
              description: "The route preserves module boundaries",
              requiredEvidence: ["review"],
              verifier: {
                kind: "review",
                rubric: "Confirm the existing router boundary is preserved",
              },
            },
          ],
          summary: "Add the health route safely",
        },
        { path: "plan.md", kind: "plan", stage: "PLAN", summary: "plan" },
      );
      const context = withArchitecture(
        planned,
        {
          decisions: ["Reuse the HTTP router"],
          files: [{ path: "src/router.ts", purpose: "Register health route" }],
          risks: ["Route collision"],
          summary: "Extend router",
        },
        architectureArtifact,
      );
      // Unverified architecture output is not durable project memory.
      await enabled.remember(context, architectureArtifact);
      await assert.rejects(
        () => readFile(path.join(repository, ".forgemind/memory/decisions.json")),
        /ENOENT/,
      );
      const rejected = {
        stage: "REVIEW" as const,
        attempt: 1,
        passed: false,
        reason: "Missing coverage",
        feedback: "Add a router test",
        evidence: "diff",
        artifactFingerprint: "fingerprint",
        verificationEvidence: [],
      };
      await enabled.rememberGate(withGate(context, rejected), rejected);

      const fingerprint = "verified-fingerprint";
      const tested = withGate(context, {
        stage: "TEST",
        attempt: 1,
        passed: true,
        reason: "Verified",
        feedback: "none",
        evidence: "file verifier",
        artifactFingerprint: fingerprint,
        verificationEvidence: [
          {
            criterionId: "AC-1",
            verifierKind: "file",
            source: "test:file:contains",
            artifactFingerprint: fingerprint,
            passed: true,
            details: "health route exists",
          },
        ],
      });
      const verified = withGate(tested, {
        stage: "REVIEW",
        attempt: 1,
        passed: true,
        reason: "Verified",
        feedback: "none",
        evidence: "review rubric",
        artifactFingerprint: fingerprint,
        verificationEvidence: [
          {
            criterionId: "AC-2",
            verifierKind: "review",
            source: "review:model",
            artifactFingerprint: fingerprint,
            passed: true,
            details: "module boundary preserved",
          },
        ],
      });
      const commitArtifact: ArtifactRef = {
        path: "abc123",
        kind: "commit",
        stage: "COMMIT",
        summary: "verified commit",
      };
      await enabled.remember(verified, commitArtifact);
      await enabled.remember(verified, commitArtifact);

      const decisions = JSON.parse(
        await readFile(path.join(repository, ".forgemind/memory/decisions.json"), "utf8"),
      ) as { entries: unknown[] };
      assert.equal(decisions.entries.length, 2);
      assert.equal((await enabled.recall("", { scopes: ["project"] })).length, 2);
      assert.equal((await enabled.recall("coverage", { scopes: ["project"] })).length, 0);
      assert.equal(
        (await events.load()).filter((event) => event.type === "memory.stored").length,
        2,
      );

      const disabledRepository = await mkdtemp(
        path.join(os.tmpdir(), "forgemind-project-memory-disabled-"),
      );
      try {
        await new ProjectMemory({
          repositoryRoot: disabledRepository,
          writeEnabled: false,
        }).remember(verified, commitArtifact);
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
          artifactFingerprint: "fingerprint",
          verificationEvidence: [],
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

  it("migrates legacy entries and supports superseding, expiry, and tombstones", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-governed-memory-"));
    try {
      const directory = path.join(repository, ".forgemind", "memory");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "decisions.json"),
        `${JSON.stringify({
          version: 1,
          entries: [
            {
              id: "legacy-decision",
              kind: "decision",
              content: "Use the legacy router",
              tags: ["router"],
              sourceRunId: "legacy-run",
              stage: "ARCH",
            },
          ],
        })}\n`,
        "utf8",
      );
      const migrated = await readProjectMemoryDocument(directory, "decisions.json");
      const legacy = migrated.entries[0];
      assert.ok(legacy);
      assert.equal(migrated.version, 2);
      assert.equal(legacy.confidence, 0.5);
      assert.deepEqual(legacy.permissions, {
        read: "project",
        write: "maintainer",
      });
      await assert.rejects(
        () =>
          new ProjectMemory({ repositoryRoot: repository, writeEnabled: true }).tombstone(
            "decisions.json",
            "legacy-decision",
            "unauthorized-run",
          ),
        /Maintainer permission/,
      );

      let now = new Date("2026-09-01T00:00:00.000Z");
      const memory = new ProjectMemory({
        repositoryRoot: repository,
        writeEnabled: true,
        clock: () => now,
        governanceRole: "maintainer",
      });
      const replacement = await memory.supersede(
        "decisions.json",
        "legacy-decision",
        {
          kind: "decision",
          content: "Use the maintained router",
          stage: "ARCH",
          confidence: 0.95,
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
        "correction-run",
      );
      assert.equal((await memory.recall("legacy")).length, 0);
      assert.equal((await memory.recall("maintained")).length, 1);
      now = new Date("2026-09-04T00:00:00.000Z");
      assert.equal((await memory.recall("maintained")).length, 0);
      await memory.tombstone("decisions.json", replacement.id, "deletion-run");
      const governed = JSON.parse(
        await readFile(path.join(directory, "decisions.json"), "utf8"),
      ) as {
        version: number;
        entries: Array<{ id: string; status: string; supersedes: string | null }>;
      };
      assert.equal(governed.version, 2);
      assert.equal(
        governed.entries.find((entry) => entry.id === "legacy-decision")?.status,
        "superseded",
      );
      assert.equal(
        governed.entries.find((entry) => entry.id === replacement.id)?.status,
        "tombstone",
      );
      assert.equal(replacement.supersedes, "legacy-decision");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("filters layers by scope and skips absent semantic memory", async () => {
    const episodic = new StaticMemory({
      entryId: "episode",
      content: "episode",
      source: "run.jsonl",
      timestamp: "2000-01-01T00:00:00.000Z",
      confidence: 0.7,
      score: 1,
      scope: "episodic",
      reason: "match",
    });
    const project = new StaticMemory({
      entryId: "decision",
      content: "decision",
      source: "decisions.json",
      timestamp: "2000-01-01T00:00:00.000Z",
      confidence: 0.8,
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

  it("stores quality assessments as deterministic project lessons", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-quality-memory-"));
    try {
      const memory = new ProjectMemory({ repositoryRoot: repository, writeEnabled: true });
      const quality = {
        runId: "quality-memory-run",
        requirement: "Add payment boundary validation",
        outcome: "succeeded" as const,
        evidenceCompleteness: 100,
        verificationStrength: "strong" as const,
        coveragePercent: 84.5,
        reworkRounds: 1,
        policyViolations: 0,
        confidence: 0.9,
      };
      await memory.rememberQuality(quality);
      await memory.rememberQuality(quality);

      const recalled = await memory.recall("quality rework", { scopes: ["project"] });
      assert.equal(recalled.length, 1);
      assert.match(recalled[0]?.content ?? "", /verification strength strong/);
      assert.match(recalled[0]?.content ?? "", /rework rounds 1/);
      const document = JSON.parse(
        await readFile(path.join(repository, ".forgemind/memory/lessons.json"), "utf8"),
      ) as { entries: unknown[] };
      assert.equal(document.entries.length, 1);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("deduplicates semantic-index copies by entry id or content hash before recall@k", async () => {
    const shared = {
      entryId: "shared-entry",
      content: "Use integer cents for payment amounts",
      timestamp: "2026-08-18T00:00:00.000Z",
      confidence: 0.9,
      reason: "payment match",
    };
    const memory = new LayeredMemory({
      layers: {
        project: new StaticMemory({
          ...shared,
          source: "decisions.json",
          score: 3,
          scope: "project",
        }),
        semantic: new StaticMemory({
          ...shared,
          source: "semantic-index",
          score: 2.9,
          scope: "semantic",
        }),
        episodic: new StaticMemory({
          entryId: "episode-entry",
          content: "Prior payment rollout passed",
          source: "run.jsonl",
          timestamp: "2026-08-17T00:00:00.000Z",
          confidence: 0.7,
          score: 2,
          scope: "episodic",
          reason: "payment match",
        }),
      },
    });

    const recalled = await memory.recall("payment", { limit: 2 });

    assert.deepEqual(
      recalled.map((item) => item.entryId),
      ["shared-entry", "episode-entry"],
    );
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
