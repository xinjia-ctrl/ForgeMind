import { createHash } from "node:crypto";
import { authorize } from "../auth/rbac.js";
import type { ApprovalContext } from "../auth/types.js";
import { StageFailure } from "../core/errors.js";
import type { EventLog } from "../core/event-log.js";
import { estimateTokens, TokenBudgetTracker } from "../core/token-budget.js";
import type { TokenBudget } from "../core/types.js";
import { supportsStructuredOutput } from "../llm/capabilities.js";
import type { ChatMessage, ChatProvider } from "../llm/chat-provider.js";
import { keywordOverlap } from "../memory/keywords.js";
import type { ApprovalGateway } from "../policy/gateway.js";
import type { ActionRequest } from "../policy/types.js";
import { auditValue } from "../tools/audit.js";
import { createDecisionRecord } from "./record.js";
import type {
  Negotiation,
  NegotiationCoordinator,
  NegotiationRequest,
  NegotiationRound,
  NegotiationRoundNumber,
} from "./types.js";
import { stageForNegotiationTrigger } from "./types.js";

const DEFAULT_NEGOTIATION_BUDGET: TokenBudget = { input: 12_000, output: 3_000 };
const TURN_OUTPUT_LIMIT = 1_000;
const TURN_PROMPT_VERSION = "negotiation-turn.v1";

export interface NegotiationTurnInput {
  readonly runId: string;
  readonly negotiationId: string;
  readonly side: "proposal" | "counter";
  readonly round: NegotiationRoundNumber;
  readonly topic: string;
  readonly initialPosition: string;
  readonly otherPosition: string;
  readonly previousRounds: readonly NegotiationRound[];
  readonly stage: "ARCH" | "REVIEW" | "CODE";
}

export interface NegotiationTurnResult {
  readonly position: string;
  readonly tradeoffs: readonly string[];
  readonly acceptsOther: boolean;
  readonly decision: string;
}

export interface NegotiationTurnProvider {
  respond(input: NegotiationTurnInput): Promise<NegotiationTurnResult>;
}

export interface ChatNegotiationTurnProviderOptions {
  readonly provider: ChatProvider;
  readonly model: string;
  readonly eventLog: EventLog;
  readonly budget?: TokenBudget;
}

export class ChatNegotiationTurnProvider implements NegotiationTurnProvider {
  readonly #provider: ChatProvider;
  readonly #model: string;
  readonly #eventLog: EventLog;
  readonly #budget: TokenBudget;
  readonly #trackers = new Map<string, TokenBudgetTracker>();

  public constructor(options: ChatNegotiationTurnProviderOptions) {
    this.#provider = options.provider;
    this.#model = options.model;
    this.#eventLog = options.eventLog;
    this.#budget = options.budget ?? DEFAULT_NEGOTIATION_BUDGET;
  }

  public async respond(input: NegotiationTurnInput): Promise<NegotiationTurnResult> {
    const messages = messagesFor(input);
    const estimatedInput = estimateTokens(messages.map((message) => message.content).join("\n"));
    const tracker = this.trackerFor(input.negotiationId);
    tracker.ensureInputFits(estimatedInput);
    const fingerprint = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    const structured = supportsStructuredOutput(this.#provider);
    let content: string;
    let inputTokens: number;
    let outputTokens: number;
    try {
      const completion = await this.#provider.complete(messages, {
        model: this.#model,
        temperature: 0,
        maxOutputTokens: TURN_OUTPUT_LIMIT,
        seed: 42,
        ...(structured ? { structuredOutput: negotiationTurnSchema() } : {}),
      });
      content = completion.content;
      inputTokens = completion.usage.inputTokens || estimatedInput;
      outputTokens = completion.usage.outputTokens || estimateTokens(content);
    } catch (error) {
      await this.recordLlmCall(input, estimatedInput, 0, fingerprint, structured);
      throw error;
    }
    await this.recordLlmCall(input, inputTokens, outputTokens, fingerprint, structured);
    tracker.consumeInput(inputTokens);
    tracker.consumeOutput(outputTokens);
    return parseTurnResult(content);
  }

  private trackerFor(negotiationId: string): TokenBudgetTracker {
    let tracker = this.#trackers.get(negotiationId);
    if (tracker === undefined) {
      tracker = new TokenBudgetTracker(this.#budget);
      this.#trackers.set(negotiationId, tracker);
    }
    return tracker;
  }

  private async recordLlmCall(
    input: NegotiationTurnInput,
    inputTokens: number,
    outputTokens: number,
    promptFingerprint: string,
    structuredOutput: boolean,
  ): Promise<void> {
    await this.#eventLog.append({
      type: "llm.called",
      data: {
        runId: input.runId,
        stage: input.stage,
        model: this.#model,
        inputTokens,
        outputTokens,
        promptFingerprint,
        promptVersion: TURN_PROMPT_VERSION,
        structuredOutput,
        negotiationId: input.negotiationId,
        negotiationSide: input.side,
      },
    });
  }
}

export interface NegotiationProtocolOptions {
  readonly eventLog: EventLog;
  readonly proposal: NegotiationTurnProvider;
  readonly counter: NegotiationTurnProvider;
  readonly approvalGateway: ApprovalGateway;
  readonly approvalContext?: ApprovalContext;
  readonly maxRounds?: 1 | 2 | 3;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export class NegotiationProtocol implements NegotiationCoordinator {
  readonly #eventLog: EventLog;
  readonly #proposal: NegotiationTurnProvider;
  readonly #counter: NegotiationTurnProvider;
  readonly #approvalGateway: ApprovalGateway;
  readonly #approvalContext: ApprovalContext | undefined;
  readonly #maxRounds: 1 | 2 | 3;
  readonly #timeoutMs: number;
  readonly #clock: () => number;

  public constructor(options: NegotiationProtocolOptions) {
    this.#eventLog = options.eventLog;
    this.#proposal = options.proposal;
    this.#counter = options.counter;
    this.#approvalGateway = options.approvalGateway;
    this.#approvalContext = options.approvalContext;
    this.#maxRounds = options.maxRounds ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#clock = options.clock ?? Date.now;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error("Negotiation timeout must be a positive integer");
    }
  }

  public async negotiate(request: NegotiationRequest): Promise<Negotiation> {
    const id = negotiationId(request);
    const rounds: NegotiationRound[] = [];
    const deadline = this.#clock() + this.#timeoutMs;
    await this.#eventLog.append({
      type: "negotiation.started",
      data: {
        runId: request.runId,
        negotiationId: id,
        trigger: request.trigger,
        topic: request.topic,
      },
    });
    try {
      for (let round = 1; round <= this.#maxRounds; round += 1) {
        const roundNumber = round as NegotiationRoundNumber;
        const proposal = await withDeadline(
          this.#proposal.respond({
            runId: request.runId,
            negotiationId: id,
            side: "proposal",
            round: roundNumber,
            topic: request.topic,
            initialPosition: request.proposal,
            otherPosition: rounds.at(-1)?.counter ?? request.counter,
            previousRounds: rounds,
            stage: stageForNegotiationTrigger(request.trigger),
          }),
          deadline,
          this.#clock,
        );
        const counter = await withDeadline(
          this.#counter.respond({
            runId: request.runId,
            negotiationId: id,
            side: "counter",
            round: roundNumber,
            topic: request.topic,
            initialPosition: request.counter,
            otherPosition: proposal.position,
            previousRounds: rounds,
            stage: stageForNegotiationTrigger(request.trigger),
          }),
          deadline,
          this.#clock,
        );
        const decision = convergedDecision(proposal, counter, rounds.at(-1));
        const negotiationRound: NegotiationRound = {
          round: roundNumber,
          proposal: proposal.position,
          counter: counter.position,
          status: decision === null ? "CONTINUE" : "CONVERGED",
        };
        rounds.push(negotiationRound);
        await this.#eventLog.append({
          type: "negotiation.round",
          data: {
            runId: request.runId,
            negotiationId: id,
            round: roundNumber,
            status: negotiationRound.status,
            proposal: auditValue(proposal.position, "content"),
            counter: auditValue(counter.position, "content"),
          },
        });
        if (decision !== null) {
          const record = createDecisionRecord({
            runId: request.runId,
            topic: request.topic,
            trigger: request.trigger,
            rounds,
            decision,
            escalated: false,
            createdAt: new Date(this.#clock()).toISOString(),
          });
          await this.#eventLog.append({
            type: "negotiation.resolved",
            data: {
              runId: request.runId,
              negotiationId: id,
              decisionRecordId: record.id,
              decision: auditValue(record.decision, "content"),
            },
          });
          return {
            id,
            runId: request.runId,
            trigger: request.trigger,
            topic: request.topic,
            rounds,
            status: "RESOLVED",
            decisionRecord: record,
          };
        }
      }
      return await this.escalate(request, id, rounds, "no-consensus", "ESCALATED");
    } catch (error) {
      if (!(error instanceof NegotiationTimeoutError)) throw error;
      return await this.escalate(request, id, rounds, "timeout", "TIMED_OUT");
    }
  }

  private async escalate(
    request: NegotiationRequest,
    id: string,
    rounds: readonly NegotiationRound[],
    reason: "no-consensus" | "timeout",
    status: "ESCALATED" | "TIMED_OUT",
  ): Promise<Negotiation> {
    const candidate = rounds.at(-1)?.proposal ?? request.proposal;
    const action: ActionRequest = {
      stage: stageForNegotiationTrigger(request.trigger),
      tool: "negotiation_decision",
      args: { negotiationId: id, topic: request.topic, candidate },
    };
    const common = {
      runId: request.runId,
      stage: action.stage,
      tool: action.tool,
      action: auditValue(action.args),
      policy: "negotiation-escalation",
      mode: "approve" as const,
      risk: "high" as const,
      ...(this.#approvalContext === undefined
        ? {}
        : {
            actor: this.#approvalContext.actor.id,
            role: this.#approvalContext.actor.role,
          }),
    };
    await this.#eventLog.append({ type: "approval.requested", data: common });
    let approved = false;
    if (
      this.#approvalContext !== undefined &&
      !authorize(this.#approvalContext.actor, this.#approvalContext.scope, "approve:high")
    ) {
      await this.#eventLog.append({
        type: "approval.rejected",
        data: {
          ...common,
          reason: `Actor ${this.#approvalContext.actor.id} is not authorized for high-risk approval`,
          decisionSource: "policy",
        },
      });
    } else {
      const decision = await this.#approvalGateway.request(
        action,
        this.#approvalContext === undefined
          ? undefined
          : { ...this.#approvalContext, risk: "high" },
      );
      approved = decision === "APPROVED";
      if (approved) {
        await this.#eventLog.append({
          type: "approval.approved",
          data: {
            ...common,
            decisionSource:
              this.#approvalGateway.source === "disabled" ? "config" : this.#approvalGateway.source,
          },
        });
      } else {
        await this.#eventLog.append({
          type: "approval.rejected",
          data: {
            ...common,
            reason: "Approval denied",
            decisionSource: this.#approvalGateway.source,
          },
        });
      }
    }
    await this.#eventLog.append({
      type: "negotiation.escalated",
      data: { runId: request.runId, negotiationId: id, reason, approved },
    });
    const record = approved
      ? createDecisionRecord({
          runId: request.runId,
          topic: request.topic,
          trigger: request.trigger,
          rounds,
          decision: candidate,
          escalated: true,
          createdAt: new Date(this.#clock()).toISOString(),
        })
      : null;
    return {
      id,
      runId: request.runId,
      trigger: request.trigger,
      topic: request.topic,
      rounds,
      status,
      decisionRecord: record,
    };
  }
}

function messagesFor(input: NegotiationTurnInput): readonly ChatMessage[] {
  const role = input.side === "proposal" ? "proposal owner" : "counter reviewer";
  return [
    {
      role: "system",
      content: [
        `You are the ${role} in ForgeMind's bounded engineering negotiation protocol.`,
        "Return one JSON object only. Do not start a free-form conversation.",
        "Assess the other position, preserve safety gates, and explicitly mark acceptance only when the engineering tradeoffs converge.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        topic: input.topic,
        round: input.round,
        initialPosition: input.initialPosition,
        otherPosition: input.otherPosition,
        previousRounds: input.previousRounds,
        output: {
          position: "non-empty engineering position",
          tradeoffs: ["at least one concrete tradeoff"],
          acceptsOther: false,
          decision: "empty unless accepting; otherwise the final agreed decision",
        },
      }),
    },
  ];
}

function negotiationTurnSchema(): {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
} {
  return {
    name: "forgemind_negotiation_turn_v1",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["position", "tradeoffs", "acceptsOther", "decision"],
      properties: {
        position: { type: "string" },
        tradeoffs: { type: "array", minItems: 1, items: { type: "string" } },
        acceptsOther: { type: "boolean" },
        decision: { type: "string" },
      },
    },
  };
}

function parseTurnResult(content: string): NegotiationTurnResult {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new StageFailure("Negotiation response is not JSON");
  let value: unknown;
  try {
    value = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    throw new StageFailure("Negotiation response is invalid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StageFailure("Negotiation response must be an object");
  }
  const record = value as Record<string, unknown>;
  const position = record["position"];
  const tradeoffs = record["tradeoffs"];
  const acceptsOther = record["acceptsOther"];
  const decision = record["decision"];
  if (typeof position !== "string" || position.trim().length === 0) {
    throw new StageFailure("Negotiation position must be a non-empty string");
  }
  if (
    !Array.isArray(tradeoffs) ||
    tradeoffs.length === 0 ||
    !tradeoffs.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new StageFailure("Negotiation tradeoffs must be non-empty strings");
  }
  if (typeof acceptsOther !== "boolean" || typeof decision !== "string") {
    throw new StageFailure("Negotiation acceptance fields are invalid");
  }
  return {
    position: position.trim(),
    tradeoffs: tradeoffs.map((item) => (item as string).trim()),
    acceptsOther,
    decision: decision.trim(),
  };
}

function convergedDecision(
  proposal: NegotiationTurnResult,
  counter: NegotiationTurnResult,
  previous: NegotiationRound | undefined,
): string | null {
  const counterDecision = counter.decision || proposal.position;
  if (counter.acceptsOther && positionsConverge(counterDecision, proposal.position)) {
    return counterDecision;
  }
  if (proposal.acceptsOther && previous !== undefined) {
    const proposalDecision = proposal.decision || previous.counter;
    if (positionsConverge(proposalDecision, previous.counter)) return proposalDecision;
  }
  return null;
}

function positionsConverge(decision: string, acceptedPosition: string): boolean {
  return keywordOverlap(decision, acceptedPosition).length > 0;
}

function negotiationId(request: NegotiationRequest): string {
  return createHash("sha256")
    .update(`${request.runId}\0${request.trigger}\0${request.topic}`)
    .digest("hex")
    .slice(0, 24);
}

class NegotiationTimeoutError extends Error {}

async function withDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  clock: () => number,
): Promise<T> {
  const remaining = deadline - clock();
  if (remaining <= 0) throw new NegotiationTimeoutError("Negotiation timed out");
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new NegotiationTimeoutError("Negotiation timed out")),
      remaining,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
