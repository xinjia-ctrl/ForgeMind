import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EventLog } from "../../src/core/event-log.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { AutoApprovalGateway } from "../../src/policy/auto-gateway.js";
import { DenyApprovalGateway } from "../../src/policy/gateway.js";
import {
  ChatNegotiationTurnProvider,
  NegotiationProtocol,
  type NegotiationTurnInput,
  type NegotiationTurnProvider,
  type NegotiationTurnResult,
} from "../../src/negotiation/protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded negotiation protocol", () => {
  it("resolves on an explicit counter acceptance and audits the decision", async () => {
    const fixture = await protocolFixture(
      new QueueTurnProvider([turn("Keep the outer layer")]),
      new QueueTurnProvider([
        turn("Accept the outer layer with an adapter boundary", true, "Use the outer layer"),
      ]),
      new DenyApprovalGateway(),
    );
    const negotiation = await fixture.protocol.negotiate(request());
    assert.equal(negotiation.status, "RESOLVED");
    assert.equal(negotiation.rounds.length, 1);
    assert.ok(negotiation.decisionRecord);
    assert.equal(negotiation.decisionRecord.decision, "Use the outer layer");
    assert.equal(negotiation.decisionRecord.escalated, false);
    assert.deepEqual(
      (await fixture.events.load())
        .filter((event) => event.type.startsWith("negotiation."))
        .map((event) => event.type),
      ["negotiation.started", "negotiation.round", "negotiation.resolved"],
    );
  });

  it("runs at most three rounds and escalates unresolved decisions", async () => {
    const proposal = new QueueTurnProvider([
      turn("Proposal one"),
      turn("Proposal two"),
      turn("Proposal three"),
    ]);
    const counter = new QueueTurnProvider([
      turn("Counter one"),
      turn("Counter two"),
      turn("Counter three"),
    ]);
    const fixture = await protocolFixture(proposal, counter, new AutoApprovalGateway());
    const negotiation = await fixture.protocol.negotiate(request());
    assert.equal(negotiation.status, "ESCALATED");
    assert.equal(negotiation.rounds.length, 3);
    assert.ok(negotiation.decisionRecord);
    assert.equal(negotiation.decisionRecord.decision, "Proposal three");
    assert.equal(negotiation.decisionRecord.escalated, true);
    assert.equal(proposal.calls.length, 3);
    assert.equal(counter.calls.length, 3);
    assert.deepEqual(
      (await fixture.events.load())
        .filter(
          (event) =>
            event.type === "approval.requested" ||
            event.type === "approval.approved" ||
            event.type === "negotiation.escalated",
        )
        .map((event) => event.type),
      ["approval.requested", "approval.approved", "negotiation.escalated"],
    );
  });

  it("times out a stalled participant and requires approval", async () => {
    const fixture = await protocolFixture(
      new StalledTurnProvider(),
      new QueueTurnProvider([]),
      new DenyApprovalGateway(),
      10,
    );
    const negotiation = await fixture.protocol.negotiate(request());
    assert.equal(negotiation.status, "TIMED_OUT");
    assert.equal(negotiation.decisionRecord, null);
    const events = await fixture.events.load();
    assert.equal(
      events.find((event) => event.type === "negotiation.escalated")?.data.approved,
      false,
    );
  });

  it("adapts the shared ChatProvider contract with structured output and LLM audit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-negotiation-chat-"));
    temporaryDirectories.push(directory);
    const events = await EventLog.create(directory, "negotiation-chat-run");
    const chat = new FakeChatProvider([
      JSON.stringify({
        position: "Keep the protocol outside stage agents",
        tradeoffs: ["Preserves the uniform lifecycle"],
        acceptsOther: false,
        decision: "",
      }),
    ]);
    const provider = new ChatNegotiationTurnProvider({
      provider: chat,
      model: "fake-negotiation-model",
      eventLog: events,
    });
    const result = await provider.respond({
      runId: "negotiation-chat-run",
      negotiationId: "negotiation-chat-id",
      side: "proposal",
      round: 1,
      topic: "Choose the integration boundary",
      initialPosition: "Use an outer protocol",
      otherPosition: "Extend stage agents",
      previousRounds: [],
      stage: "ARCH",
    });
    assert.equal(result.position, "Keep the protocol outside stage agents");
    assert.equal(chat.calls[0]?.options.structuredOutput?.name, "forgemind_negotiation_turn_v1");
    const llmCall = (await events.load()).find((event) => event.type === "llm.called");
    assert.ok(llmCall);
    assert.equal(llmCall.data.negotiationId, "negotiation-chat-id");
    assert.equal(llmCall.data.negotiationSide, "proposal");
  });
});

async function protocolFixture(
  proposal: NegotiationTurnProvider,
  counter: NegotiationTurnProvider,
  approvalGateway: AutoApprovalGateway | DenyApprovalGateway,
  timeoutMs = 1_000,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-negotiation-"));
  temporaryDirectories.push(directory);
  const events = await EventLog.create(directory, "negotiation-run");
  return {
    events,
    protocol: new NegotiationProtocol({
      eventLog: events,
      proposal,
      counter,
      approvalGateway,
      timeoutMs,
    }),
  };
}

function request() {
  return {
    runId: "negotiation-run",
    trigger: "arch-conflict" as const,
    topic: "Choose the integration boundary",
    proposal: "Keep negotiation outside stage agents",
    counter: "Extend stage agents",
  };
}

function turn(position: string, acceptsOther = false, decision = ""): NegotiationTurnResult {
  return { position, tradeoffs: ["Concrete tradeoff"], acceptsOther, decision };
}

class QueueTurnProvider implements NegotiationTurnProvider {
  public readonly calls: NegotiationTurnInput[] = [];

  public constructor(private readonly responses: NegotiationTurnResult[]) {}

  public respond(input: NegotiationTurnInput): Promise<NegotiationTurnResult> {
    this.calls.push(input);
    const response = this.responses.shift();
    return response === undefined
      ? Promise.reject(new Error("Turn response queue exhausted"))
      : Promise.resolve(response);
  }
}

class StalledTurnProvider implements NegotiationTurnProvider {
  public respond(_input: NegotiationTurnInput): Promise<NegotiationTurnResult> {
    return new Promise(() => undefined);
  }
}
