#!/usr/bin/env node
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { EventLog } from "../core/event-log.js";
import { replay } from "../core/replay.js";
import { workflowSignature } from "../core/reproducibility.js";
import { OpenAICompatibleChatProvider } from "../llm/openai-compatible-provider.js";
import { inspectGitWorkspace } from "./git-workspace.js";
import { runForgeMind } from "./run.js";

interface ParsedArgs {
  readonly command: string;
  readonly values: ReadonlyMap<string, string>;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === "run") {
      assertKnownOptions(parsed.values, [
        "repo",
        "requirement",
        "model",
        "base-url",
        "run-id",
        "test-command",
        "max-rework",
        "skip-git-hooks",
      ]);
      return await runCommand(parsed.values);
    }
    if (parsed.command === "replay") {
      assertKnownOptions(parsed.values, ["repo", "run-id"]);
      return await replayCommand(parsed.values);
    }
    printHelp();
    return parsed.command === "help" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`ForgeMind error: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function runCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const repoPath = required(values, "repo");
  const requirement = required(values, "requirement");
  const maxReworkValue = values.get("max-rework");
  const maxRework = maxReworkValue === undefined ? undefined : Number(maxReworkValue);
  if (maxRework !== undefined && (!Number.isInteger(maxRework) || maxRework < 0)) {
    throw new Error("--max-rework must be a non-negative integer");
  }
  const skipGitHooks = parseBooleanOption(values, "skip-git-hooks", false);
  const apiKey = process.env["OPENAI_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required");
  }
  const model = values.get("model") ?? process.env["FORGEMIND_MODEL"] ?? "gpt-4.1-mini";
  const provider = new OpenAICompatibleChatProvider({
    apiKey,
    baseUrl:
      values.get("base-url") ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
  });
  const runId = values.get("run-id");
  const testCommand = values.get("test-command");
  const execution = await runForgeMind({
    repoPath,
    requirement,
    provider,
    model,
    ...(runId === undefined ? {} : { runId }),
    ...(testCommand === undefined ? {} : { testCommand }),
    ...(maxRework === undefined ? {} : { maxRework }),
    skipGitHooks,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: execution.result.status,
        summary: execution.result.summary,
        branch: execution.result.context.repo.branch,
        eventLog: execution.eventLogPath,
      },
      null,
      2,
    )}\n`,
  );
  return execution.result.status === "SUCCEEDED" ? 0 : 1;
}

async function replayCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const workspace = await inspectGitWorkspace(required(values, "repo"));
  const runId = required(values, "run-id");
  const eventLog = EventLog.open(path.join(workspace.gitDirectory, "forgemind", "runs"), runId);
  const events = await eventLog.load();
  process.stdout.write(
    `${JSON.stringify(
      { ...replay(events), workflowSignature: workflowSignature(events) },
      null,
      2,
    )}\n`,
  );
  return 0;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const values = new Map<string, string>();
  const booleanOptions = new Set(["skip-git-hooks"]);
  for (let index = 1; index < argv.length;) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}`);
    }
    const key = flag.slice(2);
    if (values.has(key)) throw new Error(`Duplicate option: --${key}`);
    const next = argv[index + 1];
    if (booleanOptions.has(key) && (next === undefined || next.startsWith("--"))) {
      values.set(key, "true");
      index += 1;
      continue;
    }
    if (next === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, next);
    index += 2;
  }
  return { command, values };
}

function parseBooleanOption(
  values: ReadonlyMap<string, string>,
  key: string,
  fallback: boolean,
): boolean {
  const value = values.get(key);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} must be true or false`);
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function assertKnownOptions(values: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const key of values.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown option: --${key}`);
  }
}

function printHelp(): void {
  process.stdout.write(
    `ForgeMind\n\nUsage:\n  forge-mind run --repo <path> --requirement <text> [--model <name>] [--test-command <command>] [--max-rework <n>] [--skip-git-hooks]\n  forge-mind replay --repo <path> --run-id <id>\n\nEnvironment:\n  OPENAI_API_KEY      Required for run\n  OPENAI_BASE_URL     OpenAI-compatible API base URL\n  FORGEMIND_MODEL     Default model name\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
