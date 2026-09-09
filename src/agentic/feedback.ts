import path from "node:path";
import { EventLog } from "../core/event-log.js";
import type { AgenticExecutionReceipt, AgenticPullRequestCandidate } from "./dispatcher.js";
import type { ExternalAction, ExternalActionGovernor } from "./external-action.js";
import type { AgenticRunRequest } from "./types.js";
import type { CiFeedbackClient } from "./ci.js";
import type { GitHubApiClient } from "./github.js";
import type { JiraApiClient } from "./jira.js";
import { runProcess, type ProcessResult } from "../tools/process.js";

export interface AgenticFeedbackPublisher {
  publish(request: AgenticRunRequest, receipt: AgenticExecutionReceipt): Promise<void>;
}

export interface BranchPublisher {
  publish(candidate: AgenticPullRequestCandidate): Promise<void>;
  verify(candidate: AgenticPullRequestCandidate): Promise<boolean>;
}

export interface GitBranchPublisherOptions {
  readonly remote?: string;
  readonly timeoutMs?: number;
  readonly processRunner?: typeof runProcess;
}

export class GitBranchPublisher implements BranchPublisher {
  readonly #remote: string;
  readonly #timeoutMs: number;
  readonly #processRunner: typeof runProcess;

  public constructor(options: GitBranchPublisherOptions = {}) {
    this.#remote = options.remote ?? "origin";
    if (!/^[a-zA-Z0-9._-]+$/.test(this.#remote)) throw new Error("Invalid Git remote name");
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000) {
      throw new Error("Git push timeout must be at least 1000ms");
    }
    this.#processRunner = options.processRunner ?? runProcess;
  }

  public async publish(candidate: AgenticPullRequestCandidate): Promise<void> {
    assertSafeHead(candidate.head);
    const result = await this.#processRunner(
      "git",
      ["push", "--set-upstream", this.#remote, candidate.head],
      { cwd: candidate.localPath, timeoutMs: this.#timeoutMs, maxBytes: 64_000 },
    );
    assertProcessSucceeded(result, candidate);
  }

  public async verify(candidate: AgenticPullRequestCandidate): Promise<boolean> {
    assertSafeHead(candidate.head);
    const [local, remote] = await Promise.all([
      this.#processRunner("git", ["rev-parse", candidate.head], {
        cwd: candidate.localPath,
        timeoutMs: this.#timeoutMs,
        maxBytes: 64_000,
      }),
      this.#processRunner("git", ["ls-remote", "--heads", this.#remote, candidate.head], {
        cwd: candidate.localPath,
        timeoutMs: this.#timeoutMs,
        maxBytes: 64_000,
      }),
    ]);
    if (local.exitCode !== 0 || remote.exitCode !== 0) return false;
    const localCommit = local.stdout.trim();
    const remoteCommit = remote.stdout.trim().split(/\s+/u)[0] ?? "";
    return /^[0-9a-f]{40,64}$/u.test(localCommit) && localCommit === remoteCommit;
  }
}

export interface AgenticFeedbackCoordinatorOptions {
  readonly github?: GitHubApiClient;
  readonly jira?: JiraApiClient;
  readonly ci?: CiFeedbackClient;
  readonly branchPublisher?: BranchPublisher;
  readonly governor?: ExternalActionGovernor;
  readonly eventLog?: EventLog;
}

export class AgenticFeedbackCoordinator implements AgenticFeedbackPublisher {
  readonly #github: GitHubApiClient | undefined;
  readonly #jira: JiraApiClient | undefined;
  readonly #ci: CiFeedbackClient | undefined;
  readonly #branchPublisher: BranchPublisher | undefined;
  readonly #governor: ExternalActionGovernor | undefined;
  readonly #eventLog: EventLog | undefined;

  public constructor(options: AgenticFeedbackCoordinatorOptions) {
    this.#github = options.github;
    this.#jira = options.jira;
    this.#ci = options.ci;
    this.#branchPublisher = options.branchPublisher;
    this.#governor = options.governor;
    this.#eventLog = options.eventLog;
  }

  public async publish(
    request: AgenticRunRequest,
    receipt: AgenticExecutionReceipt,
  ): Promise<void> {
    const pullRequestUrls: string[] = [];
    const eventLog = this.eventLog(receipt);
    for (const candidate of receipt.pullRequests) {
      assertSafeHead(candidate.head);
      if (this.#github === undefined || this.#branchPublisher === undefined) {
        throw new Error("GitHub client and branch publisher are required to create pull requests");
      }
      await this.govern({
        runId: receipt.runId,
        eventLog,
        tool: "external_push",
        args: { repository: candidate.repository, head: candidate.head },
        target: `${candidate.repository}:${candidate.head}`,
        idempotencyKey: `${request.id}:push:${candidate.repository}:${candidate.head}`,
        risk: "high",
        execute: async () => await this.#branchPublisher!.publish(candidate),
        verify: async () => await this.#branchPublisher!.verify(candidate),
      });
      const pullRequestInput = {
        repository: candidate.repository,
        title: candidate.title,
        head: candidate.head,
        base: candidate.base,
        body: candidate.body,
      };
      const pullRequest = await this.govern({
        runId: receipt.runId,
        eventLog,
        tool: "external_pull_request",
        args: pullRequestInput,
        target: `${candidate.repository}:${candidate.head}->${candidate.base}`,
        idempotencyKey: `${request.id}:pr:${candidate.repository}:${candidate.head}:${candidate.base}`,
        risk: "high",
        execute: async () => await this.#github!.createOrGetPullRequest(pullRequestInput),
        verify: async (result) =>
          await this.#github!.verifyPullRequest(pullRequestInput, result.number),
      });
      pullRequestUrls.push(pullRequest.url);
    }
    const body = feedbackBody(receipt, pullRequestUrls);
    const key = `${request.id}:feedback`;
    switch (request.origin.source) {
      case "github":
        await this.publishGitHubComment(request, receipt, eventLog, body, key);
        return;
      case "jira":
        if (this.#jira !== undefined && request.origin.object.kind === "issue") {
          const issue = request.origin.object.id;
          await this.govern({
            runId: receipt.runId,
            eventLog,
            tool: "external_comment",
            args: { source: "jira", issue },
            target: `jira:${issue}`,
            idempotencyKey: key,
            risk: "medium",
            execute: async () => await this.#jira!.commentIssue(issue, body, key),
            verify: async (result) => await this.#jira!.verifyIssueComment(issue, key, result.id),
          });
        }
        return;
      case "ci":
        if (this.#ci !== undefined) {
          const feedback = {
            runId: receipt.runId,
            objectId: request.origin.object.id,
            status: receipt.status,
            summary: receipt.summary,
            idempotencyKey: key,
            pullRequests: pullRequestUrls,
          };
          await this.govern({
            runId: receipt.runId,
            eventLog,
            tool: "external_comment",
            args: { source: "ci", objectId: feedback.objectId },
            target: `ci:${feedback.objectId}`,
            idempotencyKey: key,
            risk: "medium",
            execute: async () => await this.#ci!.comment(feedback),
            verify: () => Promise.resolve(true),
          });
        }
        return;
      case "forgemind":
        return;
    }
  }

  private async publishGitHubComment(
    request: AgenticRunRequest,
    receipt: AgenticExecutionReceipt,
    eventLog: EventLog | undefined,
    body: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (this.#github === undefined) return;
    const object = request.origin.object;
    if (object.kind === "issue" || object.kind === "pull_request") {
      await this.governGitHubComment(request, receipt, eventLog, object.id, body, idempotencyKey);
      return;
    }
    const pullRequestNumber = request.origin.context["pullRequestNumber"];
    if (
      object.kind === "workflow" &&
      typeof pullRequestNumber !== "boolean" &&
      pullRequestNumber !== null
    ) {
      if (typeof pullRequestNumber === "string" || typeof pullRequestNumber === "number") {
        await this.governGitHubComment(
          request,
          receipt,
          eventLog,
          pullRequestNumber,
          body,
          idempotencyKey,
        );
      }
    }
  }

  private async governGitHubComment(
    request: AgenticRunRequest,
    receipt: AgenticExecutionReceipt,
    eventLog: EventLog | undefined,
    issue: string | number,
    body: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.govern({
      runId: receipt.runId,
      eventLog,
      tool: "external_comment",
      args: { source: "github", repository: request.repository, issue },
      target: `github:${request.repository}#${String(issue)}`,
      idempotencyKey,
      risk: "medium",
      execute: async () =>
        await this.#github!.commentIssue(request.repository, issue, body, idempotencyKey),
      verify: async (result) =>
        await this.#github!.verifyIssueComment(
          request.repository,
          issue,
          idempotencyKey,
          result.id,
        ),
    });
  }

  private async govern<T>(action: ExternalAction<T>): Promise<T> {
    if (this.#governor === undefined) {
      throw new Error("An external action governor is required before publishing feedback");
    }
    return await this.#governor.execute(action);
  }

  private eventLog(receipt: AgenticExecutionReceipt): EventLog | undefined {
    if (this.#eventLog !== undefined) return this.#eventLog;
    if (receipt.eventLogPath === undefined) return undefined;
    const extension = path.extname(receipt.eventLogPath);
    const runId = path.basename(receipt.eventLogPath, extension);
    return EventLog.open(path.dirname(receipt.eventLogPath), runId);
  }
}

function feedbackBody(
  receipt: AgenticExecutionReceipt,
  pullRequestUrls: readonly string[],
): string {
  return [
    `ForgeMind run \`${receipt.runId}\` finished with **${receipt.status}** (${receipt.mode}).`,
    "",
    receipt.summary,
    ...(pullRequestUrls.length === 0
      ? []
      : ["", "Pull requests:", ...pullRequestUrls.map((url) => `- ${url}`)]),
  ].join("\n");
}

function assertSafeHead(head: string): void {
  if (head === "test" || head.endsWith(":test")) {
    throw new Error("Publishing the test branch into another branch is forbidden");
  }
  if (head.trim().length === 0 || head.startsWith("-")) throw new Error("Invalid Git branch name");
}

function assertProcessSucceeded(
  result: ProcessResult,
  candidate: AgenticPullRequestCandidate,
): void {
  if (result.exitCode === 0 && result.timedOut !== true) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  throw new Error(`Cannot publish ${candidate.repository}:${candidate.head}: ${detail}`);
}
