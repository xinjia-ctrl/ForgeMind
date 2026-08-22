import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeDevelopmentEvent } from "./normalize.js";
import type { AgenticWatchOutcome, AgenticWatchService } from "./watch.js";
import type { DevelopmentEvent, DevelopmentEventSource } from "./types.js";

export type WebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface WebhookHttpRequest {
  readonly headers: WebhookHeaders;
  readonly body: Uint8Array | string;
}

export interface WebhookReceiveResult {
  readonly accepted: boolean;
  readonly event?: DevelopmentEvent;
  readonly outcome?: AgenticWatchOutcome;
}

export interface AgenticWebhookReceiver {
  receive(request: WebhookHttpRequest): Promise<WebhookReceiveResult>;
}

export interface GitHubWebhookReceiverOptions {
  readonly secret: string;
  readonly watch: Pick<AgenticWatchService, "accept">;
  readonly mention?: string;
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
}

export interface JiraWebhookReceiverOptions {
  readonly secret: string;
  readonly repository: string | ((payload: Readonly<Record<string, unknown>>) => string);
  readonly watch: Pick<AgenticWatchService, "accept">;
  readonly tenant?: string;
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
}

export interface CiWebhookReceiverOptions {
  readonly secret: string;
  readonly watch: Pick<AgenticWatchService, "accept">;
  readonly repository?: string | ((payload: Readonly<Record<string, unknown>>) => string);
  readonly signatureHeader?: string;
  readonly deliveryHeader?: string;
  readonly eventHeader?: string;
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
}

interface SignedWebhookReceiverOptions {
  readonly source: DevelopmentEventSource;
  readonly secret: string;
  readonly watch: Pick<AgenticWatchService, "accept">;
  readonly signatureHeader: string;
  readonly deliveryHeader: string;
  readonly eventName: (
    headers: WebhookHeaders,
    payload: Readonly<Record<string, unknown>>,
  ) => string;
  readonly deliveryId?: (deliveryId: string) => string;
  readonly repository?: string | ((payload: Readonly<Record<string, unknown>>) => string);
  readonly mention?: string;
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
}

export class WebhookRequestError extends Error {
  public readonly statusCode: number;

  public constructor(message: string, statusCode: number) {
    super(message);
    this.name = "WebhookRequestError";
    this.statusCode = statusCode;
  }
}

export class GitHubWebhookReceiver implements AgenticWebhookReceiver {
  readonly #receiver: SignedWebhookReceiver;

  public constructor(options: GitHubWebhookReceiverOptions) {
    this.#receiver = new SignedWebhookReceiver({
      source: "github",
      secret: options.secret,
      watch: options.watch,
      signatureHeader: "x-hub-signature-256",
      deliveryHeader: "x-github-delivery",
      eventName: (headers) => requiredHeader(headers, "x-github-event"),
      ...(options.mention === undefined ? {} : { mention: options.mention }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  public async receive(request: WebhookHttpRequest): Promise<WebhookReceiveResult> {
    return await this.#receiver.receive(request);
  }
}

export class JiraWebhookReceiver implements AgenticWebhookReceiver {
  readonly #receiver: SignedWebhookReceiver;

  public constructor(options: JiraWebhookReceiverOptions) {
    const tenant = options.tenant?.trim();
    this.#receiver = new SignedWebhookReceiver({
      source: "jira",
      secret: options.secret,
      watch: options.watch,
      signatureHeader: "x-hub-signature",
      deliveryHeader: "x-atlassian-webhook-identifier",
      eventName: (_headers, payload) => requiredText(payload["webhookEvent"], "webhookEvent"),
      repository: options.repository,
      ...(tenant === undefined || tenant.length === 0
        ? {}
        : { deliveryId: (deliveryId) => `${tenant}:${deliveryId}` }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  public async receive(request: WebhookHttpRequest): Promise<WebhookReceiveResult> {
    return await this.#receiver.receive(request);
  }
}

export class CiWebhookReceiver implements AgenticWebhookReceiver {
  readonly #receiver: SignedWebhookReceiver;

  public constructor(options: CiWebhookReceiverOptions) {
    const eventHeader = options.eventHeader ?? "x-ci-event";
    this.#receiver = new SignedWebhookReceiver({
      source: "ci",
      secret: options.secret,
      watch: options.watch,
      signatureHeader: options.signatureHeader ?? "x-ci-signature-256",
      deliveryHeader: options.deliveryHeader ?? "x-ci-delivery",
      eventName: (headers, payload) =>
        optionalHeader(headers, eventHeader) ?? optionalText(payload["event"]) ?? "build",
      ...(options.repository === undefined ? {} : { repository: options.repository }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  public async receive(request: WebhookHttpRequest): Promise<WebhookReceiveResult> {
    return await this.#receiver.receive(request);
  }
}

class SignedWebhookReceiver implements AgenticWebhookReceiver {
  readonly #options: SignedWebhookReceiverOptions;

  public constructor(options: SignedWebhookReceiverOptions) {
    if (options.secret.length === 0) throw new Error("Webhook secret cannot be empty");
    validateBodyLimit(options.maxBodyBytes);
    this.#options = options;
  }

  public async receive(request: WebhookHttpRequest): Promise<WebhookReceiveResult> {
    const rawBody = rawBytes(request.body);
    const maxBodyBytes = this.#options.maxBodyBytes ?? 1_048_576;
    if (rawBody.byteLength > maxBodyBytes) {
      throw new WebhookRequestError(`Webhook body exceeds ${maxBodyBytes} bytes`, 413);
    }
    const signature = requiredHeader(request.headers, this.#options.signatureHeader);
    if (!verifyWebhookHmac(rawBody, signature, this.#options.secret)) {
      throw new WebhookRequestError("Webhook signature verification failed", 401);
    }
    const payload = parseJsonObject(rawBody);
    const delivery = requiredHeader(request.headers, this.#options.deliveryHeader);
    const repository = resolveRepository(this.#options.repository, payload);
    const receivedAt = (this.#options.now ?? (() => new Date()))().toISOString();
    const event = normalizeDevelopmentEvent(
      {
        source: this.#options.source,
        event: this.#options.eventName(request.headers, payload),
        deliveryId: this.#options.deliveryId?.(delivery) ?? delivery,
        payload,
        receivedAt,
        ...(repository === undefined ? {} : { repository }),
      },
      {
        ...(this.#options.mention === undefined ? {} : { mention: this.#options.mention }),
        now: this.#options.now ?? (() => new Date()),
      },
    );
    if (event === null) return { accepted: false };
    const outcome = await this.#options.watch.accept(event);
    return { accepted: true, event, outcome };
  }
}

export function verifyWebhookHmac(
  rawBody: Uint8Array | string,
  signature: string,
  secret: string,
): boolean {
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(signature.trim());
  if (match === null || secret.length === 0) return false;
  const supplied = Buffer.from(match[1] ?? "", "hex");
  const expected = createHmac("sha256", secret).update(rawBytes(rawBody)).digest();
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

export async function handleNodeWebhook(
  receiver: AgenticWebhookReceiver,
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes = 1_048_576,
): Promise<void> {
  try {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      respond(response, 405, { error: "method_not_allowed" });
      return;
    }
    const body = await readNodeBody(request, maxBodyBytes);
    const result = await receiver.receive({ headers: request.headers, body });
    respond(
      response,
      result.accepted ? 202 : 204,
      result.accepted ? { accepted: true } : undefined,
    );
  } catch (error) {
    const statusCode = error instanceof WebhookRequestError ? error.statusCode : 500;
    respond(response, statusCode, {
      error: statusCode >= 500 ? "internal_error" : "invalid_webhook",
    });
  }
}

async function readNodeBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  validateBodyLimit(maxBodyBytes);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.byteLength;
    if (size > maxBodyBytes) throw new WebhookRequestError("Webhook body is too large", 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function respond(response: ServerResponse, statusCode: number, body?: unknown): void {
  response.statusCode = statusCode;
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function parseJsonObject(rawBody: Uint8Array): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
  } catch {
    throw new WebhookRequestError("Webhook body must be valid JSON", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebhookRequestError("Webhook body must be a JSON object", 400);
  }
  return value as Readonly<Record<string, unknown>>;
}

function resolveRepository(
  repository: SignedWebhookReceiverOptions["repository"],
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  if (repository === undefined) return undefined;
  return requiredText(
    typeof repository === "function" ? repository(payload) : repository,
    "repository",
  );
}

function rawBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function requiredHeader(headers: WebhookHeaders, name: string): string {
  const value = optionalHeader(headers, name);
  if (value === undefined) throw new WebhookRequestError(`Missing ${name} header`, 400);
  return value;
}

function optionalHeader(headers: WebhookHeaders, name: string): string | undefined {
  const expected = name.toLocaleLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLocaleLowerCase() !== expected) continue;
    const selected = typeof value === "string" ? value : value?.[0];
    return optionalText(selected);
  }
  return undefined;
}

function requiredText(value: unknown, source: string): string {
  const text = optionalText(value);
  if (text === undefined)
    throw new WebhookRequestError(`${source} must be a non-empty string`, 400);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validateBodyLimit(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
}
