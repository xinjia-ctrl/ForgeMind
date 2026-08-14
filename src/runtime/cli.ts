#!/usr/bin/env node
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { EventLog } from "../core/event-log.js";
import { replay } from "../core/replay.js";
import { workflowSignature } from "../core/reproducibility.js";
import { runDagForgeMind } from "../dag/run.js";
import { queryAuditEvents } from "../audit/query.js";
import { exportAuditResult } from "../audit/export.js";
import { actorById, loadActorPolicy } from "../auth/policy-source.js";
import { authorize } from "../auth/rbac.js";
import type { Actor } from "../auth/types.js";
import { createRunId } from "./run.js";
import { OpenAICompatibleChatProvider } from "../llm/openai-compatible-provider.js";
import { generateReport } from "../report/report.js";
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
        "config",
        "yes",
        "no-approve",
        "memory",
        "actor-policy",
        "actor",
        "team",
      ]);
      return await runCommand(parsed.values);
    }
    if (parsed.command === "dag run") {
      assertKnownOptions(parsed.values, [
        "repos",
        "requirement",
        "model",
        "base-url",
        "run-id",
        "test-command",
        "max-rework",
        "max-tasks",
        "max-concurrency",
        "worktrees-root",
        "skip-git-hooks",
        "config",
        "yes",
        "no-approve",
        "memory",
        "actor-policy",
        "actor",
        "team",
      ]);
      return await dagRunCommand(parsed.values);
    }
    if (parsed.command === "audit export") {
      assertKnownOptions(parsed.values, [
        "repo",
        "from",
        "to",
        "actor",
        "filter-actor",
        "filter-repo",
        "status",
        "format",
        "name",
        "actor-policy",
      ]);
      return await auditExportCommand(parsed.values);
    }
    if (parsed.command === "replay") {
      assertKnownOptions(parsed.values, ["repo", "run-id"]);
      return await replayCommand(parsed.values);
    }
    if (parsed.command === "report") {
      assertKnownOptions(parsed.values, ["repo", "run-id"]);
      return await reportCommand(parsed.values);
    }
    printHelp();
    return parsed.command === "help" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`ForgeMind error: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function auditExportCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const workspace = await inspectGitWorkspace(required(values, "repo"));
  const formatValue = values.get("format") ?? "json";
  if (formatValue !== "json" && formatValue !== "csv") {
    throw new Error("--format must be json or csv");
  }
  const status = values.get("status");
  if (
    status !== undefined &&
    status !== "SUCCEEDED" &&
    status !== "FAILED" &&
    status !== "BLOCKED"
  ) {
    throw new Error("--status must be SUCCEEDED, FAILED, or BLOCKED");
  }
  const actor = await requiredActor(values);
  const authorizedRepo = values.get("filter-repo") ?? workspace.root;
  if (!authorize(actor, { repo: authorizedRepo }, "view")) {
    throw new Error(`Actor ${actor.id} is not authorized to view ${authorizedRepo}`);
  }
  const result = await queryAuditEvents(
    [
      path.join(workspace.commonGitDirectory, "forgemind", "runs"),
      path.join(workspace.commonGitDirectory, "forgemind", "dag-runs"),
    ],
    {
      from: required(values, "from"),
      to: required(values, "to"),
      ...optionalValue(values, "filter-actor", "actor"),
      ...optionalValue(values, "filter-repo", "repo"),
      ...(status === undefined ? {} : { status }),
    },
  );
  const name = values.get("name") ?? `audit-${createRunId()}`;
  const filePath = await exportAuditResult(result, {
    directory: path.join(workspace.commonGitDirectory, "forgemind", "audit"),
    name,
    format: formatValue,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        path: filePath,
        format: formatValue,
        records: result.records.length,
        scannedFiles: result.scannedFiles,
        scannedEvents: result.scannedEvents,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function dagRunCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const repositories = required(values, "repos")
    .split(",")
    .map((repository) => repository.trim())
    .filter(Boolean);
  if (repositories.length === 0) throw new Error("--repos must contain at least one path");
  const requirement = required(values, "requirement");
  const maxRework = optionalNonNegativeInteger(values, "max-rework");
  const maxTasks = optionalPositiveInteger(values, "max-tasks");
  const maxConcurrency = optionalPositiveInteger(values, "max-concurrency");
  const skipGitHooks = parseBooleanOption(values, "skip-git-hooks", false);
  const approveAll = parseBooleanOption(values, "yes", false);
  const noApprove = parseBooleanOption(values, "no-approve", false);
  const memory = parseBooleanOption(values, "memory", false);
  const actor = await optionalActor(values);
  if (approveAll && noApprove) throw new Error("--yes and --no-approve cannot be combined");
  const { model, provider } = llmFrom(values);
  const execution = await runDagForgeMind({
    repositories,
    requirement,
    provider,
    model,
    ...optionalValue(values, "run-id", "parentRunId"),
    ...optionalValue(values, "test-command", "testCommand"),
    ...optionalValue(values, "config", "configPath"),
    ...optionalValue(values, "worktrees-root", "worktreesRoot"),
    ...(maxRework === undefined ? {} : { maxRework }),
    ...(maxTasks === undefined ? {} : { maxTasks }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    skipGitHooks,
    approveAll,
    noApprove,
    memory,
    ...(actor === undefined ? {} : { actor }),
    ...optionalValue(values, "team", "team"),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        parentRunId: execution.result.parentRunId,
        status: execution.result.status,
        summary: execution.plan.summary,
        tasks: execution.result.tasks,
        prList: execution.result.prList,
        prListArtifact: execution.prListPath,
        workspaces: execution.workspaces,
        eventLog: execution.eventLogPath,
      },
      null,
      2,
    )}\n`,
  );
  return execution.result.status === "SUCCEEDED" ? 0 : 1;
}

async function reportCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const workspace = await inspectGitWorkspace(required(values, "repo"));
  const runId = required(values, "run-id");
  const report = await generateReport({ gitDirectory: workspace.commonGitDirectory, runId });
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: report.viewModel.runId,
        status: report.viewModel.status,
        report: report.path,
        eventCount: report.viewModel.totalEvents,
        workflowSignature: report.viewModel.workflowSignature,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
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
  const approveAll = parseBooleanOption(values, "yes", false);
  const noApprove = parseBooleanOption(values, "no-approve", false);
  const memory = parseBooleanOption(values, "memory", false);
  const actor = await optionalActor(values);
  if (approveAll && noApprove) throw new Error("--yes and --no-approve cannot be combined");
  const { model, provider } = llmFrom(values);
  const runId = values.get("run-id");
  const testCommand = values.get("test-command");
  const configPath = values.get("config");
  const execution = await runForgeMind({
    repoPath,
    requirement,
    provider,
    model,
    ...(runId === undefined ? {} : { runId }),
    ...(testCommand === undefined ? {} : { testCommand }),
    ...(maxRework === undefined ? {} : { maxRework }),
    skipGitHooks,
    approveAll,
    noApprove,
    memory,
    ...(actor === undefined ? {} : { actor }),
    ...optionalValue(values, "team", "team"),
    ...(configPath === undefined ? {} : { configPath }),
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
    path.join(workspace.commonGitDirectory, "forgemind", "runs"),
    runId,
  );
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
  const rootCommand = argv[0] ?? "help";
  const nestedCommand = rootCommand === "dag" || rootCommand === "audit" ? argv[1] : undefined;
  const command = nestedCommand === undefined ? rootCommand : `${rootCommand} ${nestedCommand}`;
  const firstOptionIndex = nestedCommand === undefined ? 1 : 2;
  const values = new Map<string, string>();
  const booleanOptions = new Set(["skip-git-hooks", "yes", "no-approve", "memory"]);
  for (let index = firstOptionIndex; index < argv.length;) {
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

function llmFrom(values: ReadonlyMap<string, string>): {
  readonly model: string;
  readonly provider: OpenAICompatibleChatProvider;
} {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required");
  }
  return {
    model: values.get("model") ?? process.env["FORGEMIND_MODEL"] ?? "gpt-4.1-mini",
    provider: new OpenAICompatibleChatProvider({
      apiKey,
      baseUrl:
        values.get("base-url") ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
    }),
  };
}

function optionalNonNegativeInteger(
  values: ReadonlyMap<string, string>,
  key: string,
): number | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }
  return parsed;
}

function optionalPositiveInteger(
  values: ReadonlyMap<string, string>,
  key: string,
): number | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return parsed;
}

function optionalValue<K extends string>(
  values: ReadonlyMap<string, string>,
  source: string,
  target: K,
): { readonly [P in K]?: string } {
  const value = values.get(source);
  return value === undefined ? {} : ({ [target]: value } as { readonly [P in K]: string });
}

async function optionalActor(values: ReadonlyMap<string, string>): Promise<Actor | undefined> {
  const policyPath = values.get("actor-policy");
  const actorId = values.get("actor");
  if (policyPath === undefined && actorId === undefined) return undefined;
  if (policyPath === undefined || actorId === undefined) {
    throw new Error("--actor-policy and --actor must be provided together");
  }
  const actor = actorById(await loadActorPolicy(policyPath), actorId);
  if (actor === undefined) throw new Error(`Unknown actor: ${actorId}`);
  return actor;
}

async function requiredActor(values: ReadonlyMap<string, string>): Promise<Actor> {
  const actor = await optionalActor(values);
  if (actor === undefined) throw new Error("--actor-policy and --actor are required");
  return actor;
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
    `ForgeMind\n\nUsage:\n  forge-mind run --repo <path> --requirement <text> [--model <name>] [--test-command <command>] [--max-rework <n>] [--config <path>] [--yes | --no-approve] [--actor-policy <path> --actor <id>] [--memory] [--skip-git-hooks]\n  forge-mind dag run --repos <a,b,c> --requirement <text> [--max-concurrency <n>] [--worktrees-root <path>] [--yes | --no-approve] [--actor-policy <path> --actor <id>]\n  forge-mind replay --repo <path> --run-id <id>\n  forge-mind report --repo <path> --run-id <id>\n  forge-mind audit export --repo <path> --from <ISO> --to <ISO> --actor-policy <path> --actor <id> [--filter-actor <id>] [--filter-repo <path>] [--status <status>] [--format json|csv]\n\nEnvironment:\n  OPENAI_API_KEY                 Required for run\n  OPENAI_BASE_URL                OpenAI-compatible API base URL\n  FORGEMIND_MODEL                Default model name\n  FORGEMIND_STRUCTURED_OUTPUT    Set 0 to disable native structured output\n  FORGEMIND_GLOBAL_CONFIG        Global policy config path\n  FORGEMIND_POLICY_JSON          Environment policy override\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
