import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_TOKEN_BUDGETS } from "../../src/config/budgets.js";
import { createTaskContext, withArchitecture } from "../../src/core/context.js";
import type { ArtifactRef } from "../../src/core/types.js";
import { ProjectMemory } from "../../src/memory/project-memory.js";
import {
  type EmbeddingProvider,
  LexicalEmbeddingProvider,
  SemanticMemory,
} from "../../src/memory/semantic-memory.js";
import { createDecisionRecord } from "../../src/negotiation/record.js";

describe("semantic memory", () => {
  it("ranks normalized symbols and plurals with the zero-dependency lexical provider", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-semantic-lexical-"));
    try {
      await storeArchitectureDecisions(repository, [
        "Route HTTPRouter services through the gateway",
        "Retire the legacy service database",
      ]);
      const memory = new SemanticMemory({ repositoryRoots: [repository] });

      const results = await memory.recall("HTTP-router services", { scopes: ["semantic"] });

      assert.equal(results.length, 2);
      const first = results[0];
      const second = results[1];
      assert.ok(first);
      assert.ok(second);
      assert.match(first.content, /HTTPRouter services/);
      assert.ok(first.score > second.score);
      assert.equal(first.scope, "semantic");
      assert.match(first.reason, /BM25=/);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("uses an injected vector provider for queries without lexical overlap", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-semantic-vector-"));
    try {
      await storeArchitectureDecisions(repository, [
        "Use opaque authentication tokens for browser sessions",
        "Store invoice rows in the relational database",
      ]);
      const embeddings = new FakeSemanticEmbeddingProvider();
      const memory = new SemanticMemory({
        repositoryRoots: [repository],
        embeddingProvider: embeddings,
      });

      const results = await memory.recall("login credential outage", { scopes: ["semantic"] });

      assert.equal(results.length, 1);
      assert.match(results[0]?.content ?? "", /authentication tokens/);
      assert.match(results[0]?.reason ?? "", /terms=vector-only/);
      assert.ok(embeddings.calls >= 3);

      const laterQuery = await memory.recall("billing storage failure", {
        scopes: ["semantic"],
      });
      assert.equal(laterQuery.length, 1);
      assert.match(laterQuery[0]?.content ?? "", /relational database/);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("recalls a persisted DecisionRecord from a later memory instance", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-semantic-decision-"));
    try {
      const firstRun = new ProjectMemory({ repositoryRoot: repository, writeEnabled: true });
      await firstRun.rememberDecisionRecord(
        createDecisionRecord({
          runId: "semantic-decision-first-run",
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
          createdAt: "2026-08-18T00:00:00.000Z",
        }),
      );

      const laterRun = new SemanticMemory({ repositoryRoots: [repository] });
      const results = await laterRun.recall("ORCHESTRATOR protocols", {
        scopes: ["semantic"],
      });

      assert.equal(results.length, 1);
      assert.match(results[0]?.content ?? "", /orchestrator-owned bounded protocol/);
      assert.match(results[0]?.source ?? "", /decisions\.json#/);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("searches only the explicitly configured cross-project roots", async () => {
    const repositories = await Promise.all([
      mkdtemp(path.join(os.tmpdir(), "forgemind-semantic-project-a-")),
      mkdtemp(path.join(os.tmpdir(), "forgemind-semantic-project-b-")),
    ]);
    try {
      const firstRepository = repositories[0];
      const secondRepository = repositories[1];
      assert.ok(firstRepository);
      assert.ok(secondRepository);
      await storeArchitectureDecisions(firstRepository, ["Keep the existing HTTP transport"]);
      await storeArchitectureDecisions(secondRepository, ["Publish events through Kafka topics"]);

      const memory = new SemanticMemory({ repositoryRoots: repositories });
      const results = await memory.recall("Kafka topic", { scopes: ["semantic"] });

      assert.equal(results.length, 1);
      assert.match(results[0]?.content ?? "", /Kafka topics/);
      assert.match(results[0]?.source ?? "", /forgemind-semantic-project-b-/);
    } finally {
      await Promise.all(
        repositories.map(
          async (repository) => await rm(repository, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("fails closed when an embedding provider violates its dimension contract", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-semantic-invalid-"));
    try {
      await storeArchitectureDecisions(repository, ["Keep the existing router"]);
      const memory = new SemanticMemory({
        repositoryRoots: [repository],
        embeddingProvider: {
          dimension: 2,
          embed: () => Promise.resolve([1]),
        },
      });

      await assert.rejects(
        () => memory.recall("router", { scopes: ["semantic"] }),
        /expected 2 finite values/,
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("keeps lexical embeddings deterministic", async () => {
    const provider = new LexicalEmbeddingProvider({ dimension: 64 });
    assert.deepEqual(
      await provider.embed("HTTPRouter services"),
      await provider.embed("HTTPRouter services"),
    );
    assert.deepEqual(
      await provider.embed("HTTP-router service"),
      await provider.embed("HTTPRouter services"),
    );
  });
});

class FakeSemanticEmbeddingProvider implements EmbeddingProvider {
  public readonly dimension = 3;
  public calls = 0;

  public embed(text: string): Promise<readonly number[]> {
    this.calls += 1;
    const normalized = text.toLowerCase();
    if (/login|credential|authentication|token|browser session/.test(normalized)) {
      return Promise.resolve([1, 0, 0]);
    }
    if (/billing|invoice|relational|database/.test(normalized)) return Promise.resolve([0, 1, 0]);
    return Promise.resolve([0, 0, 1]);
  }
}

async function storeArchitectureDecisions(
  repository: string,
  decisions: readonly string[],
): Promise<void> {
  const artifact: ArtifactRef = {
    path: "architecture.md",
    kind: "architecture",
    stage: "ARCH",
    summary: "Semantic memory fixture",
  };
  const context = withArchitecture(
    createTaskContext({
      runId: "semantic-fixture-run",
      requirement: "Exercise semantic memory",
      repoPath: repository,
      branch: "forgemind/semantic-fixture-run",
      tokenBudget: DEFAULT_TOKEN_BUDGETS,
    }),
    {
      decisions,
      files: [],
      risks: [],
      summary: "Semantic memory fixture",
    },
    artifact,
  );
  await new ProjectMemory({ repositoryRoot: repository, writeEnabled: true }).remember(
    context,
    artifact,
  );
}
