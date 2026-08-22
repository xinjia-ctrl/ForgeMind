import { createHash } from "node:crypto";
import { normalizeDevelopmentEvent } from "./normalize.js";
import type { DevelopmentEventPoller, EventPollResult } from "./watch.js";

type Fetcher = typeof fetch;

export interface GitHubApiClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly userAgent?: string;
  readonly fetcher?: Fetcher;
}

export interface GitHubPullRequestInput {
  readonly repository: string;
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly body: string;
  readonly draft?: boolean;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly created: boolean;
}

export interface GitHubCommentResult {
  readonly id: string;
  readonly url?: string;
  readonly created: boolean;
}

export class GitHubApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export class GitHubApiClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #apiVersion: string;
  readonly #userAgent: string;
  readonly #fetcher: Fetcher;

  public constructor(options: GitHubApiClientOptions) {
    if (options.token.trim().length === 0) throw new Error("GitHub token cannot be empty");
    this.#token = options.token.trim();
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.github.com");
    this.#apiVersion = options.apiVersion ?? "2026-03-10";
    this.#userAgent = options.userAgent ?? "ForgeMind-Agentic";
    this.#fetcher = options.fetcher ?? fetch;
  }

  public async workflowRuns(
    repository: string,
    page: number,
    perPage = 100,
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const response = objectValue(
      await this.request(
        `/repos/${repositoryPath(repository)}/actions/runs?status=failure&per_page=${perPage}&page=${page}`,
      ),
      "GitHub workflow runs response",
    );
    const runs = response["workflow_runs"];
    if (!Array.isArray(runs)) throw new GitHubApiError("Invalid workflow_runs response", 502);
    return runs.map((run, index) => objectValue(run, `workflow_runs[${index}]`));
  }

  public async createOrGetPullRequest(input: GitHubPullRequestInput): Promise<GitHubPullRequest> {
    assertSafePullRequestBranches(input.head, input.base);
    const repository = repositoryName(input.repository);
    const owner = repository.owner;
    const existing = await this.findPullRequest(
      input.repository,
      `${owner}:${input.head}`,
      input.base,
    );
    if (existing !== null) return { ...existing, created: false };
    try {
      const response = objectValue(
        await this.request(`/repos/${repositoryPath(input.repository)}/pulls`, {
          method: "POST",
          body: {
            title: requiredText(input.title, "pull request title"),
            head: requiredText(input.head, "pull request head"),
            base: requiredText(input.base, "pull request base"),
            body: input.body,
            draft: input.draft ?? false,
          },
        }),
        "GitHub create pull request response",
      );
      return { ...pullRequestResult(response), created: true };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      const raced = await this.findPullRequest(
        input.repository,
        `${owner}:${input.head}`,
        input.base,
      );
      if (raced === null) throw error;
      return { ...raced, created: false };
    }
  }

  public async commentIssue(
    repository: string,
    issueNumber: string | number,
    body: string,
    idempotencyKey: string,
  ): Promise<GitHubCommentResult> {
    const issue = identifier(issueNumber, "GitHub issue number");
    const marker = feedbackMarker(idempotencyKey);
    for (let page = 1; page <= 10; page += 1) {
      const comments = arrayValue(
        await this.request(
          `/repos/${repositoryPath(repository)}/issues/${encodeURIComponent(issue)}/comments?per_page=100&page=${page}`,
        ),
        "GitHub issue comments response",
      );
      const match = comments.find((entry) => {
        const comment = objectValue(entry, "GitHub issue comment");
        return optionalText(comment["body"])?.includes(marker) === true;
      });
      if (match !== undefined) {
        return { ...commentResult(objectValue(match, "GitHub issue comment")), created: false };
      }
      if (comments.length < 100) break;
    }
    const response = objectValue(
      await this.request(
        `/repos/${repositoryPath(repository)}/issues/${encodeURIComponent(issue)}/comments`,
        { method: "POST", body: { body: `${body.trim()}\n\n${marker}` } },
      ),
      "GitHub create issue comment response",
    );
    return { ...commentResult(response), created: true };
  }

  private async findPullRequest(
    repository: string,
    head: string,
    base: string,
  ): Promise<Omit<GitHubPullRequest, "created"> | null> {
    const query = new URLSearchParams({ state: "open", head, base, per_page: "100" });
    const response = arrayValue(
      await this.request(`/repos/${repositoryPath(repository)}/pulls?${query.toString()}`),
      "GitHub pull requests response",
    );
    const first = response[0];
    return first === undefined
      ? null
      : pullRequestResult(objectValue(first, "GitHub pull request response"));
  }

  private async request(
    resource: string,
    options: { readonly method?: "POST"; readonly body?: unknown } = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetcher(`${this.#baseUrl}${resource}`, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "x-github-api-version": this.#apiVersion,
          "user-agent": this.#userAgent,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new GitHubApiError(`GitHub request failed: ${errorMessage(error)}`, 503);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub API ${response.status}: ${boundedText(text, 1_000)}`,
        response.status,
      );
    }
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GitHubApiError("GitHub API returned invalid JSON", 502);
    }
  }
}

export interface GitHubWorkflowRunPollerOptions {
  readonly client: GitHubApiClient;
  readonly repository: string;
  readonly id?: string;
  readonly maxPages?: number;
  readonly now?: () => Date;
}

interface GitHubWorkflowCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export class GitHubWorkflowRunPoller implements DevelopmentEventPoller {
  public readonly id: string;
  readonly #client: GitHubApiClient;
  readonly #repository: string;
  readonly #maxPages: number;
  readonly #now: () => Date;

  public constructor(options: GitHubWorkflowRunPollerOptions) {
    this.#client = options.client;
    this.#repository = requiredText(options.repository, "repository");
    this.id = options.id ?? `github-workflow:${this.#repository}`;
    this.#maxPages = options.maxPages ?? 10;
    if (!Number.isSafeInteger(this.#maxPages) || this.#maxPages < 1) {
      throw new Error("maxPages must be a positive safe integer");
    }
    this.#now = options.now ?? (() => new Date());
  }

  public async poll(cursor?: string): Promise<EventPollResult> {
    const previous = cursor === undefined ? undefined : parseWorkflowCursor(cursor);
    const candidates: {
      readonly cursor: GitHubWorkflowCursor;
      readonly event: NonNullable<ReturnType<typeof normalizeDevelopmentEvent>>;
    }[] = [];
    let newest = previous;
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const runs = await this.#client.workflowRuns(this.#repository, page);
      for (const run of runs) {
        const runCursor = workflowRunCursor(run);
        if (newest === undefined || compareWorkflowCursor(runCursor, newest) > 0)
          newest = runCursor;
        if (previous !== undefined && compareWorkflowCursor(runCursor, previous) <= 0) continue;
        const event = normalizeDevelopmentEvent({
          source: "github",
          event: "workflow_run",
          deliveryId: `poll:${runCursor.id}:${runCursor.updatedAt}`,
          payload: { repository: { full_name: this.#repository }, workflow_run: run },
          repository: this.#repository,
          receivedAt: this.#now().toISOString(),
        });
        if (event !== null) candidates.push({ cursor: runCursor, event });
      }
      if (runs.length < 100) break;
    }
    candidates.sort((left, right) => compareWorkflowCursor(left.cursor, right.cursor));
    return {
      events: candidates.map(({ event }) => event),
      ...(newest === undefined ? {} : { cursor: JSON.stringify(newest) }),
    };
  }
}

function workflowRunCursor(run: Readonly<Record<string, unknown>>): GitHubWorkflowCursor {
  const updatedAt = requiredText(run["updated_at"], "workflow run updated_at");
  if (!Number.isFinite(Date.parse(updatedAt))) throw new GitHubApiError("Invalid updated_at", 502);
  return {
    updatedAt: new Date(updatedAt).toISOString(),
    id: identifier(run["id"], "workflow run id"),
  };
}

function parseWorkflowCursor(value: string): GitHubWorkflowCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid GitHub workflow cursor JSON");
  }
  const object = objectValue(parsed, "GitHub workflow cursor");
  const updatedAt = requiredText(object["updatedAt"], "GitHub workflow cursor.updatedAt");
  if (!Number.isFinite(Date.parse(updatedAt)))
    throw new Error("Invalid GitHub workflow cursor date");
  return {
    updatedAt: new Date(updatedAt).toISOString(),
    id: identifier(object["id"], "cursor id"),
  };
}

function compareWorkflowCursor(left: GitHubWorkflowCursor, right: GitHubWorkflowCursor): number {
  const timestamp = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  return timestamp === 0 ? compareIdentifier(left.id, right.id) : Math.sign(timestamp);
}

function compareIdentifier(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const difference = BigInt(left) - BigInt(right);
    return difference === 0n ? 0 : difference > 0n ? 1 : -1;
  }
  return left.localeCompare(right);
}

function feedbackMarker(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `<!-- forgemind-feedback:${digest} -->`;
}

function assertSafePullRequestBranches(head: string, base: string): void {
  const normalizedHead = requiredText(head, "pull request head");
  requiredText(base, "pull request base");
  if (normalizedHead === "test" || normalizedHead.endsWith(":test")) {
    throw new Error("Creating a pull request from the test branch is forbidden");
  }
}

function pullRequestResult(
  value: Readonly<Record<string, unknown>>,
): Omit<GitHubPullRequest, "created"> {
  const number = value["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new GitHubApiError("GitHub pull request number is invalid", 502);
  }
  return {
    number,
    url: requiredText(value["html_url"] ?? value["url"], "pull request URL"),
  };
}

function commentResult(
  value: Readonly<Record<string, unknown>>,
): Omit<GitHubCommentResult, "created"> {
  const id = identifier(value["id"], "GitHub comment id");
  const url = optionalText(value["html_url"] ?? value["url"]);
  return { id, ...(url === undefined ? {} : { url }) };
}

function repositoryPath(value: string): string {
  const repository = repositoryName(value);
  return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function repositoryName(value: string): { readonly owner: string; readonly name: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  if (match === null) throw new Error("GitHub repository must use owner/name format");
  return { owner: match[1] ?? "", name: match[2] ?? "" };
}

function normalizeBaseUrl(value: string): string {
  const normalized = requiredText(value, "GitHub base URL").replace(/\/+$/, "");
  const url = new URL(normalized);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("GitHub base URL must use HTTPS");
  }
  return normalized;
}

function objectValue(value: unknown, source: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubApiError(`${source} must be an object`, 502);
  }
  return value as Readonly<Record<string, unknown>>;
}

function arrayValue(value: unknown, source: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new GitHubApiError(`${source} must be an array`, 502);
  return value;
}

function requiredText(value: unknown, source: string): string {
  const text = optionalText(value);
  if (text === undefined) throw new Error(`${source} must be a non-empty string`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function identifier(value: unknown, source: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error(`${source} must be a string or safe integer`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
