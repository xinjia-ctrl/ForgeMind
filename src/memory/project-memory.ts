import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAcceptanceSatisfied } from "../core/acceptance.js";
import type { EventLog } from "../core/event-log.js";
import { throwIfCancelled } from "../core/errors.js";
import type { ArtifactRef, GateResult, StageId, TaskContext } from "../core/types.js";
import type { DecisionRecord } from "../negotiation/types.js";
import type { RunQualityMetrics } from "../quality/types.js";
import { keywords } from "./keywords.js";
import type { MemoryProvider, RecallOptions, Retrieval } from "./memory-provider.js";
import {
  PROJECT_MEMORY_FILES,
  isProjectMemoryEntryActive,
  type ProjectMemoryDocument,
  type ProjectMemoryEntry,
  type ProjectMemoryFile,
  type ProjectMemoryPermissions,
  readProjectMemoryDocument,
} from "./project-memory-document.js";

export interface ProjectMemoryOptions {
  readonly repositoryRoot: string;
  readonly writeEnabled: boolean;
  readonly eventLog?: EventLog;
  readonly clock?: () => Date;
  readonly governanceRole?: ProjectMemoryPermissions["write"];
}

export interface MemoryCorrection {
  readonly kind: ProjectMemoryEntry["kind"];
  readonly content: string;
  readonly tags?: readonly string[];
  readonly stage: StageId;
  readonly confidence: number;
  readonly expiresAt?: string | null;
}

export class ProjectMemory implements MemoryProvider {
  readonly #directory: string;
  readonly #writeEnabled: boolean;
  readonly #eventLog: EventLog | undefined;
  readonly #clock: () => Date;
  readonly #governanceRole: ProjectMemoryPermissions["write"];

  public constructor(options: ProjectMemoryOptions) {
    this.#directory = path.join(options.repositoryRoot, ".forgemind", "memory");
    this.#writeEnabled = options.writeEnabled;
    this.#eventLog = options.eventLog;
    this.#clock = options.clock ?? (() => new Date());
    this.#governanceRole = options.governanceRole ?? "agent";
  }

  public async remember(ctx: TaskContext, artifact: ArtifactRef): Promise<void> {
    if (
      !this.#writeEnabled ||
      artifact.kind !== "commit" ||
      ctx.architecture === null ||
      !isIndependentlyVerified(ctx)
    )
      return;
    const entries: ProjectMemoryEntry[] = [
      ...ctx.architecture.decisions.map((decision) =>
        memoryEntry("decision", decision, ctx.runId, "ARCH", ["architecture"], {
          now: this.#clock(),
          confidence: 0.65,
        }),
      ),
      ...ctx.architecture.files.map((file) =>
        memoryEntry(
          "file",
          `File ${file.path}: ${file.purpose}`,
          ctx.runId,
          "ARCH",
          ["architecture", file.path],
          {
            now: this.#clock(),
            confidence: 0.65,
          },
        ),
      ),
    ];
    await this.store("decisions.json", entries, ctx.runId);
  }

  public rememberGate(ctx: TaskContext, gate: GateResult): Promise<void> {
    // A single gate verdict is episodic evidence, not a durable project fact.
    // Validated run-level outcomes are promoted by rememberQuality instead.
    void ctx;
    void gate;
    return Promise.resolve();
  }

  public async rememberDecisionRecord(record: DecisionRecord): Promise<void> {
    if (!this.#writeEnabled) return;
    const positions = record.positions
      .map((position) => `${position.side}: ${position.position}`)
      .join(" | ");
    const entry = memoryEntry(
      "decision",
      `Negotiation ${record.topic}: ${record.decision}. Positions: ${positions}`,
      record.runId,
      stageForDecision(record),
      ["negotiation", record.trigger, record.topic, record.createdAt],
      {
        now: this.#clock(),
        confidence: record.escalated ? 0.9 : 0.75,
      },
    );
    await this.store("decisions.json", [entry], record.runId);
  }

  public async rememberQuality(quality: RunQualityMetrics): Promise<void> {
    if (
      !this.#writeEnabled ||
      quality.outcome !== "succeeded" ||
      quality.evidenceCompleteness < 100 ||
      quality.verificationStrength === "weak" ||
      quality.policyViolations > 0
    ) {
      return;
    }
    const coverage =
      quality.coveragePercent === null
        ? "code coverage unavailable"
        : `code coverage ${quality.coveragePercent}%`;
    const entry = memoryEntry(
      "lesson",
      [
        `Independently verified run for requirement: ${quality.requirement || "unknown"}; outcome ${quality.outcome};`,
        `evidence completeness ${quality.evidenceCompleteness}%; verification strength ${quality.verificationStrength};`,
        `rework rounds ${quality.reworkRounds};`,
        `policy violations ${quality.policyViolations}; confidence ${quality.confidence};`,
        `${coverage}.`,
      ].join(" "),
      quality.runId,
      "TEST",
      ["quality", quality.verificationStrength, quality.outcome, "run-quality"],
      {
        now: this.#clock(),
        confidence: quality.confidence,
      },
    );
    await this.store("lessons.json", [entry], quality.runId);
  }

  public async supersede(
    file: ProjectMemoryFile,
    entryId: string,
    correction: MemoryCorrection,
    sourceRunId: string,
  ): Promise<ProjectMemoryEntry> {
    if (!this.#writeEnabled) throw new Error("Project memory writes are disabled");
    const document = await this.read(file);
    const previous = document.entries.find((entry) => entry.id === entryId);
    if (previous === undefined) throw new Error(`Project memory entry not found: ${entryId}`);
    this.assertCanGovern(previous);
    if (previous.status !== "active") {
      throw new Error(`Project memory entry is not active: ${entryId}`);
    }
    const now = this.#clock();
    const replacement = memoryEntry(
      correction.kind,
      correction.content,
      sourceRunId,
      correction.stage,
      correction.tags ?? [],
      {
        now,
        confidence: correction.confidence,
        expiresAt: correction.expiresAt ?? null,
        supersedes: previous.id,
      },
    );
    if (
      replacement.id === previous.id ||
      document.entries.some((entry) => entry.id === replacement.id)
    ) {
      throw new Error("Memory correction must produce a new, unique entry");
    }
    const entries = document.entries.map((entry) =>
      entry.id === previous.id
        ? { ...entry, status: "superseded" as const, updatedAt: now.toISOString() }
        : entry,
    );
    await this.write(file, [...entries, replacement]);
    return replacement;
  }

  public async tombstone(
    file: ProjectMemoryFile,
    entryId: string,
    sourceRunId: string,
  ): Promise<void> {
    if (!this.#writeEnabled) throw new Error("Project memory writes are disabled");
    const document = await this.read(file);
    const current = document.entries.find((entry) => entry.id === entryId);
    if (current === undefined) throw new Error(`Project memory entry not found: ${entryId}`);
    this.assertCanGovern(current);
    const updatedAt = this.#clock().toISOString();
    await this.write(
      file,
      document.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              status: "tombstone" as const,
              updatedAt,
              validatedByRunIds: [...new Set([...entry.validatedByRunIds, sourceRunId])],
            }
          : entry,
      ),
    );
  }

  public async recall(query: string, options: RecallOptions = {}): Promise<readonly Retrieval[]> {
    throwIfCancelled(options.signal);
    if (options.scopes !== undefined && !options.scopes.includes("project")) return [];
    const queryTerms = keywords(query);
    const documents = await Promise.all(
      PROJECT_MEMORY_FILES.map(async (file) => ({
        file,
        document: await this.read(file),
      })),
    );
    throwIfCancelled(options.signal);
    return documents
      .flatMap(({ file, document }) =>
        document.entries.map((entry): Retrieval | null => {
          if (!isProjectMemoryEntryActive(entry, this.#clock())) return null;
          if (entry.permissions.read !== "project") return null;
          const tagOverlap = overlap(queryTerms, entry.tags.join(" "));
          const contentOverlap = overlap(queryTerms, entry.content);
          const matches = [...new Set([...tagOverlap, ...contentOverlap])];
          if (queryTerms.length > 0 && matches.length === 0) return null;
          return {
            entryId: entry.id,
            content: entry.content,
            source: path.join(".forgemind", "memory", file),
            timestamp: entry.updatedAt,
            confidence: entry.confidence,
            score: tagOverlap.length * 2 + contentOverlap.length + 0.5,
            scope: "project",
            reason: `tag/content overlap: ${matches.join(", ") || "empty query"}`,
          };
        }),
      )
      .filter((item): item is Retrieval => item !== null)
      .sort((left, right) => right.score - left.score || left.content.localeCompare(right.content))
      .slice(0, options.limit ?? 8);
  }

  private async store(
    file: ProjectMemoryFile,
    entries: readonly ProjectMemoryEntry[],
    runId: string,
  ) {
    const current = await this.read(file);
    const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
    const added = entries.filter((entry) => !byId.has(entry.id));
    const validated: ProjectMemoryEntry[] = [];
    for (const entry of entries) {
      const existing = byId.get(entry.id);
      if (existing === undefined) {
        byId.set(entry.id, entry);
        continue;
      }
      if (existing.status === "active" && !existing.validatedByRunIds.includes(entry.sourceRunId)) {
        const updated = {
          ...existing,
          updatedAt: entry.updatedAt,
          confidence: Math.min(1, Math.max(existing.confidence, entry.confidence) + 0.05),
          validatedByRunIds: [...existing.validatedByRunIds, entry.sourceRunId],
        };
        byId.set(entry.id, updated);
        validated.push(updated);
      }
    }
    if (added.length === 0 && validated.length === 0) return;
    const document: ProjectMemoryDocument = {
      version: 2,
      entries: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
    await this.write(file, document.entries);
    if (this.#eventLog !== undefined) {
      for (const entry of [...added, ...validated]) {
        await this.#eventLog.append({
          type: "memory.stored",
          data: {
            runId,
            stage: entry.stage,
            scope: "project",
            kind: entry.kind,
            path: path.join(".forgemind", "memory", file),
          },
        });
      }
    }
  }

  private async write(
    file: ProjectMemoryFile,
    entries: readonly ProjectMemoryEntry[],
  ): Promise<void> {
    const document: ProjectMemoryDocument = {
      version: 2,
      entries: [...entries].sort((left, right) => left.id.localeCompare(right.id)),
    };
    await mkdir(this.#directory, { recursive: true });
    const target = path.join(this.#directory, file);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
  }

  private async read(file: ProjectMemoryFile): Promise<ProjectMemoryDocument> {
    return await readProjectMemoryDocument(this.#directory, file);
  }

  private assertCanGovern(entry: ProjectMemoryEntry): void {
    if (entry.permissions.write === "maintainer" && this.#governanceRole !== "maintainer") {
      throw new Error(`Maintainer permission is required to govern memory entry ${entry.id}`);
    }
  }
}

function isIndependentlyVerified(ctx: TaskContext): boolean {
  try {
    assertAcceptanceSatisfied(ctx);
  } catch {
    return false;
  }
  const latestTest = [...ctx.gates].reverse().find((gate) => gate.stage === "TEST");
  const latestReview = [...ctx.gates].reverse().find((gate) => gate.stage === "REVIEW");
  return (
    latestTest?.passed === true &&
    latestReview?.passed === true &&
    latestTest.artifactFingerprint === latestReview.artifactFingerprint
  );
}

function overlap(queryTerms: readonly string[], value: string): readonly string[] {
  const valueTerms = new Set(keywords(value));
  return queryTerms.filter((term) => valueTerms.has(term));
}

function memoryEntry(
  kind: ProjectMemoryEntry["kind"],
  content: string,
  sourceRunId: string,
  stage: StageId,
  extraTags: readonly string[],
  governance: {
    readonly now: Date;
    readonly confidence: number;
    readonly expiresAt?: string | null;
    readonly supersedes?: string | null;
  },
): ProjectMemoryEntry {
  const normalized = content.trim();
  return {
    id: createHash("sha256").update(`${kind}\0${normalized}`).digest("hex"),
    kind,
    content: normalized,
    tags: [
      ...new Set([...extraTags.map((tag) => tag.toLocaleLowerCase()), ...keywords(normalized)]),
    ],
    sourceRunId,
    stage,
    createdAt: governance.now.toISOString(),
    updatedAt: governance.now.toISOString(),
    scope: "repository",
    confidence: Math.max(0, Math.min(1, governance.confidence)),
    permissions: { read: "project", write: "maintainer" },
    expiresAt: governance.expiresAt ?? null,
    supersedes: governance.supersedes ?? null,
    status: "active",
    validatedByRunIds: [sourceRunId],
  };
}

function stageForDecision(record: DecisionRecord): StageId {
  switch (record.trigger) {
    case "arch-conflict":
      return "ARCH";
    case "review-repeated-rejection":
      return "REVIEW";
    case "artifact-mismatch":
      return "CODE";
  }
}
