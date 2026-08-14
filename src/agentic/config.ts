import { HardFailure } from "../core/errors.js";
import {
  DEVELOPMENT_EVENT_SOURCES,
  DEVELOPMENT_EVENT_TYPES,
  type AgenticConfig,
  type AgenticGuardrailConfig,
  type DevelopmentEventSource,
  type DevelopmentEventType,
  type RunPriority,
  type TriggerRule,
} from "./types.js";

const DEFAULT_DAILY_TASK_QUOTA = 20;
const DEFAULT_RATE_LIMIT = { maxRuns: 5, windowMs: 60_000 } as const;
const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1_000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;

export function parseAgenticConfig(value: unknown, source = "agentic config"): AgenticConfig {
  const root = objectValue(value, source);
  assertOnlyKeys(
    root,
    ["repositories", "dailyTaskQuota", "rateLimit", "dedupeTtlMs", "guardrails", "rules"],
    source,
  );
  const repositories = uniqueStrings(root["repositories"], `${source}.repositories`);
  if (repositories.length === 0) {
    throw new HardFailure(`${source}.repositories must contain at least one repository`);
  }
  const repositorySet = new Set(repositories);
  const guardrails = parseGuardrails(root["guardrails"], `${source}.guardrails`);
  const rules = parseRules(root["rules"], repositorySet, `${source}.rules`);
  return {
    repositories,
    dailyTaskQuota:
      root["dailyTaskQuota"] === undefined
        ? DEFAULT_DAILY_TASK_QUOTA
        : boundedInteger(root["dailyTaskQuota"], 1, 1_000, `${source}.dailyTaskQuota`),
    rateLimit:
      root["rateLimit"] === undefined
        ? DEFAULT_RATE_LIMIT
        : parseRateLimit(root["rateLimit"], `${source}.rateLimit`),
    dedupeTtlMs:
      root["dedupeTtlMs"] === undefined
        ? DEFAULT_DEDUPE_TTL_MS
        : boundedInteger(root["dedupeTtlMs"], 1_000, MAX_DURATION_MS, `${source}.dedupeTtlMs`),
    guardrails,
    rules,
  };
}

function parseRateLimit(value: unknown, source: string): AgenticConfig["rateLimit"] {
  const input = objectValue(value, source);
  assertOnlyKeys(input, ["maxRuns", "windowMs"], source);
  return {
    maxRuns: boundedInteger(input["maxRuns"], 1, 1_000, `${source}.maxRuns`),
    windowMs: boundedInteger(input["windowMs"], 1_000, MAX_DURATION_MS, `${source}.windowMs`),
  };
}

function parseGuardrails(value: unknown, source: string): AgenticGuardrailConfig {
  const input = objectValue(value, source);
  assertOnlyKeys(input, ["allowedTools", "allowedCommands"], source);
  const allowedTools = uniqueStrings(input["allowedTools"], `${source}.allowedTools`);
  if (allowedTools.length === 0) {
    throw new HardFailure(`${source}.allowedTools must contain at least one tool`);
  }
  const allowedCommands = arrayValue(input["allowedCommands"], `${source}.allowedCommands`).map(
    (entry, index) => {
      const command = stringArray(entry, `${source}.allowedCommands[${index}]`);
      if (command.length === 0) {
        throw new HardFailure(`${source}.allowedCommands[${index}] cannot be empty`);
      }
      return command;
    },
  );
  const commandKeys = allowedCommands.map((command) => JSON.stringify(command));
  if (new Set(commandKeys).size !== commandKeys.length) {
    throw new HardFailure(`${source}.allowedCommands must not contain duplicates`);
  }
  return { allowedTools, allowedCommands };
}

function parseRules(
  value: unknown,
  repositories: ReadonlySet<string>,
  source: string,
): readonly TriggerRule[] {
  const input = arrayValue(value, source);
  if (input.length === 0) throw new HardFailure(`${source} must contain at least one rule`);
  const rules = input.map((entry, index) => parseRule(entry, repositories, `${source}[${index}]`));
  const ids = rules.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length)
    throw new HardFailure(`${source} contains duplicate rule ids`);
  return rules;
}

function parseRule(value: unknown, repositories: ReadonlySet<string>, source: string): TriggerRule {
  const input = objectValue(value, source);
  assertOnlyKeys(input, ["id", "enabled", "match", "run", "cooldownMs"], source);
  const id = nonEmptyString(input["id"], `${source}.id`);
  const match = parseMatch(input["match"], repositories, `${source}.match`);
  const run = parseRun(input["run"], `${source}.run`);
  return {
    id,
    enabled:
      input["enabled"] === undefined ? true : booleanValue(input["enabled"], `${source}.enabled`),
    match,
    run,
    cooldownMs:
      input["cooldownMs"] === undefined
        ? DEFAULT_COOLDOWN_MS
        : boundedInteger(input["cooldownMs"], 0, MAX_DURATION_MS, `${source}.cooldownMs`),
  };
}

function parseMatch(
  value: unknown,
  repositories: ReadonlySet<string>,
  source: string,
): TriggerRule["match"] {
  const input = objectValue(value, source);
  assertOnlyKeys(input, ["type", "source", "repo", "labelsAll", "contextEquals"], source);
  const repo =
    input["repo"] === undefined ? undefined : nonEmptyString(input["repo"], `${source}.repo`);
  if (repo !== undefined && !repositories.has(repo)) {
    throw new HardFailure(`${source}.repo must be present in the repository allowlist`);
  }
  return {
    type: enumeration(
      input["type"],
      DEVELOPMENT_EVENT_TYPES,
      `${source}.type`,
    ) as DevelopmentEventType,
    ...(input["source"] === undefined
      ? {}
      : {
          source: enumeration(
            input["source"],
            DEVELOPMENT_EVENT_SOURCES,
            `${source}.source`,
          ) as DevelopmentEventSource,
        }),
    ...(repo === undefined ? {} : { repo }),
    labelsAll:
      input["labelsAll"] === undefined
        ? []
        : uniqueStrings(input["labelsAll"], `${source}.labelsAll`),
    contextEquals:
      input["contextEquals"] === undefined
        ? {}
        : scalarRecord(input["contextEquals"], `${source}.contextEquals`),
  };
}

function parseRun(value: unknown, source: string): TriggerRule["run"] {
  const input = objectValue(value, source);
  assertOnlyKeys(input, ["requirement", "priority"], source);
  const requirement = nonEmptyString(input["requirement"], `${source}.requirement`);
  if (requirement.length > 100_000) {
    throw new HardFailure(`${source}.requirement exceeds 100,000 characters`);
  }
  return {
    requirement,
    priority:
      input["priority"] === undefined
        ? "normal"
        : (enumeration(
            input["priority"],
            ["low", "normal", "high"],
            `${source}.priority`,
          ) as RunPriority),
  };
}

function scalarRecord(
  value: unknown,
  source: string,
): Readonly<Record<string, string | number | boolean | null>> {
  const input = objectValue(value, source);
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new HardFailure(`${source}.${key} must be a JSON scalar`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new HardFailure(`${source}.${key} must be finite`);
    }
    result[key] = entry;
  }
  return result;
}

function uniqueStrings(value: unknown, source: string): readonly string[] {
  const items = stringArray(value, source).map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw new HardFailure(`${source} must contain only non-empty strings`);
  }
  if (new Set(items).size !== items.length) {
    throw new HardFailure(`${source} must not contain duplicates`);
  }
  return items;
}

function stringArray(value: unknown, source: string): readonly string[] {
  const input = arrayValue(value, source);
  if (!input.every((entry) => typeof entry === "string")) {
    throw new HardFailure(`${source} must be an array of strings`);
  }
  return input.filter((entry): entry is string => typeof entry === "string");
}

function arrayValue(value: unknown, source: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new HardFailure(`${source} must be an array`);
  return value;
}

function objectValue(value: unknown, source: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HardFailure(`${source} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonEmptyString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HardFailure(`${source} must be a non-empty string`);
  }
  return value.trim();
}

function booleanValue(value: unknown, source: string): boolean {
  if (typeof value !== "boolean") throw new HardFailure(`${source} must be a boolean`);
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, source: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    throw new HardFailure(`${source} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function enumeration(value: unknown, allowed: readonly string[], source: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HardFailure(`${source} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  source: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new HardFailure(`Unknown option ${source}.${unknown}`);
}
