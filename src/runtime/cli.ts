#!/usr/bin/env node
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { EventLog } from "../core/event-log.js";
import { replay } from "../core/replay.js";
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
  const apiKey = process.env["OPENAI_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required");
  }
  const model = values.get("model") ?? process.env["FORGEMIND_MODEL"] ?? "gpt-4.1-mini";
  const provider = new OpenAICompatibleChatProvider({
    apiKey,
    baseUrl:
      values.get("base-url") ??
      process.env["OPENAI_BASE_URL"] ??
      "https://api.openai.com/v1",
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
  const eventLog = EventLog.open(
    path.join(workspace.gitDirectory, "forgemind", "runs"),
    runId,
  );
  process.stdout.write(`${JSON.stringify(replay(await eventLog.load()), null, 2)}\n`);
  return 0;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}`);
    }
    const key = flag.slice(2);
    if (values.has(key)) throw new Error(`Duplicate option: --${key}`);
    values.set(key, value);
  }
  return { command, values };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function assertKnownOptions(
  values: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  for (const key of values.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown option: --${key}`);
  }
}

function printHelp(): void {
  process.stdout.write(`ForgeMind\n\nUsage:\n  forge-mind run --repo <path> --requirement <text> [--model <name>] [--test-command <command>] [--max-rework <n>]\n  forge-mind replay --repo <path> --run-id <id>\n\nEnvironment:\n  OPENAI_API_KEY      Required for run\n  OPENAI_BASE_URL     OpenAI-compatible API base URL\n  FORGEMIND_MODEL     Default model name\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
