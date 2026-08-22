import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FatalFailure, HardFailure } from "../core/errors.js";
import {
  DEVELOPMENT_EVENT_SOURCES,
  DEVELOPMENT_EVENT_TYPES,
  type AgenticRunRequest,
  type DevelopmentContextValue,
  type DevelopmentEvent,
  type TriggerDecision,
} from "./types.js";

const DEFAULT_MAX_STATE_BYTES = 10 * 1024 * 1024;
const MAX_STATE_ENTRIES = 100_000;

export interface AgenticTriggerCheckpoint {
  readonly seenEvents: Readonly<Record<string, number>>;
  readonly lastTriggered: Readonly<
    Record<string, { readonly at: number; readonly requestId: string }>
  >;
  readonly pending: readonly {
    readonly key: string;
    readonly ruleId: string;
    readonly event: DevelopmentEvent;
    readonly notBefore: number;
  }[];
  readonly dailyCounts: Readonly<Record<string, number>>;
  readonly recentRuns: readonly number[];
}

export interface AgenticWatchCheckpoint {
  readonly version: 1;
  readonly cursors: Readonly<Record<string, string>>;
  readonly trigger: AgenticTriggerCheckpoint;
  readonly dispatchRetries: readonly Extract<TriggerDecision, { readonly kind: "TRIGGER" }>[];
}

export interface AgenticStateStore {
  load(): Promise<AgenticWatchCheckpoint | null>;
  save(checkpoint: AgenticWatchCheckpoint): Promise<void>;
}

export interface FileAgenticStateStoreOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
}

/** Atomic, fail-closed JSON checkpoint storage for the active watch layer. */
export class FileAgenticStateStore implements AgenticStateStore {
  readonly #filePath: string;
  readonly #maxBytes: number;

  public constructor(options: FileAgenticStateStoreOptions) {
    if (options.filePath.trim().length === 0) {
      throw new HardFailure("Agentic state filePath cannot be empty");
    }
    this.#filePath = path.resolve(options.filePath);
    this.#maxBytes = positiveInteger(
      options.maxBytes ?? DEFAULT_MAX_STATE_BYTES,
      "agentic state maxBytes",
    );
  }

  public async load(): Promise<AgenticWatchCheckpoint | null> {
    let metadata;
    try {
      metadata = await stat(this.#filePath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new FatalFailure(`Cannot inspect agentic state ${this.#filePath}`, { cause: error });
    }
    if (!metadata.isFile()) {
      throw new FatalFailure(`Agentic state path is not a regular file: ${this.#filePath}`);
    }
    if (metadata.size > this.#maxBytes) {
      throw new FatalFailure(`Agentic state ${this.#filePath} exceeds ${this.#maxBytes} bytes`);
    }
    let content: string;
    try {
      content = await readFile(this.#filePath, "utf8");
    } catch (error) {
      throw new FatalFailure(`Cannot read agentic state ${this.#filePath}`, { cause: error });
    }
    try {
      return parseAgenticWatchCheckpoint(JSON.parse(content) as unknown);
    } catch (error) {
      if (error instanceof FatalFailure) throw error;
      throw new FatalFailure(`Invalid agentic state ${this.#filePath}`, { cause: error });
    }
  }

  public async save(checkpoint: AgenticWatchCheckpoint): Promise<void> {
    const validated = parseAgenticWatchCheckpoint(checkpoint);
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(content) > this.#maxBytes) {
      throw new FatalFailure(`Agentic state ${this.#filePath} exceeds ${this.#maxBytes} bytes`);
    }
    const directory = path.dirname(this.#filePath);
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, this.#filePath);
    } catch (error) {
      throw new FatalFailure(`Cannot persist agentic state ${this.#filePath}`, { cause: error });
    }
  }
}

export function parseAgenticWatchCheckpoint(value: unknown): AgenticWatchCheckpoint {
  const root = objectValue(value, "agentic state");
  assertOnlyKeys(root, ["version", "cursors", "trigger", "dispatchRetries"], "agentic state");
  if (root["version"] !== 1) throw new FatalFailure("agentic state.version must be 1");
  const cursors = stringRecord(root["cursors"], "agentic state.cursors");
  const trigger = parseTriggerCheckpoint(root["trigger"]);
  const retries = arrayValue(root["dispatchRetries"], "agentic state.dispatchRetries");
  boundedEntries(retries.length, "agentic state.dispatchRetries");
  const dispatchRetries = retries.map((entry, index) =>
    triggerDecision(entry, `agentic state.dispatchRetries[${index}]`),
  );
  const retryIds = dispatchRetries.map((decision) => decision.request.id);
  if (new Set(retryIds).size !== retryIds.length) {
    throw new FatalFailure("agentic state.dispatchRetries contains duplicate request ids");
  }
  return { version: 1, cursors, trigger, dispatchRetries };
}

function parseTriggerCheckpoint(value: unknown): AgenticTriggerCheckpoint {
  const input = objectValue(value, "agentic state.trigger");
  assertOnlyKeys(
    input,
    ["seenEvents", "lastTriggered", "pending", "dailyCounts", "recentRuns"],
    "agentic state.trigger",
  );
  const seenEvents = numberRecord(input["seenEvents"], "agentic state.trigger.seenEvents");
  const dailyCounts = integerRecord(input["dailyCounts"], "agentic state.trigger.dailyCounts");
  const lastInput = objectValue(input["lastTriggered"], "agentic state.trigger.lastTriggered");
  boundedEntries(Object.keys(lastInput).length, "agentic state.trigger.lastTriggered");
  const lastTriggered = Object.create(null) as Record<
    string,
    { readonly at: number; readonly requestId: string }
  >;
  for (const [key, entry] of Object.entries(lastInput)) {
    nonEmpty(key, "agentic state.trigger.lastTriggered key");
    const item = objectValue(entry, `agentic state.trigger.lastTriggered.${key}`);
    assertOnlyKeys(item, ["at", "requestId"], `agentic state.trigger.lastTriggered.${key}`);
    lastTriggered[key] = {
      at: finiteNumber(item["at"], `agentic state.trigger.lastTriggered.${key}.at`),
      requestId: text(item["requestId"], `agentic state.trigger.lastTriggered.${key}.requestId`),
    };
  }
  const pendingInput = arrayValue(input["pending"], "agentic state.trigger.pending");
  boundedEntries(pendingInput.length, "agentic state.trigger.pending");
  const pending = pendingInput.map((entry, index) => {
    const source = `agentic state.trigger.pending[${index}]`;
    const item = objectValue(entry, source);
    assertOnlyKeys(item, ["key", "ruleId", "event", "notBefore"], source);
    return {
      key: text(item["key"], `${source}.key`),
      ruleId: text(item["ruleId"], `${source}.ruleId`),
      event: developmentEvent(item["event"], `${source}.event`),
      notBefore: finiteNumber(item["notBefore"], `${source}.notBefore`),
    };
  });
  if (new Set(pending.map((entry) => entry.key)).size !== pending.length) {
    throw new FatalFailure("agentic state.trigger.pending contains duplicate keys");
  }
  const recentInput = arrayValue(input["recentRuns"], "agentic state.trigger.recentRuns");
  boundedEntries(recentInput.length, "agentic state.trigger.recentRuns");
  const recentRuns = recentInput.map((entry, index) =>
    finiteNumber(entry, `agentic state.trigger.recentRuns[${index}]`),
  );
  return { seenEvents, lastTriggered, pending, dailyCounts, recentRuns };
}

function triggerDecision(
  value: unknown,
  source: string,
): Extract<TriggerDecision, { readonly kind: "TRIGGER" }> {
  const input = objectValue(value, source);
  assertOnlyKeys(input, ["kind", "event", "reason", "ruleId", "request"], source);
  if (input["kind"] !== "TRIGGER" || input["reason"] !== "matched") {
    throw new FatalFailure(`${source} must be a matched TRIGGER decision`);
  }
  const event = developmentEvent(input["event"], `${source}.event`);
  return {
    kind: "TRIGGER",
    reason: "matched",
    ruleId: text(input["ruleId"], `${source}.ruleId`),
    event,
    request: runRequest(input["request"], `${source}.request`, event),
  };
}

function runRequest(
  value: unknown,
  source: string,
  fallbackEvent: DevelopmentEvent,
): AgenticRunRequest {
  const input = objectValue(value, source);
  assertOnlyKeys(
    input,
    [
      "id",
      "actor",
      "repository",
      "requirement",
      "priority",
      "ruleId",
      "sourceEventIds",
      "triggeredAt",
      "origin",
    ],
    source,
  );
  if (input["actor"] !== "agentic") throw new FatalFailure(`${source}.actor must be agentic`);
  const priority = enumeration(input["priority"], ["low", "normal", "high"], `${source}.priority`);
  return {
    id: text(input["id"], `${source}.id`),
    actor: "agentic",
    repository: text(input["repository"], `${source}.repository`),
    requirement: text(input["requirement"], `${source}.requirement`),
    priority,
    ruleId: text(input["ruleId"], `${source}.ruleId`),
    sourceEventIds: stringArray(input["sourceEventIds"], `${source}.sourceEventIds`),
    triggeredAt: timestamp(input["triggeredAt"], `${source}.triggeredAt`),
    origin:
      input["origin"] === undefined
        ? {
            source: fallbackEvent.source,
            type: fallbackEvent.type,
            object: fallbackEvent.object,
            context: fallbackEvent.context,
          }
        : requestOrigin(input["origin"], `${source}.origin`),
  };
}

function requestOrigin(value: unknown, source: string): AgenticRunRequest["origin"] {
  const input = objectValue(value, source);
  assertOnlyKeys(input, ["source", "type", "object", "context"], source);
  const event = developmentEvent(
    {
      id: "checkpoint-origin",
      source: input["source"],
      type: input["type"],
      repo: "checkpoint-origin",
      object: input["object"],
      occurredAt: "1970-01-01T00:00:00.000Z",
      labels: [],
      context: input["context"],
    },
    source,
  );
  return {
    source: event.source,
    type: event.type,
    object: event.object,
    context: event.context,
  };
}

function developmentEvent(value: unknown, source: string): DevelopmentEvent {
  const input = objectValue(value, source);
  assertOnlyKeys(
    input,
    ["id", "source", "type", "repo", "object", "occurredAt", "actor", "labels", "context"],
    source,
  );
  const object = objectValue(input["object"], `${source}.object`);
  assertOnlyKeys(object, ["kind", "id", "title", "url"], `${source}.object`);
  const contextInput = objectValue(input["context"], `${source}.context`);
  const context = Object.create(null) as Record<string, DevelopmentContextValue>;
  for (const [key, entry] of Object.entries(contextInput)) {
    context[key] = contextValue(entry, `${source}.context.${key}`);
  }
  const actor = optionalText(input["actor"], `${source}.actor`);
  const title = optionalText(object["title"], `${source}.object.title`);
  const url = optionalText(object["url"], `${source}.object.url`);
  return {
    id: text(input["id"], `${source}.id`),
    source: enumeration(input["source"], DEVELOPMENT_EVENT_SOURCES, `${source}.source`),
    type: enumeration(input["type"], DEVELOPMENT_EVENT_TYPES, `${source}.type`),
    repo: text(input["repo"], `${source}.repo`),
    object: {
      kind: enumeration(
        object["kind"],
        ["issue", "pull_request", "workflow", "approval"],
        `${source}.object.kind`,
      ),
      id: text(object["id"], `${source}.object.id`),
      ...(title === undefined ? {} : { title }),
      ...(url === undefined ? {} : { url }),
    },
    occurredAt: timestamp(input["occurredAt"], `${source}.occurredAt`),
    ...(actor === undefined ? {} : { actor }),
    labels: stringArray(input["labels"], `${source}.labels`),
    context,
  };
}

function contextValue(value: unknown, source: string): DevelopmentContextValue {
  if (Array.isArray(value)) return stringArray(value, source);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new FatalFailure(`${source} must be a JSON scalar or string array`);
}

function stringRecord(value: unknown, source: string): Readonly<Record<string, string>> {
  const input = objectValue(value, source);
  boundedEntries(Object.keys(input).length, source);
  const result = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(input)) {
    nonEmpty(key, `${source} key`);
    result[key] = text(entry, `${source}.${key}`);
  }
  return result;
}

function numberRecord(value: unknown, source: string): Readonly<Record<string, number>> {
  const input = objectValue(value, source);
  boundedEntries(Object.keys(input).length, source);
  const result = Object.create(null) as Record<string, number>;
  for (const [key, entry] of Object.entries(input)) {
    nonEmpty(key, `${source} key`);
    result[key] = finiteNumber(entry, `${source}.${key}`);
  }
  return result;
}

function integerRecord(value: unknown, source: string): Readonly<Record<string, number>> {
  const input = objectValue(value, source);
  boundedEntries(Object.keys(input).length, source);
  const result = Object.create(null) as Record<string, number>;
  for (const [key, entry] of Object.entries(input)) {
    nonEmpty(key, `${source} key`);
    if (!Number.isInteger(entry) || typeof entry !== "number" || entry < 0) {
      throw new FatalFailure(`${source}.${key} must be a non-negative integer`);
    }
    result[key] = entry;
  }
  return result;
}

function stringArray(value: unknown, source: string): readonly string[] {
  const input = arrayValue(value, source);
  boundedEntries(input.length, source);
  return input.map((entry, index) => text(entry, `${source}[${index}]`));
}

function objectValue(value: unknown, source: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FatalFailure(`${source} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function arrayValue(value: unknown, source: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new FatalFailure(`${source} must be an array`);
  return value;
}

function optionalText(value: unknown, source: string): string | undefined {
  return value === undefined ? undefined : text(value, source);
}

function text(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FatalFailure(`${source} must be a non-empty string`);
  }
  return value;
}

function nonEmpty(value: string, source: string): void {
  if (value.length === 0) throw new FatalFailure(`${source} cannot be empty`);
}

function timestamp(value: unknown, source: string): string {
  const result = text(value, source);
  if (!Number.isFinite(Date.parse(result))) throw new FatalFailure(`${source} must be an ISO time`);
  return result;
}

function finiteNumber(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FatalFailure(`${source} must be a finite number`);
  }
  return value;
}

function positiveInteger(value: number, source: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HardFailure(`${source} must be a positive integer`);
  }
  return value;
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  source: string,
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new FatalFailure(`${source} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  source: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new FatalFailure(`${source} contains unknown fields: ${extras.join(", ")}`);
  }
}

function boundedEntries(count: number, source: string): void {
  if (count > MAX_STATE_ENTRIES) {
    throw new FatalFailure(`${source} exceeds ${MAX_STATE_ENTRIES} entries`);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
