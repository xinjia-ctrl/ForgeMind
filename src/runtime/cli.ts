#!/usr/bin/env node
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { EventLog } from "../core/event-log.js";
import { replay } from "../core/replay.js";
import { workflowSignature } from "../core/reproducibility.js";
import { OpenAICompatibleChatProvider } from "../llm/openai-compatible-provider.js";
import {
  configuredProviderId,
  inferProviderId,
  isProviderId,
  providerDefinition,
  resolveProviderApiKey,
} from "../llm/provider-catalog.js";
import { generateReport } from "../report/report.js";
import { inspectGitWorkspace } from "./git-workspace.js";
import { runForgeMind } from "./run.js";
import { startWebApp } from "../web/server.js";

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
        "provider",
        "base-url",
        "temperature",
        "run-id",
        "resume",
        "test-command",
        "max-rework",
        "skip-git-hooks",
        "config",
        "yes",
        "no-approve",
      ]);
      return await runCommand(parsed.values);
    }
    if (parsed.command === "web") {
      assertKnownOptions(parsed.values, ["port", "config"]);
      return await webCommand(parsed.values);
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

async function webCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const port = optionalPort(values, "port");
  const app = await startWebApp({
    ...(port === undefined ? {} : { port }),
    ...optionalValue(values, "config", "configPath"),
  });
  process.stdout.write(`ForgeMind Web is ready: ${app.url}\n`);
  return 0;
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
  const runId = values.get("run-id");
  const resume = parseBooleanOption(values, "resume", false);
  if (resume && runId === undefined) throw new Error("--resume requires --run-id");
  if (approveAll && noApprove) throw new Error("--yes and --no-approve cannot be combined");
  const { model, provider } = llmFrom(values);
  const testCommand = values.get("test-command");
  const configPath = values.get("config");
  const cancellation = processCancellation();
  const execution = await runForgeMind({
    repoPath,
    requirement,
    provider,
    model,
    signal: cancellation.signal,
    resume,
    ...(runId === undefined ? {} : { runId }),
    ...(testCommand === undefined ? {} : { testCommand }),
    ...(maxRework === undefined ? {} : { maxRework }),
    skipGitHooks,
    approveAll,
    noApprove,
    ...(configPath === undefined ? {} : { configPath }),
  }).finally(cancellation.dispose);
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
  const command = rootCommand;
  const firstOptionIndex = 1;
  const values = new Map<string, string>();
  const booleanOptions = new Set(["skip-git-hooks", "yes", "no-approve", "resume"]);
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
  const requestedProvider = values.get("provider");
  if (requestedProvider !== undefined && !isProviderId(requestedProvider)) {
    throw new Error(`Unknown provider: ${requestedProvider}`);
  }
  const commandBaseUrl = values.get("base-url");
  const configuredProvider = configuredProviderId(process.env);
  const providerId =
    requestedProvider ??
    (commandBaseUrl === undefined ? configuredProvider : inferProviderId(commandBaseUrl));
  const definition = providerDefinition(providerId);
  const apiKey = resolveProviderApiKey(providerId, process.env);
  if (apiKey === undefined) {
    throw new Error(
      `A credential for ${definition.label} is required (${definition.apiKeyEnvironments.join(" or ")})`,
    );
  }
  const baseUrl =
    commandBaseUrl ??
    (providerId === "custom" ? process.env["OPENAI_BASE_URL"] : definition.baseUrl);
  if (baseUrl === undefined || baseUrl.trim().length === 0) {
    throw new Error("A base URL is required for the custom provider");
  }
  return {
    model:
      values.get("model") ??
      (providerId === configuredProvider ? process.env["FORGEMIND_MODEL"] : undefined) ??
      definition.defaultModel,
    provider: new OpenAICompatibleChatProvider({
      apiKey,
      baseUrl,
      structuredOutput: process.env["FORGEMIND_STRUCTURED_OUTPUT"] !== "0",
      ...temperatureOverride(values),
    }),
  };
}

function temperatureOverride(values: ReadonlyMap<string, string>): {
  readonly temperatureOverride?: number;
} {
  const value = values.get("temperature") ?? process.env["FORGEMIND_TEMPERATURE"];
  if (value === undefined || value.trim().length === 0) return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new Error("--temperature/FORGEMIND_TEMPERATURE must be between 0 and 2");
  }
  return { temperatureOverride: parsed };
}

function optionalPort(values: ReadonlyMap<string, string>, key: string): number | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`--${key} must be an integer between 1 and 65535`);
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

function processCancellation(): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

function printHelp(): void {
  process.stdout.write(
    `ForgeMind\n\nUsage:\n  forge-mind web [--port <number>] [--config <path>]\n  forge-mind run --repo <path> --requirement <text> [--run-id <id> --resume] [--provider <id>] [--model <name>] [--temperature <0-2>] [--test-command <command>] [--max-rework <n>] [--config <path>] [--yes | --no-approve] [--skip-git-hooks]\n  forge-mind replay --repo <path> --run-id <id>\n  forge-mind report --repo <path> --run-id <id>\n\nEnvironment:\n  FORGEMIND_PROVIDER             Default provider (defaults to deepseek)\n  FORGEMIND_MODEL                Default model name (provider default if omitted)\n  OPENAI_API_KEY                 OpenAI/custom provider credential\n  DEEPSEEK_API_KEY               DeepSeek provider credential\n  BIGMODEL_API_KEY               BigModel provider credential\n  DASHSCOPE_API_KEY              DashScope provider credential\n  MOONSHOT_API_KEY               Moonshot provider credential\n  OPENAI_BASE_URL                Custom or legacy OpenAI-compatible API base URL\n  FORGEMIND_TEMPERATURE          Optional provider compatibility override (0-2)\n  FORGEMIND_STRUCTURED_OUTPUT    Set 0 to disable native structured output\n  FORGEMIND_GLOBAL_CONFIG        Global policy config path\n  FORGEMIND_POLICY_JSON          Environment policy override\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
