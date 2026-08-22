import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ChatProvider } from "../llm/chat-provider.js";
import { runDagForgeMind, type DagRunExecution, type DagRunOptions } from "../dag/run.js";
import { runForgeMind, type RunExecution, type RunOptions } from "../runtime/run.js";
import { agenticRunGovernance } from "./guardrail.js";
import type { AgenticConfig, AgenticRunRequest } from "./types.js";
import type { AgenticDispatchReceipt, AgenticRunDispatcher } from "./watch.js";
import type { AgenticFeedbackPublisher } from "./feedback.js";

export interface AgenticRepositoryTarget {
  readonly repository: string;
  readonly path: string;
  readonly baseBranch: string;
}

export interface AgenticPullRequestCandidate {
  readonly repository: string;
  readonly localPath: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface AgenticExecutionReceipt extends AgenticDispatchReceipt {
  readonly mode: "single" | "dag";
  readonly status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "PARTIAL";
  readonly summary: string;
  readonly pullRequests: readonly AgenticPullRequestCandidate[];
}

export interface AgenticDispatchRecord {
  readonly version: 1;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly state: "RUNNING" | "FAILED" | "COMPLETED";
  readonly attempt: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly feedbackComplete: boolean;
  readonly receipt?: AgenticExecutionReceipt;
  readonly error?: string;
}

export type AgenticDispatchClaim =
  | { readonly kind: "claimed"; readonly record: AgenticDispatchRecord }
  | { readonly kind: "running" | "completed"; readonly record: AgenticDispatchRecord };

export interface AgenticDispatchStore {
  claim(requestId: string, fingerprint: string, baseRunId: string): Promise<AgenticDispatchClaim>;
  complete(
    requestId: string,
    fingerprint: string,
    receipt: AgenticExecutionReceipt,
    feedbackComplete: boolean,
  ): Promise<AgenticDispatchRecord>;
  fail(requestId: string, fingerprint: string, error: string): Promise<void>;
  markFeedbackComplete(requestId: string, fingerprint: string): Promise<void>;
}

export interface FileAgenticDispatchStoreOptions {
  readonly directory: string;
  readonly now?: () => Date;
}

export class AgenticDispatchInProgressError extends Error {
  public readonly runId: string;

  public constructor(requestId: string, runId: string) {
    super(
      `Agentic request ${requestId} is already RUNNING as ${runId}; reconcile it before retrying`,
    );
    this.name = "AgenticDispatchInProgressError";
    this.runId = runId;
  }
}

export class FileAgenticDispatchStore implements AgenticDispatchStore {
  readonly #directory: string;
  readonly #now: () => Date;

  public constructor(options: FileAgenticDispatchStoreOptions) {
    this.#directory = path.resolve(requiredText(options.directory, "dispatch store directory"));
    this.#now = options.now ?? (() => new Date());
  }

  public async claim(
    requestId: string,
    fingerprint: string,
    baseRunId: string,
  ): Promise<AgenticDispatchClaim> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(requestId);
    const timestamp = this.#now().toISOString();
    const initial: AgenticDispatchRecord = {
      version: 1,
      requestId,
      fingerprint,
      state: "RUNNING",
      attempt: 1,
      runId: baseRunId,
      startedAt: timestamp,
      updatedAt: timestamp,
      feedbackComplete: false,
    };
    try {
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(initial, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { kind: "claimed", record: initial };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    return await this.withLock(filePath, async () => {
      const current = await readDispatchRecord(filePath);
      assertRecordMatches(current, requestId, fingerprint);
      if (current.state === "RUNNING") return { kind: "running", record: current };
      if (current.state === "COMPLETED") return { kind: "completed", record: current };
      const attempt = current.attempt + 1;
      const next: AgenticDispatchRecord = {
        version: 1,
        requestId,
        fingerprint,
        state: "RUNNING",
        attempt,
        runId: `${baseRunId}-${attempt}`,
        startedAt: timestamp,
        updatedAt: timestamp,
        feedbackComplete: false,
      };
      await writeAtomic(filePath, next);
      return { kind: "claimed", record: next };
    });
  }

  public async complete(
    requestId: string,
    fingerprint: string,
    receipt: AgenticExecutionReceipt,
    feedbackComplete: boolean,
  ): Promise<AgenticDispatchRecord> {
    const filePath = this.filePath(requestId);
    return await this.withLock(filePath, async () => {
      const current = await readDispatchRecord(filePath);
      assertRecordMatches(current, requestId, fingerprint);
      if (current.state !== "RUNNING" || current.runId !== receipt.runId) {
        throw new Error(
          `Cannot complete agentic dispatch ${requestId} from state ${current.state}`,
        );
      }
      const completed: AgenticDispatchRecord = {
        ...current,
        state: "COMPLETED",
        updatedAt: this.#now().toISOString(),
        feedbackComplete,
        receipt,
      };
      await writeAtomic(filePath, completed);
      return completed;
    });
  }

  public async fail(requestId: string, fingerprint: string, error: string): Promise<void> {
    const filePath = this.filePath(requestId);
    await this.withLock(filePath, async () => {
      const current = await readDispatchRecord(filePath);
      assertRecordMatches(current, requestId, fingerprint);
      if (current.state !== "RUNNING") return;
      await writeAtomic(filePath, {
        ...current,
        state: "FAILED",
        updatedAt: this.#now().toISOString(),
        error: boundedText(error, 4_000),
      });
    });
  }

  public async markFeedbackComplete(requestId: string, fingerprint: string): Promise<void> {
    const filePath = this.filePath(requestId);
    await this.withLock(filePath, async () => {
      const current = await readDispatchRecord(filePath);
      assertRecordMatches(current, requestId, fingerprint);
      if (current.state !== "COMPLETED" || current.receipt === undefined) {
        throw new Error(`Cannot complete feedback for unfinished dispatch ${requestId}`);
      }
      if (current.feedbackComplete) return;
      await writeAtomic(filePath, {
        ...current,
        updatedAt: this.#now().toISOString(),
        feedbackComplete: true,
      });
    });
  }

  private filePath(requestId: string): string {
    return path.join(
      this.#directory,
      `${createHash("sha256").update(requestId).digest("hex")}.json`,
    );
  }

  private async withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = `${filePath}.lock`;
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw new Error(`Agentic dispatch record is busy: ${path.basename(filePath)}`, {
          cause: error,
        });
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

type SingleRunDefaults = Omit<
  RunOptions,
  | "repoPath"
  | "requirement"
  | "provider"
  | "model"
  | "runId"
  | "actor"
  | "approvalRisk"
  | "authorizationRepo"
  | "toolAllowlist"
  | "commandAllowlist"
  | "riskTransform"
>;

type DagRunDefaults = Omit<
  DagRunOptions,
  | "repositories"
  | "requirement"
  | "provider"
  | "model"
  | "parentRunId"
  | "actor"
  | "approvalRisk"
  | "authorizationRepositories"
  | "toolAllowlist"
  | "commandAllowlist"
  | "riskTransform"
>;

export interface ForgeMindAgenticRunDispatcherOptions {
  readonly config: AgenticConfig;
  readonly provider: ChatProvider;
  readonly model: string;
  readonly store: AgenticDispatchStore;
  readonly resolveRepositories: (
    request: AgenticRunRequest,
  ) => Promise<readonly AgenticRepositoryTarget[]> | readonly AgenticRepositoryTarget[];
  readonly feedback?: AgenticFeedbackPublisher;
  readonly singleRunDefaults?: SingleRunDefaults;
  readonly dagRunDefaults?: DagRunDefaults;
  readonly run?: (options: RunOptions) => Promise<RunExecution>;
  readonly runDag?: (options: DagRunOptions) => Promise<DagRunExecution>;
}

export class ForgeMindAgenticRunDispatcher implements AgenticRunDispatcher {
  readonly #options: ForgeMindAgenticRunDispatcherOptions;
  readonly #inFlight = new Map<string, Promise<AgenticExecutionReceipt>>();

  public constructor(options: ForgeMindAgenticRunDispatcherOptions) {
    if (options.model.trim().length === 0) throw new Error("Agentic model cannot be empty");
    this.#options = options;
  }

  public async dispatch(request: AgenticRunRequest): Promise<AgenticExecutionReceipt> {
    const existing = this.#inFlight.get(request.id);
    if (existing !== undefined) return await existing;
    const operation = this.dispatchImmediately(request);
    this.#inFlight.set(request.id, operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(request.id);
    }
  }

  private async dispatchImmediately(request: AgenticRunRequest): Promise<AgenticExecutionReceipt> {
    const fingerprint = requestFingerprint(request);
    const claim = await this.#options.store.claim(request.id, fingerprint, baseRunId(request.id));
    if (claim.kind === "running") {
      throw new AgenticDispatchInProgressError(request.id, claim.record.runId);
    }
    if (claim.kind === "completed") {
      const receipt = claim.record.receipt;
      if (receipt === undefined) throw new Error(`Completed dispatch ${request.id} has no receipt`);
      if (!claim.record.feedbackComplete) await this.publishFeedback(request, fingerprint, receipt);
      return receipt;
    }
    let receipt: AgenticExecutionReceipt;
    try {
      receipt = await this.execute(request, claim.record.runId);
    } catch (error) {
      await this.#options.store.fail(request.id, fingerprint, errorMessage(error));
      throw error;
    }
    await this.#options.store.complete(
      request.id,
      fingerprint,
      receipt,
      this.#options.feedback === undefined,
    );
    if (this.#options.feedback !== undefined)
      await this.publishFeedback(request, fingerprint, receipt);
    return receipt;
  }

  private async execute(
    request: AgenticRunRequest,
    runId: string,
  ): Promise<AgenticExecutionReceipt> {
    const targets = [...(await this.#options.resolveRepositories(request))];
    validateTargets(targets, this.#options.config);
    const governance = agenticRunGovernance(
      this.#options.config,
      targets[0]?.repository ?? failNoTargets(),
    );
    if (targets.length === 1) {
      const target = targets[0] ?? failNoTargets();
      const execution = await (this.#options.run ?? runForgeMind)({
        ...this.#options.singleRunDefaults,
        repoPath: target.path,
        requirement: request.requirement,
        provider: this.#options.provider,
        model: this.#options.model,
        runId,
        actor: governance.actor,
        approvalRisk: governance.approvalRisk,
        authorizationRepo: target.repository,
        toolAllowlist: governance.toolAllowlist,
        commandAllowlist: governance.commandAllowlist,
        riskTransform: governance.riskTransform,
      });
      return singleReceipt(request, target, runId, execution);
    }
    const execution = await (this.#options.runDag ?? runDagForgeMind)({
      ...this.#options.dagRunDefaults,
      repositories: targets.map((target) => target.path),
      authorizationRepositories: targets.map((target) => target.repository),
      requirement: request.requirement,
      provider: this.#options.provider,
      model: this.#options.model,
      parentRunId: runId,
      actor: governance.actor,
      approvalRisk: governance.approvalRisk,
      toolAllowlist: governance.toolAllowlist,
      commandAllowlist: governance.commandAllowlist,
      riskTransform: governance.riskTransform,
    });
    return dagReceipt(request, targets, runId, execution);
  }

  private async publishFeedback(
    request: AgenticRunRequest,
    fingerprint: string,
    receipt: AgenticExecutionReceipt,
  ): Promise<void> {
    const feedback = this.#options.feedback;
    if (feedback === undefined) return;
    await feedback.publish(request, receipt);
    await this.#options.store.markFeedbackComplete(request.id, fingerprint);
  }
}

function singleReceipt(
  request: AgenticRunRequest,
  target: AgenticRepositoryTarget,
  runId: string,
  execution: RunExecution,
): AgenticExecutionReceipt {
  const pullRequests =
    execution.result.status === "SUCCEEDED"
      ? [
          pullRequestCandidate(
            request,
            target,
            execution.result.context.repo.path,
            execution.result.context.repo.branch,
            execution.result.summary,
          ),
        ]
      : [];
  return {
    runId,
    mode: "single",
    status: execution.result.status,
    summary: execution.result.summary,
    pullRequests,
  };
}

function dagReceipt(
  request: AgenticRunRequest,
  targets: readonly AgenticRepositoryTarget[],
  runId: string,
  execution: DagRunExecution,
): AgenticExecutionReceipt {
  const workspaces = new Map(
    execution.workspaces.map((workspace) => [workspace.taskId, workspace]),
  );
  const pullRequests = execution.result.prList.map((candidate) => {
    const target = targets.find(
      (entry) => path.resolve(entry.path) === path.resolve(candidate.repo),
    );
    if (target === undefined)
      throw new Error(`DAG PR candidate targets unknown repo ${candidate.repo}`);
    const workspace = workspaces.get(candidate.taskId);
    if (workspace === undefined)
      throw new Error(`DAG PR candidate has no workspace ${candidate.taskId}`);
    return pullRequestCandidate(
      request,
      target,
      workspace.root,
      candidate.branch,
      candidate.summary,
    );
  });
  return {
    runId,
    mode: "dag",
    status: execution.result.status,
    summary: execution.plan.summary,
    pullRequests,
  };
}

function pullRequestCandidate(
  request: AgenticRunRequest,
  target: AgenticRepositoryTarget,
  localPath: string,
  head: string,
  summary: string,
): AgenticPullRequestCandidate {
  if (head === "test") throw new Error("The test branch cannot be used as a PR source");
  return {
    repository: target.repository,
    localPath,
    head,
    base: target.baseBranch,
    title: boundedText(`[ForgeMind] ${request.origin.object.title ?? request.requirement}`, 240),
    body: [
      `Agentic run: ${baseRunId(request.id)}`,
      `Source: ${request.origin.source} ${request.origin.object.kind} ${request.origin.object.id}`,
      "",
      summary,
      "",
      "This pull request was created by ForgeMind. No branch was merged automatically.",
    ].join("\n"),
  };
}

function validateTargets(targets: readonly AgenticRepositoryTarget[], config: AgenticConfig): void {
  if (targets.length === 0) failNoTargets();
  const repositories = new Set<string>();
  for (const target of targets) {
    const repository = requiredText(target.repository, "target repository");
    requiredText(target.path, "target path");
    requiredText(target.baseBranch, "target base branch");
    if (!config.repositories.includes(repository)) {
      throw new Error(`Repository ${repository} is not authorized for agentic runs`);
    }
    if (repositories.has(repository)) throw new Error(`Duplicate agentic target ${repository}`);
    repositories.add(repository);
  }
}

function requestFingerprint(request: AgenticRunRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function baseRunId(requestId: string): string {
  return `agentic-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readDispatchRecord(filePath: string): Promise<AgenticDispatchRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot read agentic dispatch record ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return parseDispatchRecord(parsed);
}

function parseDispatchRecord(value: unknown): AgenticDispatchRecord {
  const input = objectValue(value, "agentic dispatch record");
  if (input["version"] !== 1) throw new Error("Unsupported agentic dispatch record version");
  const state = enumeration(input["state"], ["RUNNING", "FAILED", "COMPLETED"], "state");
  const attempt = input["attempt"];
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Agentic dispatch attempt must be a positive safe integer");
  }
  const feedbackComplete = input["feedbackComplete"];
  if (typeof feedbackComplete !== "boolean") throw new Error("Invalid feedbackComplete value");
  const receipt = input["receipt"] === undefined ? undefined : parseReceipt(input["receipt"]);
  const error = optionalText(input["error"]);
  if (state === "COMPLETED" && receipt === undefined) {
    throw new Error("Completed agentic dispatch record has no receipt");
  }
  return {
    version: 1,
    requestId: requiredText(input["requestId"], "requestId"),
    fingerprint: requiredText(input["fingerprint"], "fingerprint"),
    state,
    attempt,
    runId: requiredText(input["runId"], "runId"),
    startedAt: timestamp(input["startedAt"], "startedAt"),
    updatedAt: timestamp(input["updatedAt"], "updatedAt"),
    feedbackComplete,
    ...(receipt === undefined ? {} : { receipt }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseReceipt(value: unknown): AgenticExecutionReceipt {
  const input = objectValue(value, "agentic dispatch receipt");
  const pullRequests = input["pullRequests"];
  if (!Array.isArray(pullRequests)) throw new Error("Receipt pullRequests must be an array");
  return {
    runId: requiredText(input["runId"], "receipt.runId"),
    mode: enumeration(input["mode"], ["single", "dag"], "receipt.mode"),
    status: enumeration(
      input["status"],
      ["SUCCEEDED", "FAILED", "BLOCKED", "PARTIAL"],
      "receipt.status",
    ),
    summary: requiredText(input["summary"], "receipt.summary"),
    pullRequests: pullRequests.map((entry) => {
      const candidate = objectValue(entry, "pull request candidate");
      return {
        repository: requiredText(candidate["repository"], "candidate.repository"),
        localPath: requiredText(candidate["localPath"], "candidate.localPath"),
        head: requiredText(candidate["head"], "candidate.head"),
        base: requiredText(candidate["base"], "candidate.base"),
        title: requiredText(candidate["title"], "candidate.title"),
        body: requiredText(candidate["body"], "candidate.body"),
      };
    }),
  };
}

async function writeAtomic(filePath: string, value: AgenticDispatchRecord): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

function assertRecordMatches(
  record: AgenticDispatchRecord,
  requestId: string,
  fingerprint: string,
): void {
  if (record.requestId !== requestId || record.fingerprint !== fingerprint) {
    throw new Error(`Agentic dispatch idempotency conflict for ${requestId}`);
  }
}

function objectValue(value: unknown, source: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  source: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${source} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function timestamp(value: unknown, source: string): string {
  const text = requiredText(value, source);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${source} must be a timestamp`);
  return new Date(text).toISOString();
}

function requiredText(value: unknown, source: string): string {
  const text = optionalText(value);
  if (text === undefined) throw new Error(`${source} must be a non-empty string`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function failNoTargets(): never {
  throw new Error("Agentic dispatch requires at least one repository target");
}
