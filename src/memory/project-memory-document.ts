import { readFile } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import type { StageId } from "../core/types.js";

export const PROJECT_MEMORY_FILES = ["decisions.json", "lessons.json"] as const;
export type ProjectMemoryFile = (typeof PROJECT_MEMORY_FILES)[number];

export interface ProjectMemoryEntry {
  readonly id: string;
  readonly kind: "decision" | "file" | "lesson";
  readonly content: string;
  readonly tags: readonly string[];
  readonly sourceRunId: string;
  readonly stage: StageId;
}

export interface ProjectMemoryDocument {
  readonly version: 1;
  readonly entries: readonly ProjectMemoryEntry[];
}

export async function readProjectMemoryDocument(
  directory: string,
  file: ProjectMemoryFile,
): Promise<ProjectMemoryDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, file), "utf8"));
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
