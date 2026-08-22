import type { AgenticExecutionReceipt, AgenticPullRequestCandidate } from "./dispatcher.js";
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
}

export interface AgenticFeedbackCoordinatorOptions {
  readonly github?: GitHubApiClient;
  readonly jira?: JiraApiClient;
  readonly ci?: CiFeedbackClient;
  readonly branchPublisher?: BranchPublisher;
}

export class AgenticFeedbackCoordinator implements AgenticFeedbackPublisher {
  readonly #github: GitHubApiClient | undefined;
  readonly #jira: JiraApiClient | undefined;
  readonly #ci: CiFeedbackClient | undefined;
  readonly #branchPublisher: BranchPublisher | undefined;

  public constructor(options: AgenticFeedbackCoordinatorOptions) {
    this.#github = options.github;
    this.#jira = options.jira;
    this.#ci = options.ci;
    this.#branchPublisher = options.branchPublisher;
  }

  public async publish(
    request: AgenticRunRequest,
    receipt: AgenticExecutionReceipt,
  ): Promise<void> {
    const pullRequestUrls: string[] = [];
    for (const candidate of receipt.pullRequests) {
      assertSafeHead(candidate.head);
      if (this.#github === undefined || this.#branchPublisher === undefined) {
        throw new Error("GitHub client and branch publisher are required to create pull requests");
      }
      await this.#branchPublisher.publish(candidate);
      const pullRequest = await this.#github.createOrGetPullRequest({
        repository: candidate.repository,
        title: candidate.title,
        head: candidate.head,
        base: candidate.base,
        body: candidate.body,
      });
      pullRequestUrls.push(pullRequest.url);
    }
    const body = feedbackBody(receipt, pullRequestUrls);
    const key = `${request.id}:feedback`;
    switch (request.origin.source) {
      case "github":
        await this.publishGitHubComment(request, body, key);
        return;
      case "jira":
        if (this.#jira !== undefined && request.origin.object.kind === "issue") {
          await this.#jira.commentIssue(request.origin.object.id, body, key);
        }
        return;
      case "ci":
        if (this.#ci !== undefined) {
          await this.#ci.comment({
            runId: receipt.runId,
            objectId: request.origin.object.id,
            status: receipt.status,
            summary: receipt.summary,
            idempotencyKey: key,
            pullRequests: pullRequestUrls,
          });
        }
        return;
      case "forgemind":
        return;
    }
  }

  private async publishGitHubComment(
    request: AgenticRunRequest,
    body: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (this.#github === undefined) return;
    const object = request.origin.object;
    if (object.kind === "issue" || object.kind === "pull_request") {
      await this.#github.commentIssue(request.repository, object.id, body, idempotencyKey);
      return;
    }
    const pullRequestNumber = request.origin.context["pullRequestNumber"];
    if (
      object.kind === "workflow" &&
      typeof pullRequestNumber !== "boolean" &&
      pullRequestNumber !== null
    ) {
      if (typeof pullRequestNumber === "string" || typeof pullRequestNumber === "number") {
        await this.#github.commentIssue(
          request.repository,
          pullRequestNumber,
          body,
          idempotencyKey,
        );
      }
    }
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
