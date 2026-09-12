import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { EventLog } from "../core/event-log.js";
import type { ForgeMindEvent } from "../core/events.js";
import { DEFAULT_MAX_REWORK } from "../core/orchestrator.js";
import type { StageId } from "../core/types.js";
import { OpenAICompatibleChatProvider } from "../llm/openai-compatible-provider.js";
import {
  configuredProviderId,
  isProviderId,
  PROVIDER_CATALOG,
  providerDefinition,
  resolveProviderApiKey,
  resolveProviderCredential,
} from "../llm/provider-catalog.js";
import { generateReport } from "../report/report.js";
import {
  assertGitWorkspaceClean,
  assertGitWorkspaceHasCommit,
  inspectGitWorkspace,
  type GitWorkspace,
} from "../runtime/git-workspace.js";
import { createRunId, runForgeMind } from "../runtime/run.js";
import { runProcess } from "../tools/process.js";
import type {
  DirectoryListing,
  RepositoryInspection,
  WebRunProgress,
  WebRunRequest,
  WebRunResult,
  WebRunView,
  WebUiDefaults,
} from "./types.js";
import { WEB_UI_HTML } from "./ui.js";

const DEFAULT_PORT = 3210;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_JOBS = 100;
const MAX_WEB_REWORK = 12;
const STAGE_ORDER: readonly StageId[] = ["PLAN", "ARCH", "CODE", "TEST", "REVIEW", "COMMIT"];

interface WebRunJob {
  readonly id: string;
  readonly repoPath: string;
  readonly requirement: string;
  readonly startedAt: string;
  readonly commonGitDirectory: string;
  status: WebRunView["status"];
  finishedAt?: string;
  summary?: string;
  branch?: string;
  eventLogPath?: string;
  reportPath?: string;
}

export interface WebRunExecutorOptions {
  readonly request: WebRunRequest;
  readonly runId: string;
  readonly workspace: Omit<GitWorkspace, "branch">;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export type WebRunExecutor = (options: WebRunExecutorOptions) => Promise<WebRunResult>;

export interface WebAppOptions {
  readonly homeDirectory?: string;
  readonly configPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly execute?: WebRunExecutor;
}

export interface StartedWebApp {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export function createWebApp(options: WebAppOptions = {}): Server {
  const environment = options.environment ?? process.env;
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const configuredPolicyPath = path.resolve(
    options.configPath ?? path.join(process.cwd(), "forgemind-local.config.json"),
  );
  const execute = options.execute ?? executeWebRun;
  const jobs = new Map<string, WebRunJob>();

  return createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      respondJson(response, status, { error: errorMessage(error) });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      respondHtml(response, WEB_UI_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      respondEmpty(response, 204);
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      respondJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      const providerId = configuredProviderId(environment);
      const provider = providerDefinition(providerId);
      const configuredBaseUrl = nonEmpty(environment["OPENAI_BASE_URL"]);
      const defaults: WebUiDefaults = {
        providerId,
        baseUrl:
          providerId === "custom" && configuredBaseUrl !== undefined
            ? configuredBaseUrl
            : provider.baseUrl,
        model: environment["FORGEMIND_MODEL"] ?? provider.defaultModel,
        temperature: optionalTemperature(environment["FORGEMIND_TEMPERATURE"]),
        maxRework: configuredMaxRework(environment["FORGEMIND_MAX_REWORK"]),
        structuredOutput: environment["FORGEMIND_STRUCTURED_OUTPUT"] !== "0",
        providers: PROVIDER_CATALOG.map((candidate) => {
          const credential = resolveProviderCredential(candidate.id, environment);
          return {
            id: candidate.id,
            label: candidate.label,
            baseUrl: candidate.baseUrl,
            apiKeyEnvironment:
              credential?.environment ?? candidate.apiKeyEnvironments[0] ?? "OPENAI_API_KEY",
            apiKeyConfigured: credential !== undefined,
            defaultModel: candidate.defaultModel,
            models: candidate.models,
            compatibility: candidate.compatibility,
          };
        }),
        configPath: (await exists(configuredPolicyPath)) ? configuredPolicyPath : null,
        homeDirectory,
      };
      respondJson(response, 200, defaults);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/directories") {
      const listing = await listDirectories(homeDirectory, url.searchParams.get("path"));
      respondJson(response, 200, listing);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/repositories/inspect") {
      const body = objectValue(await readJson(request), "Repository request must be a JSON object");
      const requestedPath = requiredStringField(body, "path", 4_096);
      const inspection = await inspectRepository(requestedPath);
      respondJson(response, 200, inspection);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/demo-repository") {
      await readJson(request);
      const demoPath = await createDemoRepository(homeDirectory);
      respondJson(response, 201, { path: demoPath });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      if ([...jobs.values()].some((job) => job.status === "RUNNING")) {
        throw new HttpError(409, "已有任务正在运行，请等待它结束后再启动新任务");
      }
      const body = await readJson(request);
      const parsed = parseWebRunRequest(
        body,
        environment,
        (await exists(configuredPolicyPath)) ? configuredPolicyPath : undefined,
      );
      const workspace = await inspectCleanWorkspace(parsed.repoPath);
      const runId = createRunId();
      const job: WebRunJob = {
        id: runId,
        repoPath: workspace.root,
        requirement: parsed.requirement,
        startedAt: new Date().toISOString(),
        commonGitDirectory: workspace.commonGitDirectory,
        status: "RUNNING",
      };
      rememberJob(jobs, job);
      void execute({ request: parsed, runId, workspace, environment })
        .then((result) => finishJob(job, result))
        .catch((error: unknown) => failJob(job, error));
      respondJson(response, 202, await jobView(job));
      return;
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && runMatch !== null) {
      const job = jobs.get(decodeURIComponent(runMatch[1] ?? ""));
      if (job === undefined) throw new HttpError(404, "找不到这个运行任务");
      respondJson(response, 200, await jobView(job));
      return;
    }
    const reportMatch = /^\/api\/runs\/([^/]+)\/report$/.exec(url.pathname);
    if (request.method === "GET" && reportMatch !== null) {
      const job = jobs.get(decodeURIComponent(reportMatch[1] ?? ""));
      if (job?.reportPath === undefined) throw new HttpError(404, "当前任务还没有可查看的报告");
      respondReport(response, await readFile(job.reportPath, "utf8"));
      return;
    }
    throw new HttpError(404, "页面或接口不存在");
  }

  async function jobView(job: WebRunJob): Promise<WebRunView> {
    const progress = await loadProgress(job.commonGitDirectory, job.id);
    return {
      id: job.id,
      status: job.status,
      repoPath: job.repoPath,
      requirement: job.requirement,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.summary === undefined ? {} : { summary: job.summary }),
      ...(job.branch === undefined ? {} : { branch: job.branch }),
      ...(job.eventLogPath === undefined ? {} : { eventLogPath: job.eventLogPath }),
      ...progress,
      reportAvailable: job.reportPath !== undefined,
    };
  }
}

export async function startWebApp(
  options: WebAppOptions & { readonly port?: number } = {},
): Promise<StartedWebApp> {
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Web port must be an integer between 0 and 65535");
  }
  const server = createWebApp(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Cannot determine ForgeMind web address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

export function parseWebRunRequest(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  defaultConfigPath?: string,
): WebRunRequest {
  const record = objectValue(value, "Run request must be a JSON object");
  assertOnlyKeys(record, [
    "repoPath",
    "requirement",
    "providerId",
    "baseUrl",
    "model",
    "temperature",
    "maxRework",
    "structuredOutput",
    "configPath",
    "approveAll",
  ]);
  const providerIdValue = requiredStringField(record, "providerId", 64);
  if (!isProviderId(providerIdValue)) throw new HttpError(400, "模型供应商不受支持");
  const provider = providerDefinition(providerIdValue);
  const requestedBaseUrl = optionalStringField(record, "baseUrl", 2_048);
  const baseUrl =
    provider.id === "custom"
      ? validBaseUrl(requiredStringField(record, "baseUrl", 2_048))
      : provider.baseUrl;
  if (
    provider.id !== "custom" &&
    requestedBaseUrl !== undefined &&
    validBaseUrl(requestedBaseUrl) !== provider.baseUrl
  ) {
    throw new HttpError(400, "常用供应商的 API 地址由后台目录固定，请选择“自定义”后再修改地址");
  }
  const apiKey = resolveProviderApiKey(provider.id, environment);
  if (apiKey === undefined) {
    throw new HttpError(
      400,
      `请在 ForgeMind 的 .env 中配置 ${provider.apiKeyEnvironments.join(" 或 ")}，然后重启页面`,
    );
  }
  const temperature = optionalNumberField(record, "temperature", 0, 2);
  const maxRework =
    optionalIntegerField(record, "maxRework", 0, MAX_WEB_REWORK) ?? DEFAULT_MAX_REWORK;
  const explicitConfig = optionalStringField(record, "configPath", 4_096);
  const configPath = explicitConfig ?? defaultConfigPath;
  return {
    repoPath: requiredStringField(record, "repoPath", 4_096),
    requirement: requiredStringField(record, "requirement", 100_000),
    providerId: provider.id,
    apiKey,
    baseUrl,
    model: requiredStringField(record, "model", 256),
    ...(temperature === undefined ? {} : { temperature }),
    maxRework,
    structuredOutput: booleanField(record, "structuredOutput"),
    ...(configPath === undefined ? {} : { configPath }),
    approveAll: booleanField(record, "approveAll"),
  };
}

async function executeWebRun(options: WebRunExecutorOptions): Promise<WebRunResult> {
  const apiKey = options.request.apiKey;
  const provider = new OpenAICompatibleChatProvider({
    apiKey,
    baseUrl: options.request.baseUrl,
    structuredOutput: options.request.structuredOutput,
    ...(options.request.temperature === undefined
      ? {}
      : { temperatureOverride: options.request.temperature }),
  });
  const execution = await runForgeMind({
    repoPath: options.request.repoPath,
    requirement: options.request.requirement,
    provider,
    model: options.request.model,
    runId: options.runId,
    maxRework: options.request.maxRework,
    ...(options.request.configPath === undefined ? {} : { configPath: options.request.configPath }),
    approveAll: options.request.approveAll,
    noApprove: !options.request.approveAll,
  });
  const report = await generateReport({
    gitDirectory: options.workspace.commonGitDirectory,
    runId: options.runId,
  });
  return {
    status: execution.result.status,
    summary: execution.result.summary,
    branch: execution.result.context.repo.branch,
    eventLogPath: execution.eventLogPath,
    reportPath: report.path,
  };
}

async function inspectRepository(requestedPath: string): Promise<RepositoryInspection> {
  const workspace = await inspectCleanWorkspace(requestedPath);
  return { root: workspace.root, branch: workspace.originalBranch, clean: true };
}

async function inspectCleanWorkspace(requestedPath: string): Promise<Omit<GitWorkspace, "branch">> {
  try {
    const workspace = await inspectGitWorkspace(requestedPath);
    await assertGitWorkspaceClean(workspace.root);
    await assertGitWorkspaceHasCommit(workspace.root);
    return workspace;
  } catch (error) {
    throw new HttpError(400, repositoryErrorMessage(error));
  }
}

function repositoryErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("Target repository must be clean")) {
    return "这个项目还有未提交或未保存的修改，请先提交或选择其他项目";
  }
  if (message.includes("is not inside a Git repository")) {
    return "这个文件夹不是 Git 项目；可以返回并点击“创建安全演示项目”";
  }
  if (message.includes("must have at least one commit")) {
    return "这个 Git 项目还没有初始提交；请先创建第一次提交后再运行";
  }
  if (message.includes("Detached HEAD")) {
    return "这个 Git 项目当前没有正常分支，请先切换到 main 或其他开发分支";
  }
  return message;
}

async function listDirectories(
  root: string,
  requestedPath: string | null,
): Promise<DirectoryListing> {
  try {
    const rootPath = await realpath(root);
    const requested = await realpath(path.resolve(requestedPath ?? rootPath));
    assertWithinRoot(rootPath, requested);
    const entries = await readdir(requested, { withFileTypes: true });
    return {
      root: rootPath,
      current: requested,
      parent: requested === rootPath ? null : path.dirname(requested),
      entries: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 500)
        .map((entry) => ({ name: entry.name, path: path.join(requested, entry.name) })),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, errorMessage(error));
  }
}

async function createDemoRepository(homeDirectory: string): Promise<string> {
  const root = await realpath(homeDirectory);
  let target = path.join(root, "ForgeMindDemo");
  for (let index = 2; await exists(target); index += 1) {
    if (index > 99) throw new HttpError(409, "演示项目数量过多，请先整理已有 ForgeMindDemo 文件夹");
    target = path.join(root, `ForgeMindDemo-${index}`);
  }
  await mkdir(path.join(target, "src"), { recursive: true });
  await mkdir(path.join(target, "test"), { recursive: true });
  await writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify(
      {
        name: "forgemind-demo",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(target, "src", "calculator.js"),
    "export function add(left, right) {\n  return left + right;\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(target, "test", "calculator.test.js"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/calculator.js";\n\ntest("adds two numbers", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
    "utf8",
  );
  await writeFile(
    path.join(target, "README.md"),
    "# ForgeMind Demo\n\nA safe local repository for trying ForgeMind.\n",
    "utf8",
  );
  await checkedProcess("git", ["init", "-b", "main"], target);
  await checkedProcess("git", ["add", "--all"], target);
  await checkedProcess(
    "git",
    [
      "-c",
      "user.name=ForgeMind Demo",
      "-c",
      "user.email=demo@forgemind.local",
      "commit",
      "-m",
      "chore: initialize demo project",
    ],
    target,
  );
  return target;
}

async function checkedProcess(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  const result = await runProcess(command, args, { cwd, timeoutMs: 30_000, maxBytes: 32_000 });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
}

async function loadProgress(gitDirectory: string, runId: string): Promise<WebRunProgress> {
  try {
    const events = await EventLog.open(path.join(gitDirectory, "forgemind", "runs"), runId).load();
    return progressFromEvents(events);
  } catch {
    return { completedStages: [] };
  }
}

export function progressFromEvents(events: readonly ForgeMindEvent[]): WebRunProgress {
  const completed = new Set<StageId>();
  let stage: StageId | undefined;
  for (const event of events) {
    if (event.type === "stage.started") stage = event.data.stage;
    if (event.type === "stage.completed") {
      completed.add(event.data.stage);
      if (stage === event.data.stage) stage = undefined;
    }
    if (event.type === "stage.failed") stage = event.data.stage;
    if (event.type === "run.finished") stage = undefined;
  }
  const completedStages = STAGE_ORDER.filter((candidate) => completed.has(candidate));
  return { ...(stage === undefined ? {} : { stage }), completedStages };
}

function finishJob(job: WebRunJob, result: WebRunResult): void {
  job.status = result.status;
  job.finishedAt = new Date().toISOString();
  job.summary = result.summary;
  job.branch = result.branch;
  job.eventLogPath = result.eventLogPath;
  if (result.reportPath !== undefined) job.reportPath = result.reportPath;
}

async function failJob(job: WebRunJob, error: unknown): Promise<void> {
  job.status = "ERROR";
  job.finishedAt = new Date().toISOString();
  job.summary = errorMessage(error);
  try {
    const report = await generateReport({ gitDirectory: job.commonGitDirectory, runId: job.id });
    job.reportPath = report.path;
  } catch {
    // A failure before EventLog creation has no report to recover.
  }
}

function rememberJob(jobs: Map<string, WebRunJob>, job: WebRunJob): void {
  if (jobs.size >= MAX_JOBS) {
    const removable = [...jobs.values()].find((candidate) => candidate.status !== "RUNNING");
    if (removable !== undefined) jobs.delete(removable.id);
  }
  jobs.set(job.id, job);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = requestChunk(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new HttpError(413, "请求内容过大");
    chunks.push(buffer);
  }
  const content = Buffer.concat(chunks).toString("utf8").trim();
  if (content.length === 0) return {};
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new HttpError(400, "请求不是有效 JSON");
  }
}

function requestChunk(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new HttpError(400, "请求内容格式无效");
}

function respondHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
  response.end(html);
}

function respondReport(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function respondEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
  response.end();
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; connect-src 'self'; script-src 'nonce-forgemind-local'; style-src 'nonce-forgemind-local'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, message);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new HttpError(400, `未知配置字段：${unknown}`);
}

function requiredStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maxLength: number,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new HttpError(400, `${key} 不能为空`);
  }
  if (field.length > maxLength) throw new HttpError(400, `${key} 内容过长`);
  return field.trim();
}

function optionalStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maxLength: number,
): string | undefined {
  const field = value[key];
  if (field === undefined || field === "") return undefined;
  if (typeof field !== "string") throw new HttpError(400, `${key} 必须是文本`);
  if (field.length > maxLength) throw new HttpError(400, `${key} 内容过长`);
  return nonEmpty(field);
}

function booleanField(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw new HttpError(400, `${key} 必须是布尔值`);
  return field;
}

function optionalNumberField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isFinite(field) || field < minimum || field > maximum) {
    throw new HttpError(400, `${key} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return field;
}

function optionalIntegerField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const field = optionalNumberField(value, key, minimum, maximum);
  if (field === undefined) return undefined;
  if (!Number.isInteger(field)) {
    throw new HttpError(400, `${key} 必须是整数`);
  }
  return field;
}

function validBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "API 地址不是有效 URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(400, "API 地址只支持 http 或 https");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new HttpError(400, "API 地址不能包含用户名或密码");
  }
  return value.replace(/\/$/, "");
}

function optionalTemperature(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : null;
}

function configuredMaxRework(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_MAX_REWORK;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_WEB_REWORK
    ? parsed
    : DEFAULT_MAX_REWORK;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

function assertWithinRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HttpError(403, "文件夹浏览范围不能超出当前用户目录");
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
