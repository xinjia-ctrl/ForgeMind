import { readFile } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import type { StageId } from "../core/types.js";

export const PROJECT_MEMORY_FILES = ["decisions.json", "lessons.json"] as const;
export type ProjectMemoryFile = (typeof PROJECT_MEMORY_FILES)[number];
export type ProjectMemoryStatus = "active" | "superseded" | "tombstone";

export interface ProjectMemoryPermissions {
  readonly read: "project" | "private";
  readonly write: "agent" | "maintainer";
}

export interface ProjectMemoryEntry {
  readonly id: string;
  readonly kind: "decision" | "file" | "lesson";
  readonly content: string;
  readonly tags: readonly string[];
  readonly sourceRunId: string;
  readonly stage: StageId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scope: "repository";
  readonly confidence: number;
  readonly permissions: ProjectMemoryPermissions;
  readonly expiresAt: string | null;
  readonly supersedes: string | null;
  readonly status: ProjectMemoryStatus;
  readonly validatedByRunIds: readonly string[];
}

export interface ProjectMemoryDocument {
  readonly version: 2;
  readonly entries: readonly ProjectMemoryEntry[];
}

interface LegacyProjectMemoryEntry {
  readonly id: string;
  readonly kind: ProjectMemoryEntry["kind"];
  readonly content: string;
  readonly tags: readonly string[];
  readonly sourceRunId: string;
  readonly stage: StageId;
}

interface LegacyProjectMemoryDocument {
  readonly version: 1;
  readonly entries: readonly LegacyProjectMemoryEntry[];
}

export async function readProjectMemoryDocument(
  directory: string,
  file: ProjectMemoryFile,
): Promise<ProjectMemoryDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    if (isMemoryDocument(value)) return value;
    if (isLegacyMemoryDocument(value)) return migrateLegacyDocument(value);
    throw new HardFailure(`Invalid project memory document: ${file}`);
  } catch (error) {
    if (isMissingFile(error)) return { version: 2, entries: [] };
    if (error instanceof HardFailure) throw error;
    throw new HardFailure(`Unable to read project memory document: ${file}`, { cause: error });
  }
}

export function isProjectMemoryEntryActive(entry: ProjectMemoryEntry, now = new Date()): boolean {
  if (entry.status !== "active") return false;
  if (entry.expiresAt === null) return true;
  return Date.parse(entry.expiresAt) > now.getTime();
}

function migrateLegacyDocument(document: LegacyProjectMemoryDocument): ProjectMemoryDocument {
  const legacyTimestamp = "1970-01-01T00:00:00.000Z";
  return {
    version: 2,
    entries: document.entries.map((entry) => ({
      ...entry,
      createdAt: legacyTimestamp,
      updatedAt: legacyTimestamp,
      scope: "repository",
      confidence: 0.5,
      permissions: { read: "project", write: "maintainer" },
      expiresAt: null,
      supersedes: null,
      status: "active",
      validatedByRunIds: [entry.sourceRunId],
    })),
  };
}

function isMemoryDocument(value: unknown): value is ProjectMemoryDocument {
  if (!isRecord(value) || value["version"] !== 2) return false;
  const entries: unknown = value["entries"];
  return Array.isArray(entries) && entries.every(isMemoryEntry);
}

function isLegacyMemoryDocument(value: unknown): value is LegacyProjectMemoryDocument {
  if (!isRecord(value) || value["version"] !== 1) return false;
  const entries: unknown = value["entries"];
  return Array.isArray(entries) && entries.every(isLegacyMemoryEntry);
}

function isMemoryEntry(entry: unknown): entry is ProjectMemoryEntry {
  if (!isLegacyMemoryEntry(entry)) return false;
  const governed = entry as unknown as Readonly<Record<string, unknown>>;
  const permissions = governed["permissions"];
  return (
    typeof governed["createdAt"] === "string" &&
    validTimestamp(governed["createdAt"]) &&
    typeof governed["updatedAt"] === "string" &&
    validTimestamp(governed["updatedAt"]) &&
    governed["scope"] === "repository" &&
    typeof governed["confidence"] === "number" &&
    governed["confidence"] >= 0 &&
    governed["confidence"] <= 1 &&
    isRecord(permissions) &&
    (permissions["read"] === "project" || permissions["read"] === "private") &&
    (permissions["write"] === "agent" || permissions["write"] === "maintainer") &&
    (governed["expiresAt"] === null ||
      (typeof governed["expiresAt"] === "string" && validTimestamp(governed["expiresAt"]))) &&
    (governed["supersedes"] === null || typeof governed["supersedes"] === "string") &&
    (governed["status"] === "active" ||
      governed["status"] === "superseded" ||
      governed["status"] === "tombstone") &&
    Array.isArray(governed["validatedByRunIds"]) &&
    governed["validatedByRunIds"].every((runId: unknown) => typeof runId === "string")
  );
}

function isLegacyMemoryEntry(entry: unknown): entry is LegacyProjectMemoryEntry {
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
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
