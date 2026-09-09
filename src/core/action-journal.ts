import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FatalFailure } from "./errors.js";

export type ActionJournalState = "PLANNED" | "EXECUTED" | "VERIFIED";

export interface ActionJournalRecord {
  readonly id: string;
  readonly signature: string;
  readonly beforeHash: string;
  readonly expectedAfterHash: string;
  readonly state: ActionJournalState;
  readonly plannedAt: string;
  readonly executedAt?: string;
  readonly verifiedAt?: string;
  readonly workspaceFingerprint?: string;
}

export interface ActionJournal {
  get(id: string): Promise<ActionJournalRecord | null>;
  planned(
    id: string,
    signature: string,
    expectation: {
      readonly beforeHash: string;
      readonly expectedAfterHash: string;
    },
  ): Promise<ActionJournalRecord>;
  executed(id: string): Promise<ActionJournalRecord>;
  verified(id: string, workspaceFingerprint: string): Promise<ActionJournalRecord>;
}

export class FileActionJournal implements ActionJournal {
  readonly #filePath: string;

  public constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  public async get(id: string): Promise<ActionJournalRecord | null> {
    return (await this.load()).find((record) => record.id === id) ?? null;
  }

  public async planned(
    id: string,
    signature: string,
    expectation: {
      readonly beforeHash: string;
      readonly expectedAfterHash: string;
    },
  ): Promise<ActionJournalRecord> {
    const records = await this.load();
    const existing = records.find((record) => record.id === id);
    if (existing !== undefined) {
      if (
        existing.signature !== signature ||
        existing.beforeHash !== expectation.beforeHash ||
        existing.expectedAfterHash !== expectation.expectedAfterHash
      ) {
        throw new FatalFailure(`Action journal conflict for ${id}`);
      }
      return existing;
    }
    const record: ActionJournalRecord = {
      id,
      signature,
      beforeHash: expectation.beforeHash,
      expectedAfterHash: expectation.expectedAfterHash,
      state: "PLANNED",
      plannedAt: new Date().toISOString(),
    };
    await this.save([...records, record]);
    return record;
  }

  public async executed(id: string): Promise<ActionJournalRecord> {
    return await this.transition(id, "EXECUTED");
  }

  public async verified(id: string, workspaceFingerprint: string): Promise<ActionJournalRecord> {
    return await this.transition(id, "VERIFIED", workspaceFingerprint);
  }

  private async transition(
    id: string,
    state: Extract<ActionJournalState, "EXECUTED" | "VERIFIED">,
    workspaceFingerprint?: string,
  ): Promise<ActionJournalRecord> {
    const records = await this.load();
    const index = records.findIndex((record) => record.id === id);
    const current = records[index];
    if (current === undefined)
      throw new FatalFailure(`Action journal has no PLANNED entry for ${id}`);
    if (current.state === "VERIFIED") return current;
    if (state === "VERIFIED" && current.state !== "EXECUTED") {
      throw new FatalFailure(`Action ${id} cannot transition from ${current.state} to VERIFIED`);
    }
    const now = new Date().toISOString();
    const updated: ActionJournalRecord = {
      ...current,
      state,
      ...(current.executedAt === undefined ? { executedAt: now } : {}),
      ...(state === "VERIFIED"
        ? { verifiedAt: now, workspaceFingerprint: workspaceFingerprint ?? "" }
        : {}),
    };
    const next = [...records];
    next[index] = updated;
    await this.save(next);
    return updated;
  }

  private async load(): Promise<readonly ActionJournalRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
        throw new FatalFailure("Invalid action journal");
      }
      return parsed;
    } catch (error) {
      if (isMissing(error)) return [];
      if (error instanceof FatalFailure) throw error;
      throw new FatalFailure("Cannot load action journal", { cause: error });
    }
  }

  private async save(records: readonly ActionJournalRecord[]): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.#filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new FatalFailure("Cannot persist action journal", { cause: error });
    }
  }
}

function isRecord(value: unknown): value is ActionJournalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Readonly<Record<string, unknown>>;
  return (
    typeof item["id"] === "string" &&
    typeof item["signature"] === "string" &&
    typeof item["beforeHash"] === "string" &&
    typeof item["expectedAfterHash"] === "string" &&
    (item["state"] === "PLANNED" || item["state"] === "EXECUTED" || item["state"] === "VERIFIED") &&
    typeof item["plannedAt"] === "string"
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
