import { createHash } from "node:crypto";
import { normalizeDevelopmentEvent } from "./normalize.js";
import type { DevelopmentEventPoller, EventPollResult } from "./watch.js";

type Fetcher = typeof fetch;

export type JiraAuthentication =
  { readonly bearerToken: string } | { readonly email: string; readonly apiToken: string };

export interface JiraApiClientOptions {
  readonly baseUrl: string;
  readonly authentication: JiraAuthentication;
  readonly fetcher?: Fetcher;
}

export interface JiraSearchPage {
  readonly issues: readonly Readonly<Record<string, unknown>>[];
  readonly nextPageToken?: string;
}

export interface JiraCommentResult {
  readonly id: string;
  readonly created: boolean;
}

export class JiraApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
  }
}

export class JiraApiClient {
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #fetcher: Fetcher;

  public constructor(options: JiraApiClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#authorization = authorizationHeader(options.authentication);
    this.#fetcher = options.fetcher ?? fetch;
  }

  public async searchIssues(
    jql: string,
    nextPageToken?: string,
    maxResults = 100,
  ): Promise<JiraSearchPage> {
    const response = objectValue(
      await this.request("/rest/api/3/search/jql", {
        method: "POST",
        body: {
          jql: requiredText(jql, "JQL"),
          fields: ["summary", "updated", "status", "labels", "assignee"],
          maxResults,
          ...(nextPageToken === undefined ? {} : { nextPageToken }),
        },
      }),
      "Jira search response",
    );
    const issues = response["issues"];
    if (!Array.isArray(issues)) throw new JiraApiError("Jira issues response is invalid", 502);
    const token = optionalText(response["nextPageToken"]);
    return {
      issues: issues.map((issue, index) => objectValue(issue, `Jira issue ${index}`)),
      ...(token === undefined ? {} : { nextPageToken: token }),
    };
  }

  public async commentIssue(
    issueIdOrKey: string,
    body: string,
    idempotencyKey: string,
  ): Promise<JiraCommentResult> {
    const issue = encodeURIComponent(requiredText(issueIdOrKey, "Jira issue id"));
    const marker = feedbackMarker(idempotencyKey);
    let startAt = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = objectValue(
        await this.request(
          `/rest/api/3/issue/${issue}/comment?startAt=${startAt}&maxResults=100&orderBy=-created`,
        ),
        "Jira comments response",
      );
      const rawComments: unknown = response["comments"];
      if (!Array.isArray(rawComments)) throw new JiraApiError("Jira comments are invalid", 502);
      const comments: readonly unknown[] = rawComments;
      const match = comments.find((entry) => jsonText(entry).includes(marker));
      if (match !== undefined) {
        return {
          id: identifier(objectValue(match, "Jira comment")["id"], "Jira comment id"),
          created: false,
        };
      }
      if (comments.length < 100) break;
      startAt += comments.length;
    }
    const response = objectValue(
      await this.request(`/rest/api/3/issue/${issue}/comment`, {
        method: "POST",
        body: {
          body: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: `${body.trim()}\n\n${marker}` }],
              },
            ],
          },
        },
      }),
      "Jira create comment response",
    );
    return { id: identifier(response["id"], "Jira comment id"), created: true };
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
          accept: "application/json",
          authorization: this.#authorization,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new JiraApiError(`Jira request failed: ${errorMessage(error)}`, 503);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new JiraApiError(
        `Jira API ${response.status}: ${boundedText(text, 1_000)}`,
        response.status,
      );
    }
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new JiraApiError("Jira API returned invalid JSON", 502);
    }
  }
}

export interface JiraIssuePollerOptions {
  readonly client: JiraApiClient;
  readonly repository: string;
  readonly jql?: string;
  readonly id?: string;
  readonly maxPages?: number;
  readonly now?: () => Date;
}

interface JiraIssueCursor {
  readonly updatedAt: string;
  readonly key: string;
}

export class JiraIssuePoller implements DevelopmentEventPoller {
  public readonly id: string;
  readonly #client: JiraApiClient;
  readonly #repository: string;
  readonly #jql: string | undefined;
  readonly #maxPages: number;
  readonly #now: () => Date;

  public constructor(options: JiraIssuePollerOptions) {
    this.#client = options.client;
    this.#repository = requiredText(options.repository, "repository");
    this.#jql = options.jql === undefined ? undefined : requiredText(options.jql, "JQL");
    this.id = options.id ?? `jira-issues:${this.#repository}`;
    this.#maxPages = options.maxPages ?? 10;
    if (!Number.isSafeInteger(this.#maxPages) || this.#maxPages < 1) {
      throw new Error("maxPages must be a positive safe integer");
    }
    this.#now = options.now ?? (() => new Date());
  }

  public async poll(cursor?: string): Promise<EventPollResult> {
    const previous = cursor === undefined ? undefined : parseIssueCursor(cursor);
    const jql = pollingJql(this.#jql, previous);
    const candidates: {
      readonly cursor: JiraIssueCursor;
      readonly event: NonNullable<ReturnType<typeof normalizeDevelopmentEvent>>;
    }[] = [];
    let nextPageToken: string | undefined;
    let newest = previous;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const result = await this.#client.searchIssues(jql, nextPageToken);
      for (const issue of result.issues) {
        const issueCursor = jiraIssueCursor(issue);
        if (newest === undefined || compareIssueCursor(issueCursor, newest) > 0)
          newest = issueCursor;
        if (previous !== undefined && compareIssueCursor(issueCursor, previous) <= 0) continue;
        const event = normalizeDevelopmentEvent({
          source: "jira",
          event: "jira:issue_updated",
          deliveryId: `poll:${issueCursor.key}:${issueCursor.updatedAt}`,
          repository: this.#repository,
          receivedAt: this.#now().toISOString(),
          payload: { webhookEvent: "jira:issue_updated", issue },
        });
        if (event !== null) candidates.push({ cursor: issueCursor, event });
      }
      nextPageToken = result.nextPageToken;
      if (nextPageToken === undefined) break;
    }
    candidates.sort((left, right) => compareIssueCursor(left.cursor, right.cursor));
    return {
      events: candidates.map(({ event }) => event),
      ...(newest === undefined ? {} : { cursor: JSON.stringify(newest) }),
    };
  }
}

function pollingJql(base: string | undefined, cursor: JiraIssueCursor | undefined): string {
  const updated =
    cursor === undefined ? "updated >= -1d" : `updated >= "${jiraJqlTimestamp(cursor.updatedAt)}"`;
  return `${base === undefined ? updated : `(${base}) AND ${updated}`} ORDER BY updated ASC, key ASC`;
}

function jiraJqlTimestamp(value: string): string {
  const date = new Date(value);
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function jiraIssueCursor(issue: Readonly<Record<string, unknown>>): JiraIssueCursor {
  const fields = objectValue(issue["fields"], "Jira issue fields");
  const updatedAt = requiredText(fields["updated"], "Jira issue updated");
  if (!Number.isFinite(Date.parse(updatedAt)))
    throw new JiraApiError("Jira issue date is invalid", 502);
  return {
    updatedAt: new Date(updatedAt).toISOString(),
    key: requiredText(issue["key"] ?? issue["id"], "Jira issue key"),
  };
}

function parseIssueCursor(value: string): JiraIssueCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid Jira issue cursor JSON");
  }
  const object = objectValue(parsed, "Jira issue cursor");
  const updatedAt = requiredText(object["updatedAt"], "Jira cursor updatedAt");
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("Invalid Jira issue cursor date");
  return { updatedAt: new Date(updatedAt).toISOString(), key: requiredText(object["key"], "key") };
}

function compareIssueCursor(left: JiraIssueCursor, right: JiraIssueCursor): number {
  const timestamp = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  return timestamp === 0 ? left.key.localeCompare(right.key) : Math.sign(timestamp);
}

function authorizationHeader(authentication: JiraAuthentication): string {
  if ("bearerToken" in authentication) {
    return `Bearer ${requiredText(authentication.bearerToken, "Jira bearer token")}`;
  }
  const email = requiredText(authentication.email, "Jira email");
  const token = requiredText(authentication.apiToken, "Jira API token");
  return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
}

function normalizeBaseUrl(value: string): string {
  const normalized = requiredText(value, "Jira base URL").replace(/\/+$/, "");
  const url = new URL(normalized);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Jira base URL must use HTTPS");
  }
  return normalized;
}

function feedbackMarker(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `[forgemind-feedback:${digest}]`;
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jsonText).join(" ");
  if (typeof value !== "object" || value === null) return "";
  return Object.values(value as Readonly<Record<string, unknown>>)
    .map(jsonText)
    .join(" ");
}

function objectValue(value: unknown, source: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JiraApiError(`${source} must be an object`, 502);
  }
  return value as Readonly<Record<string, unknown>>;
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
