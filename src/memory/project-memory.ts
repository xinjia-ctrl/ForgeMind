import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import type { EventLog } from "../core/event-log.js";
import type { ArtifactRef, GateResult, StageId, TaskContext } from "../core/types.js";
import type { DecisionRecord } from "../negotiation/types.js";
import { keywords } from "./keywords.js";
import type { MemoryProvider, RecallOptions, Retrieval } from "./memory-provider.js";

interface ProjectMemoryEntry {
  readonly id: string;
  readonly kind: "decision" | "file" | "lesson";
  readonly content: string;
  readonly tags: readonly string[];
  readonly sourceRunId: string;
  readonly stage: StageId;
}

interface ProjectMemoryDocument {
  readonly version: 1;
  readonly entries: readonly ProjectMemoryEntry[];
}

export interface ProjectMemoryOptions {
  readonly repositoryRoot: string;
  readonly writeEnabled: boolean;
  readonly eventLog?: EventLog;
}

export class ProjectMemory implements MemoryProvider {
  readonly #directory: string;
  readonly #writeEnabled: boolean;
  readonly #eventLog: EventLog | undefined;

  public constructor(options: ProjectMemoryOptions) {
    this.#directory = path.join(options.repositoryRoot, ".forgemind", "memory");
    this.#writeEnabled = options.writeEnabled;
    this.#eventLog = options.eventLog;
  }

  public async remember(ctx: TaskContext, artifact: ArtifactRef): Promise<void> {
    if (!this.#writeEnabled || artifact.kind !== "architecture" || ctx.architecture === null)
      return;
    const entries: ProjectMemoryEntry[] = [
      ...ctx.architecture.decisions.map((decision) =>
        memoryEntry("decision", decision, ctx.runId, "ARCH", ["architecture"]),
      ),
      ...ctx.architecture.files.map((file) =>
        memoryEntry("file", `File ${file.path}: ${file.purpose}`, ctx.runId, "ARCH", [
          "architecture",
          file.path,
        ]),
      ),
    ];
    await this.store("decisions.json", entries, ctx.runId);
  }

  public async rememberGate(ctx: TaskContext, gate: GateResult): Promise<void> {
    if (!this.#writeEnabled || gate.passed) return;
    const entry = memoryEntry(
      "lesson",
      `${gate.stage} rejection: ${gate.reason}. ${gate.feedback}`,
      ctx.runId,
      gate.stage,
      ["gate", "rejected", gate.stage],
    );
    await this.store("lessons.json", [entry], ctx.runId);
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
      ["negotiation", record.trigger, record.topic],
    );
    await this.store("decisions.json", [entry], record.runId);
  }

  public async recall(query: string, options: RecallOptions = {}): Promise<readonly Retrieval[]> {
    if (options.scopes !== undefined && !options.scopes.includes("project")) return [];
    const queryTerms = keywords(query);
    const documents = await Promise.all(
      ["decisions.json", "lessons.json"].map(async (file) => ({
        file,
        document: await this.read(file),
      })),
    );
    return documents
      .flatMap(({ file, document }) =>
        document.entries.map((entry): Retrieval | null => {
          const tagOverlap = overlap(queryTerms, entry.tags.join(" "));
          const contentOverlap = overlap(queryTerms, entry.content);
          const matches = [...new Set([...tagOverlap, ...contentOverlap])];
          if (queryTerms.length > 0 && matches.length === 0) return null;
          return {
            content: entry.content,
            source: path.join(".forgemind", "memory", file),
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

  private async store(file: string, entries: readonly ProjectMemoryEntry[], runId: string) {
    const current = await this.read(file);
    const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
    const added = entries.filter((entry) => !byId.has(entry.id));
    if (added.length === 0) return;
    for (const entry of added) byId.set(entry.id, entry);
    const document: ProjectMemoryDocument = {
      version: 1,
      entries: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
    await mkdir(this.#directory, { recursive: true });
    const target = path.join(this.#directory, file);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
    if (this.#eventLog !== undefined) {
      for (const entry of added) {
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

  private async read(file: string): Promise<ProjectMemoryDocument> {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.#directory, file), "utf8"));
      if (!isMemoryDocument(value)) {
        throw new HardFailure(`Invalid project memory document: ${file}`);
      }
      return value;
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, entries: [] };
      if (error instanceof HardFailure) throw error;
      throw new HardFailure(`Unable to read project memory document: ${file}`, { cause: error });
    }
  }
}

function overlap(queryTerms: readonly string[], value: string): readonly string[] {
  const valueTerms = new Set(keywords(value));
  return queryTerms.filter((term) => valueTerms.has(term));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function memoryEntry(
  kind: ProjectMemoryEntry["kind"],
  content: string,
  sourceRunId: string,
  stage: StageId,
  extraTags: readonly string[],
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
  };
}

function isMemoryDocument(value: unknown): value is ProjectMemoryDocument {
  if (!isRecord(value) || value["version"] !== 1) return false;
  const entries: unknown = value["entries"];
  if (!Array.isArray(entries)) return false;
  return entries.every((entry: unknown) => {
    if (!isRecord(entry)) return false;
    const tags: unknown = entry["tags"];
    return (
      typeof entry["id"] === "string" &&
      (entry["kind"] === "decision" || entry["kind"] === "file" || entry["kind"] === "lesson") &&
      typeof entry["content"] === "string" &&
      Array.isArray(tags) &&
      tags.every((tag: unknown) => typeof tag === "string") &&
      typeof entry["sourceRunId"] === "string" &&
      isStage(entry["stage"])
    );
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is StageId {
  return (
    value === "PLAN" ||
    value === "ARCH" ||
    value === "CODE" ||
    value === "REVIEW" ||
    value === "TEST" ||
    value === "COMMIT"
  );
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
