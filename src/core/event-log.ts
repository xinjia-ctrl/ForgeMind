import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { FatalFailure } from "./errors.js";
import type { EventInput, ForgeMindEvent } from "./events.js";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class EventLog {
  readonly #filePath: string;
  #nextSeq = 1;

  private constructor(filePath: string) {
    this.#filePath = filePath;
  }

  public static async create(directory: string, runId: string): Promise<EventLog> {
    assertValidRunId(runId);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${runId}.jsonl`);
    try {
      const handle = await open(filePath, "wx");
      await handle.close();
    } catch (error) {
      throw new FatalFailure(`Cannot create event log ${filePath}`, {
        cause: error,
      });
    }
    return new EventLog(filePath);
  }

  public static open(directory: string, runId: string): EventLog {
    assertValidRunId(runId);
    return new EventLog(path.join(directory, `${runId}.jsonl`));
  }

  public get filePath(): string {
    return this.#filePath;
  }

  public async append(input: EventInput): Promise<ForgeMindEvent> {
    const event = {
      v: 1,
      seq: this.#nextSeq,
      ts: new Date().toISOString(),
      ...input,
    } as ForgeMindEvent;

    try {
      const handle = await open(this.#filePath, "a");
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new FatalFailure(`Cannot append event log ${this.#filePath}`, {
        cause: error,
      });
    }
    this.#nextSeq += 1;
    return event;
  }

  public async load(): Promise<readonly ForgeMindEvent[]> {
    let content: string;
    try {
      content = await readFile(this.#filePath, "utf8");
    } catch (error) {
      throw new FatalFailure(`Cannot read event log ${this.#filePath}`, {
        cause: error,
      });
    }

    if (content.trim().length === 0) return [];
    return content
      .trimEnd()
      .split("\n")
      .map((line, index) => parseEvent(line, index + 1));
  }
}

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new FatalFailure(`Invalid run id: ${runId}`);
  }
}

function parseEvent(line: string, lineNumber: number): ForgeMindEvent {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== "object" ||
      value === null ||
      !("v" in value) ||
      value.v !== 1 ||
      !("seq" in value) ||
      typeof value.seq !== "number" ||
      !("ts" in value) ||
      typeof value.ts !== "string" ||
      !("type" in value) ||
      typeof value.type !== "string" ||
      !("data" in value) ||
      value.data === null ||
      typeof value.data !== "object"
    ) {
      throw new Error("invalid event shape");
    }
    return value as ForgeMindEvent;
  } catch (error) {
    throw new FatalFailure(`Invalid event at JSONL line ${lineNumber}`, {
      cause: error,
    });
  }
}
