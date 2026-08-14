import { HardFailure } from "../core/errors.js";
import type { DevelopmentEvent, DevelopmentEventSource } from "./types.js";

export interface DevelopmentEventEnvelope {
  readonly source: DevelopmentEventSource;
  readonly event: string;
  readonly deliveryId: string;
  readonly payload: unknown;
  readonly repository?: string;
  readonly receivedAt?: string;
}

export interface DevelopmentEventNormalizerOptions {
  readonly mention?: string;
  readonly now?: () => Date;
}

export function normalizeDevelopmentEvent(
  envelope: DevelopmentEventEnvelope,
  options: DevelopmentEventNormalizerOptions = {},
): DevelopmentEvent | null {
  const deliveryId = requiredText(envelope.deliveryId, "deliveryId");
  const eventName = requiredText(envelope.event, "event");
  const fallbackTimestamp = normalizeTimestamp(
    envelope.receivedAt ?? (options.now ?? (() => new Date()))().toISOString(),
    "receivedAt",
  );
  const common = { deliveryId, eventName, fallbackTimestamp, envelope } as const;
  switch (envelope.source) {
    case "github":
      return normalizeGitHub(common, options.mention ?? "@forgemind");
    case "jira":
      return normalizeJira(common);
    case "ci":
      return normalizeCi(common);
    case "forgemind":
      return normalizeForgeMind(common);
  }
}

interface NormalizationContext {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly fallbackTimestamp: string;
  readonly envelope: DevelopmentEventEnvelope;
}

function normalizeGitHub(context: NormalizationContext, mention: string): DevelopmentEvent | null {
  const payload = objectValue(context.envelope.payload, "github payload");
  const repo = repositoryFrom(payload, context.envelope.repository, "github payload");
  const actor = nestedOptionalString(payload, ["sender", "login"]);
  if (context.eventName === "issues") {
    const issue = nestedObject(payload, ["issue"], "github payload.issue");
    const action = requiredString(payload["action"], "github payload.action");
    const labels = githubLabels(issue["labels"]);
    return developmentEvent({
      id: `github:${context.deliveryId}`,
      source: "github",
      type: action === "assigned" ? "issue.assigned" : "issue.updated",
      repo,
      object: {
        kind: "issue",
        id: stringIdentifier(issue["number"] ?? issue["id"], "github payload.issue.number"),
        ...optionalObjectMetadata(issue),
      },
      occurredAt: timestampFrom(issue["updated_at"], context.fallbackTimestamp),
      ...(actor === undefined ? {} : { actor }),
      labels,
      context: {
        action,
        state: optionalString(issue["state"]) ?? "unknown",
      },
    });
  }
  if (context.eventName === "workflow_run" || context.eventName === "check_run") {
    const key = context.eventName === "workflow_run" ? "workflow_run" : "check_run";
    const run = nestedObject(payload, [key], `github payload.${key}`);
    const conclusion = optionalString(run["conclusion"] ?? run["status"]);
    if (conclusion !== "failure" && conclusion !== "failed") return null;
    const labels = stringLabels(payload["labels"]);
    return developmentEvent({
      id: `github:${context.deliveryId}`,
      source: "github",
      type: "ci.failed",
      repo,
      object: {
        kind: "workflow",
        id: stringIdentifier(run["id"], `github payload.${key}.id`),
        ...optionalObjectMetadata(run),
      },
      occurredAt: timestampFrom(run["updated_at"], context.fallbackTimestamp),
      ...(actor === undefined ? {} : { actor }),
      labels,
      context: {
        conclusion,
        workflow: optionalString(run["name"]) ?? key,
        headSha: optionalString(run["head_sha"]) ?? "unknown",
      },
    });
  }
  if (
    context.eventName === "issue_comment" ||
    context.eventName === "pull_request_review_comment"
  ) {
    const comment = nestedObject(payload, ["comment"], "github payload.comment");
    const body = requiredString(comment["body"], "github payload.comment.body");
    if (!containsMention(body, mention)) return null;
    const pullRequest =
      context.eventName === "pull_request_review_comment"
        ? nestedObject(payload, ["pull_request"], "github payload.pull_request")
        : githubPullRequestFromIssue(payload);
    if (pullRequest === null) return null;
    return developmentEvent({
      id: `github:${context.deliveryId}`,
      source: "github",
      type: "pr.mentioned",
      repo,
      object: {
        kind: "pull_request",
        id: stringIdentifier(
          pullRequest["number"] ?? pullRequest["id"],
          "github payload.pull_request.number",
        ),
        ...optionalObjectMetadata(pullRequest),
      },
      occurredAt: timestampFrom(
        comment["updated_at"] ?? comment["created_at"],
        context.fallbackTimestamp,
      ),
      ...(actor === undefined ? {} : { actor }),
      labels: githubLabels(pullRequest["labels"]),
      context: {
        action: optionalString(payload["action"]) ?? "mentioned",
        commentId: stringIdentifier(comment["id"], "github payload.comment.id"),
      },
    });
  }
  return null;
}

function normalizeJira(context: NormalizationContext): DevelopmentEvent | null {
  const payload = objectValue(context.envelope.payload, "jira payload");
  if (!context.eventName.includes("issue")) return null;
  const repo = repositoryFrom(payload, context.envelope.repository, "jira payload");
  const issue = nestedObject(payload, ["issue"], "jira payload.issue");
  const fields = optionalObject(issue["fields"]);
  const assigned = context.eventName.includes("assigned") || changedField(payload, "assignee");
  const title = fields === null ? undefined : optionalString(fields["summary"]);
  const url = optionalString(issue["self"]);
  const jiraActor = nestedOptionalString(payload, ["user", "accountId"]);
  return developmentEvent({
    id: `jira:${context.deliveryId}`,
    source: "jira",
    type: assigned ? "issue.assigned" : "issue.updated",
    repo,
    object: {
      kind: "issue",
      id: requiredString(issue["key"] ?? issue["id"], "jira payload.issue.key"),
      ...(title === undefined ? {} : { title }),
      ...(url === undefined ? {} : { url }),
    },
    occurredAt: timestampFrom(
      fields === null ? undefined : fields["updated"],
      context.fallbackTimestamp,
    ),
    ...(jiraActor === undefined ? {} : { actor: jiraActor }),
    labels: fields === null ? [] : stringLabels(fields["labels"]),
    context: {
      action: assigned ? "assigned" : "updated",
      status:
        fields === null
          ? "unknown"
          : (nestedOptionalString(fields, ["status", "name"]) ?? "unknown"),
    },
  });
}

function normalizeCi(context: NormalizationContext): DevelopmentEvent | null {
  const payload = objectValue(context.envelope.payload, "ci payload");
  const status = optionalString(payload["conclusion"] ?? payload["status"]);
  if (status !== "failure" && status !== "failed") return null;
  const repo = repositoryFrom(payload, context.envelope.repository, "ci payload");
  const title = optionalString(payload["name"]);
  const url = optionalString(payload["url"]);
  const actor = optionalString(payload["actor"]);
  return developmentEvent({
    id: `ci:${context.deliveryId}`,
    source: "ci",
    type: "ci.failed",
    repo,
    object: {
      kind: "workflow",
      id: stringIdentifier(payload["id"], "ci payload.id"),
      ...(title === undefined ? {} : { title }),
      ...(url === undefined ? {} : { url }),
    },
    occurredAt: timestampFrom(
      payload["updatedAt"] ?? payload["timestamp"],
      context.fallbackTimestamp,
    ),
    ...(actor === undefined ? {} : { actor }),
    labels: stringLabels(payload["labels"]),
    context: {
      status,
      branch: optionalString(payload["branch"]) ?? "unknown",
      commit: optionalString(payload["commit"]) ?? "unknown",
    },
  });
}

function normalizeForgeMind(context: NormalizationContext): DevelopmentEvent | null {
  if (context.eventName !== "approval.timed_out") return null;
  const payload = objectValue(context.envelope.payload, "forgemind payload");
  const repo = repositoryFrom(payload, context.envelope.repository, "forgemind payload");
  return developmentEvent({
    id: `forgemind:${context.deliveryId}`,
    source: "forgemind",
    type: "approval.timed_out",
    repo,
    object: {
      kind: "approval",
      id: requiredString(payload["approvalId"], "forgemind payload.approvalId"),
    },
    occurredAt: timestampFrom(payload["timedOutAt"], context.fallbackTimestamp),
    labels: [],
    context: {
      runId: requiredString(payload["runId"], "forgemind payload.runId"),
      risk: optionalString(payload["risk"]) ?? "unknown",
    },
  });
}

function developmentEvent(event: DevelopmentEvent): DevelopmentEvent {
  return {
    ...event,
    labels: [...new Set(event.labels.map((label) => label.trim()).filter(Boolean))].sort(),
    context: { ...event.context },
  };
}

function repositoryFrom(
  payload: Readonly<Record<string, unknown>>,
  override: string | undefined,
  source: string,
): string {
  if (override !== undefined) return requiredText(override, "repository");
  const direct = optionalString(payload["repository"]);
  if (direct !== undefined) return requiredText(direct, `${source}.repository`);
  const nested = nestedOptionalString(payload, ["repository", "full_name"]);
  if (nested !== undefined) return requiredText(nested, `${source}.repository.full_name`);
  throw new HardFailure(`${source} does not identify a repository`);
}

function githubPullRequestFromIssue(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const issue = optionalObject(payload["issue"]);
  if (issue === null || optionalObject(issue["pull_request"]) === null) return null;
  return issue;
}

function optionalObjectMetadata(value: Readonly<Record<string, unknown>>): {
  readonly title?: string;
  readonly url?: string;
} {
  const title = optionalString(value["title"] ?? value["name"]);
  const url = optionalString(value["html_url"] ?? value["url"]);
  return {
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
  };
}

function githubLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[] => {
    if (typeof entry === "string") return [entry];
    const object = optionalObject(entry);
    const name = object === null ? undefined : optionalString(object["name"]);
    return name === undefined ? [] : [name];
  });
}

function stringLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function changedField(payload: Readonly<Record<string, unknown>>, field: string): boolean {
  const changelog = optionalObject(payload["changelog"]);
  const items = changelog === null ? undefined : changelog["items"];
  return (
    Array.isArray(items) &&
    items.some((entry) => {
      const item = optionalObject(entry);
      return item !== null && optionalString(item["field"]) === field;
    })
  );
}

function containsMention(body: string, mention: string): boolean {
  return body.toLocaleLowerCase().includes(requiredText(mention, "mention").toLocaleLowerCase());
}

function timestampFrom(value: unknown, fallback: string): string {
  return typeof value === "string" ? normalizeTimestamp(value, "event timestamp") : fallback;
}

function normalizeTimestamp(value: string, source: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HardFailure(`${source} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function stringIdentifier(value: unknown, source: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new HardFailure(`${source} must be a string or safe integer`);
}

function requiredString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HardFailure(`${source} must be a non-empty string`);
  }
  return value.trim();
}

function requiredText(value: string, source: string): string {
  if (value.trim().length === 0) throw new HardFailure(`${source} must be non-empty`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nestedOptionalString(
  value: Readonly<Record<string, unknown>>,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    const object = optionalObject(current);
    if (object === null) return undefined;
    current = object[key];
  }
  return optionalString(current);
}

function nestedObject(
  value: Readonly<Record<string, unknown>>,
  path: readonly string[],
  source: string,
): Readonly<Record<string, unknown>> {
  let current: unknown = value;
  for (const key of path) {
    const object = optionalObject(current);
    if (object === null) throw new HardFailure(`${source} must be an object`);
    current = object[key];
  }
  return objectValue(current, source);
}

function objectValue(value: unknown, source: string): Readonly<Record<string, unknown>> {
  const object = optionalObject(value);
  if (object === null) throw new HardFailure(`${source} must be an object`);
  return object;
}

function optionalObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
