import type { EventLog } from "../core/event-log.js";
import type { AgenticStateStore, AgenticWatchCheckpoint } from "./state.js";
import type { AgenticRunRequest, DevelopmentEvent, TriggerDecision } from "./types.js";
import type { AgenticTriggerEngine } from "./trigger.js";

export interface EventPollResult {
  readonly events: readonly DevelopmentEvent[];
  readonly cursor?: string;
}

export interface DevelopmentEventPoller {
  readonly id: string;
  poll(cursor?: string): Promise<EventPollResult>;
}

export interface AgenticDispatchReceipt {
  readonly runId: string;
}

export interface AgenticRunDispatcher {
  dispatch(request: AgenticRunRequest): Promise<AgenticDispatchReceipt>;
}

export interface AgenticAuditSink {
  received(event: DevelopmentEvent): Promise<void>;
  decided(decision: TriggerDecision): Promise<void>;
}

export interface AgenticWatchOutcome {
  readonly decision: TriggerDecision;
  readonly dispatch?: AgenticDispatchReceipt;
}

export interface AgenticWatchServiceOptions {
  readonly trigger: AgenticTriggerEngine;
  readonly dispatcher: AgenticRunDispatcher;
  readonly pollers?: readonly DevelopmentEventPoller[];
  readonly audit?: AgenticAuditSink;
  readonly stateStore?: AgenticStateStore;
}

export class AgenticWatchService {
  readonly #trigger: AgenticTriggerEngine;
  readonly #dispatcher: AgenticRunDispatcher;
  readonly #pollers: readonly DevelopmentEventPoller[];
  readonly #audit: AgenticAuditSink;
  readonly #stateStore: AgenticStateStore | undefined;
  readonly #cursors = new Map<string, string>();
  readonly #dispatchRetries = new Map<
    string,
    Extract<TriggerDecision, { readonly kind: "TRIGGER" }>
  >();
  #pollQueue: Promise<readonly AgenticWatchOutcome[]> = Promise.resolve([]);
  #stateSaveQueue: Promise<void> = Promise.resolve();
  #initialization: Promise<void> | null = null;

  public constructor(options: AgenticWatchServiceOptions) {
    this.#trigger = options.trigger;
    this.#dispatcher = options.dispatcher;
    this.#pollers = options.pollers ?? [];
    this.#audit = options.audit ?? new NoopAgenticAuditSink();
    this.#stateStore = options.stateStore;
    const pollerIds = this.#pollers.map((poller) => poller.id);
    if (new Set(pollerIds).size !== pollerIds.length) {
      throw new Error("Development event poller ids must be unique");
    }
  }

  public async accept(event: DevelopmentEvent): Promise<AgenticWatchOutcome> {
    await this.restore();
    await this.#audit.received(event);
    return await this.applyDecision(this.#trigger.ingest(event));
  }

  public async restore(): Promise<void> {
    this.#initialization ??= this.restoreImmediately();
    await this.#initialization;
  }

  public async pollOnce(): Promise<readonly AgenticWatchOutcome[]> {
    const operation = this.#pollQueue.then(() => this.pollImmediately());
    this.#pollQueue = operation.then(
      (outcomes) => outcomes,
      () => [],
    );
    return await operation;
  }

  public async run(signal: AbortSignal, pollIntervalMs: number): Promise<void> {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000) {
      throw new Error("pollIntervalMs must be an integer of at least 1000ms");
    }
    while (!signal.aborted) {
      await this.pollOnce();
      await waitForNextPoll(signal, pollIntervalMs);
    }
  }

  public cursorFor(pollerId: string): string | undefined {
    return this.#cursors.get(pollerId);
  }

  public get pendingDispatchCount(): number {
    return this.#dispatchRetries.size;
  }

  private async pollImmediately(): Promise<readonly AgenticWatchOutcome[]> {
    await this.restore();
    const outcomes: AgenticWatchOutcome[] = [...(await this.retryQueuedDispatches())];
    for (const poller of this.#pollers) {
      const cursor = this.#cursors.get(poller.id);
      const result = await poller.poll(cursor);
      for (const event of result.events) outcomes.push(await this.accept(event));
      if (result.cursor !== undefined) {
        this.#cursors.set(poller.id, result.cursor);
        await this.persistState();
      }
    }
    const ready = this.#trigger.drainReady();
    for (const decision of ready) {
      if (decision.kind === "TRIGGER") this.#dispatchRetries.set(decision.request.id, decision);
    }
    if (ready.length > 0) await this.persistState();
    for (const decision of ready) {
      outcomes.push(await this.applyDecision(decision));
    }
    return outcomes;
  }

  private async applyDecision(decision: TriggerDecision): Promise<AgenticWatchOutcome> {
    await this.#audit.decided(decision);
    if (decision.kind !== "TRIGGER") {
      await this.persistState();
      return { decision };
    }
    this.#dispatchRetries.set(decision.request.id, decision);
    await this.persistState();
    const dispatch = await this.#dispatcher.dispatch(decision.request);
    this.#dispatchRetries.delete(decision.request.id);
    await this.persistState();
    return { decision, dispatch };
  }

  private async retryQueuedDispatches(): Promise<readonly AgenticWatchOutcome[]> {
    const outcomes: AgenticWatchOutcome[] = [];
    for (const decision of [...this.#dispatchRetries.values()].sort((left, right) =>
      left.request.id.localeCompare(right.request.id),
    )) {
      const dispatch = await this.#dispatcher.dispatch(decision.request);
      this.#dispatchRetries.delete(decision.request.id);
      await this.persistState();
      outcomes.push({ decision, dispatch });
    }
    return outcomes;
  }

  private async restoreImmediately(): Promise<void> {
    const checkpoint = await this.#stateStore?.load();
    if (checkpoint === undefined || checkpoint === null) return;
    this.#trigger.restore(checkpoint.trigger);
    this.#cursors.clear();
    for (const [pollerId, cursor] of Object.entries(checkpoint.cursors)) {
      this.#cursors.set(pollerId, cursor);
    }
    this.#dispatchRetries.clear();
    for (const decision of checkpoint.dispatchRetries) {
      this.#trigger.assertRestorableDecision(decision);
      this.#dispatchRetries.set(decision.request.id, decision);
    }
  }

  private checkpoint(): AgenticWatchCheckpoint {
    return {
      version: 1,
      cursors: Object.fromEntries(
        [...this.#cursors].sort(([left], [right]) => left.localeCompare(right)),
      ),
      trigger: this.#trigger.checkpoint(),
      dispatchRetries: [...this.#dispatchRetries.values()].sort((left, right) =>
        left.request.id.localeCompare(right.request.id),
      ),
    };
  }

  private async persistState(): Promise<void> {
    if (this.#stateStore === undefined) return;
    const checkpoint = this.checkpoint();
    const operation = this.#stateSaveQueue.then(async () => {
      await this.#stateStore?.save(checkpoint);
    });
    this.#stateSaveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }
}

export class EventLogAgenticAuditSink implements AgenticAuditSink {
  readonly #eventLog: EventLog;
  readonly #runId: string;

  public constructor(eventLog: EventLog, runId: string) {
    this.#eventLog = eventLog;
    this.#runId = runId;
  }

  public async received(event: DevelopmentEvent): Promise<void> {
    await this.#eventLog.append({
      type: "development.received",
      data: {
        runId: this.#runId,
        actor: "agentic",
        eventId: event.id,
        source: event.source,
        developmentType: event.type,
        repo: event.repo,
        objectKind: event.object.kind,
        objectId: event.object.id,
        occurredAt: event.occurredAt,
      },
    });
  }

  public async decided(decision: TriggerDecision): Promise<void> {
    await this.#eventLog.append({
      type: "trigger.decided",
      data: {
        runId: this.#runId,
        actor: "agentic",
        eventId: decision.event.id,
        repo: decision.event.repo,
        decision: decision.kind,
        reason: decision.reason,
        ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        ...(decision.kind === "TRIGGER" ? { requestId: decision.request.id } : {}),
        ...(decision.kind === "DEFER" ? { retryAt: decision.retryAt } : {}),
      },
    });
  }
}

class NoopAgenticAuditSink implements AgenticAuditSink {
  public received(_event: DevelopmentEvent): Promise<void> {
    return Promise.resolve();
  }

  public decided(_decision: TriggerDecision): Promise<void> {
    return Promise.resolve();
  }
}

async function waitForNextPoll(signal: AbortSignal, intervalMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, intervalMs);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
