import { normalizeDevelopmentEvent } from "./normalize.js";
import type { DevelopmentEventPoller, EventPollResult } from "./watch.js";

type Fetcher = typeof fetch;

export interface CiPollDelivery {
  readonly id: string;
  readonly event?: string;
  readonly repository?: string;
  readonly receivedAt?: string;
  readonly payload: unknown;
}

export interface CiPollBatch {
  readonly deliveries: readonly CiPollDelivery[];
  readonly cursor?: string;
}

export interface CiPollSource {
  poll(cursor?: string): Promise<CiPollBatch>;
}

export interface CiEventPollerOptions {
  readonly id: string;
  readonly source: CiPollSource;
  readonly repository?: string;
  readonly now?: () => Date;
}

export class CiEventPoller implements DevelopmentEventPoller {
  public readonly id: string;
  readonly #source: CiPollSource;
  readonly #repository: string | undefined;
  readonly #now: () => Date;

  public constructor(options: CiEventPollerOptions) {
    this.id = requiredText(options.id, "CI poller id");
    this.#source = options.source;
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
  }

  public async poll(cursor?: string): Promise<EventPollResult> {
    const batch = await this.#source.poll(cursor);
    const events = batch.deliveries.flatMap((delivery) => {
      const repository = delivery.repository ?? this.#repository;
      const event = normalizeDevelopmentEvent({
        source: "ci",
        event: delivery.event ?? "build",
        deliveryId: requiredText(delivery.id, "CI delivery id"),
        payload: delivery.payload,
        receivedAt: delivery.receivedAt ?? this.#now().toISOString(),
        ...(repository === undefined ? {} : { repository }),
      });
      return event === null ? [] : [event];
    });
    return { events, ...(batch.cursor === undefined ? {} : { cursor: batch.cursor }) };
  }
}

export interface CiFeedback {
  readonly runId: string;
  readonly objectId: string;
  readonly status: string;
  readonly summary: string;
  readonly idempotencyKey: string;
  readonly pullRequests: readonly string[];
}

export interface CiFeedbackClient {
  comment(feedback: CiFeedback): Promise<void>;
}

export interface HttpCiFeedbackClientOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetcher?: Fetcher;
}

export class HttpCiFeedbackClient implements CiFeedbackClient {
  readonly #endpoint: string;
  readonly #token: string | undefined;
  readonly #fetcher: Fetcher;

  public constructor(options: HttpCiFeedbackClientOptions) {
    this.#endpoint = secureUrl(options.endpoint);
    this.#token = options.token;
    this.#fetcher = options.fetcher ?? fetch;
  }

  public async comment(feedback: CiFeedback): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetcher(this.#endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": feedback.idempotencyKey,
          ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` }),
        },
        body: JSON.stringify(feedback),
      });
    } catch (error) {
      throw new Error(`CI feedback request failed: ${errorMessage(error)}`, { cause: error });
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`CI feedback API ${response.status}: ${boundedText(body, 1_000)}`);
    }
  }
}

function secureUrl(value: string): string {
  const normalized = requiredText(value, "CI feedback endpoint");
  const url = new URL(normalized);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("CI feedback endpoint must use HTTPS");
  }
  return normalized;
}

function requiredText(value: string, source: string): string {
  if (value.trim().length === 0) throw new Error(`${source} cannot be empty`);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
