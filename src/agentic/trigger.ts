import type {
  AgenticConfig,
  AgenticRunRequest,
  DevelopmentContextValue,
  DevelopmentEvent,
  TriggerDecision,
  TriggerRule,
} from "./types.js";

export interface AgenticTriggerEngineOptions {
  readonly config: AgenticConfig;
  readonly clock?: () => number;
}

interface PendingEvent {
  readonly key: string;
  readonly rule: TriggerRule;
  readonly event: DevelopmentEvent;
  readonly notBefore: number;
}

export class AgenticTriggerEngine {
  readonly #config: AgenticConfig;
  readonly #repositories: ReadonlySet<string>;
  readonly #clock: () => number;
  readonly #seenEvents = new Map<string, number>();
  readonly #lastTriggered = new Map<string, { readonly at: number; readonly requestId: string }>();
  readonly #pending = new Map<string, PendingEvent>();
  readonly #dailyCounts = new Map<string, number>();
  #recentRuns: number[] = [];

  public constructor(options: AgenticTriggerEngineOptions) {
    this.#config = options.config;
    this.#repositories = new Set(options.config.repositories);
    this.#clock = options.clock ?? Date.now;
  }

  public ingest(event: DevelopmentEvent): TriggerDecision {
    const now = this.#clock();
    this.prune(now);
    if (this.#seenEvents.has(event.id)) {
      return { kind: "IGNORE", event, reason: "duplicate-event" };
    }
    this.#seenEvents.set(event.id, now + this.#config.dedupeTtlMs);
    if (!this.#repositories.has(event.repo)) {
      return { kind: "IGNORE", event, reason: "repository-not-authorized" };
    }
    const rule = this.#config.rules.find((candidate) => matches(candidate, event));
    if (rule === undefined) return { kind: "IGNORE", event, reason: "no-matching-rule" };

    const key = objectKey(rule.id, event);
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      this.#pending.set(key, { ...pending, event });
      return {
        kind: "MERGE",
        event,
        reason: "pending-object-merged",
        ruleId: rule.id,
        mergedInto: pending.event.id,
      };
    }
    const lastTriggered = this.#lastTriggered.get(key);
    if (lastTriggered !== undefined && now < lastTriggered.at + rule.cooldownMs) {
      return {
        kind: "MERGE",
        event,
        reason: "active-object-cooldown",
        ruleId: rule.id,
        mergedInto: lastTriggered.requestId,
      };
    }
    return this.decideMatched(event, rule, key, now);
  }

  public drainReady(): readonly TriggerDecision[] {
    const now = this.#clock();
    this.prune(now);
    const ready = [...this.#pending.values()]
      .filter((pending) => pending.notBefore <= now)
      .sort(
        (left, right) =>
          left.notBefore - right.notBefore ||
          left.event.occurredAt.localeCompare(right.event.occurredAt) ||
          left.event.id.localeCompare(right.event.id),
      );
    const decisions: TriggerDecision[] = [];
    for (const pending of ready) {
      if (this.#pending.get(pending.key) !== pending) continue;
      this.#pending.delete(pending.key);
      decisions.push(this.decideMatched(pending.event, pending.rule, pending.key, now));
    }
    return decisions;
  }

  public get pendingCount(): number {
    return this.#pending.size;
  }

  private decideMatched(
    event: DevelopmentEvent,
    rule: TriggerRule,
    key: string,
    now: number,
  ): TriggerDecision {
    const day = utcDay(now);
    if ((this.#dailyCounts.get(day) ?? 0) >= this.#config.dailyTaskQuota) {
      const retryAt = nextUtcDay(now);
      this.#pending.set(key, { key, event, rule, notBefore: retryAt });
      return {
        kind: "DEFER",
        event,
        reason: "daily-task-quota",
        ruleId: rule.id,
        retryAt: new Date(retryAt).toISOString(),
      };
    }
    if (this.#recentRuns.length >= this.#config.rateLimit.maxRuns) {
      const oldest = this.#recentRuns[0] ?? now;
      const retryAt = Math.max(now + 1, oldest + this.#config.rateLimit.windowMs);
      this.#pending.set(key, { key, event, rule, notBefore: retryAt });
      return {
        kind: "DEFER",
        event,
        reason: "global-rate-limit",
        ruleId: rule.id,
        retryAt: new Date(retryAt).toISOString(),
      };
    }
    const request = requestFor(event, rule, now);
    this.#recentRuns.push(now);
    this.#dailyCounts.set(day, (this.#dailyCounts.get(day) ?? 0) + 1);
    this.#lastTriggered.set(key, { at: now, requestId: request.id });
    return { kind: "TRIGGER", event, reason: "matched", ruleId: rule.id, request };
  }

  private prune(now: number): void {
    for (const [eventId, expiresAt] of this.#seenEvents) {
      if (expiresAt <= now) this.#seenEvents.delete(eventId);
    }
    const threshold = now - this.#config.rateLimit.windowMs;
    this.#recentRuns = this.#recentRuns.filter((timestamp) => timestamp > threshold);
    const currentDay = utcDay(now);
    for (const day of this.#dailyCounts.keys()) {
      if (day !== currentDay) this.#dailyCounts.delete(day);
    }
  }
}

function matches(rule: TriggerRule, event: DevelopmentEvent): boolean {
  if (!rule.enabled || rule.match.type !== event.type) return false;
  if (rule.match.source !== undefined && rule.match.source !== event.source) return false;
  if (rule.match.repo !== undefined && rule.match.repo !== event.repo) return false;
  const labels = new Set(event.labels);
  if (!rule.match.labelsAll.every((label) => labels.has(label))) return false;
  return Object.entries(rule.match.contextEquals).every(
    ([key, expected]) => event.context[key] === expected,
  );
}

function objectKey(ruleId: string, event: DevelopmentEvent): string {
  return [ruleId, event.repo, event.object.kind, event.object.id].join("\u0000");
}

function requestFor(event: DevelopmentEvent, rule: TriggerRule, now: number): AgenticRunRequest {
  return {
    id: `${rule.id}:${event.id}`,
    actor: "agentic",
    repository: event.repo,
    requirement: renderRequirement(rule.run.requirement, event),
    priority: rule.run.priority,
    ruleId: rule.id,
    sourceEventIds: [event.id],
    triggeredAt: new Date(now).toISOString(),
  };
}

function renderRequirement(template: string, event: DevelopmentEvent): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = templateValue(key, event);
    return value === undefined ? "" : displayValue(value);
  });
}

function templateValue(key: string, event: DevelopmentEvent): DevelopmentContextValue | undefined {
  switch (key) {
    case "event.id":
      return event.id;
    case "event.type":
      return event.type;
    case "event.source":
      return event.source;
    case "repo":
      return event.repo;
    case "object.id":
      return event.object.id;
    case "object.kind":
      return event.object.kind;
    case "object.title":
      return event.object.title;
    case "object.url":
      return event.object.url;
    default:
      return key.startsWith("context.") ? event.context[key.slice("context.".length)] : undefined;
  }
}

function displayValue(value: DevelopmentContextValue): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextUtcDay(timestamp: number): number {
  const value = new Date(timestamp);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1);
}
