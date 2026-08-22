import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  CiWebhookReceiver,
  GitHubWebhookReceiver,
  JiraWebhookReceiver,
  WebhookRequestError,
  verifyWebhookHmac,
} from "../../src/agentic/webhook.js";
import type { DevelopmentEvent } from "../../src/agentic/types.js";
import type { AgenticWatchOutcome } from "../../src/agentic/watch.js";

describe("agentic webhook receivers", () => {
  it("matches the published SHA-256 HMAC vectors over raw bytes", () => {
    const secret = "It's a Secret to Everybody";
    assert.equal(
      verifyWebhookHmac(
        "Hello, World!",
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        secret,
      ),
      true,
    );
    assert.equal(
      verifyWebhookHmac(
        "Hello World!",
        "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
        secret,
      ),
      true,
    );
    assert.equal(
      verifyWebhookHmac(
        "Hello World! ",
        "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
        secret,
      ),
      false,
    );
  });

  it("authenticates and normalizes GitHub deliveries before dispatch", async () => {
    const secret = "github-secret";
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/api" },
      sender: { login: "octocat" },
      issue: {
        number: 42,
        title: "Broken build",
        state: "open",
        updated_at: "2026-08-21T08:00:00Z",
        labels: [{ name: "agentic" }],
      },
    });
    const events: DevelopmentEvent[] = [];
    const receiver = new GitHubWebhookReceiver({
      secret,
      watch: capturingWatch(events),
      now: () => new Date("2026-08-21T08:01:00Z"),
    });
    const result = await receiver.receive({
      headers: {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-42",
        "X-Hub-Signature-256": signature(body, secret),
      },
      body,
    });
    assert.equal(result.accepted, true);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.id, "github:delivery-42");
    assert.equal(event.object.id, "42");
    assert.equal(event.repo, "acme/api");

    await assert.rejects(
      () =>
        receiver.receive({
          headers: {
            "x-github-event": "issues",
            "x-github-delivery": "delivery-43",
            "x-hub-signature-256": signature(body, secret),
          },
          body: `${body} `,
        }),
      (error: unknown) => error instanceof WebhookRequestError && error.statusCode === 401,
    );
  });

  it("namespaces stable Jira retry identifiers and supports configurable CI headers", async () => {
    const jiraEvents: DevelopmentEvent[] = [];
    const jiraBody = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      issue: {
        key: "FM-7",
        fields: {
          summary: "Fix the API",
          updated: "2026-08-21T09:00:00Z",
          status: { name: "Open" },
          labels: ["agentic"],
        },
      },
    });
    const jira = new JiraWebhookReceiver({
      secret: "jira-secret",
      repository: "acme/api",
      tenant: "acme.atlassian.net",
      watch: capturingWatch(jiraEvents),
    });
    await jira.receive({
      headers: {
        "x-atlassian-webhook-identifier": "retry-stable-id",
        "x-hub-signature": signature(jiraBody, "jira-secret"),
      },
      body: jiraBody,
    });
    assert.equal(jiraEvents[0]?.id, "jira:acme.atlassian.net:retry-stable-id");

    const ciEvents: DevelopmentEvent[] = [];
    const ciBody = JSON.stringify({
      id: "build-9",
      status: "failed",
      repository: "acme/api",
      updatedAt: "2026-08-21T09:01:00Z",
    });
    const ci = new CiWebhookReceiver({
      secret: "ci-secret",
      watch: capturingWatch(ciEvents),
      signatureHeader: "x-build-signature",
      deliveryHeader: "x-build-delivery",
    });
    await ci.receive({
      headers: {
        "x-build-signature": signature(ciBody, "ci-secret"),
        "x-build-delivery": "build-delivery-9",
      },
      body: ciBody,
    });
    assert.equal(ciEvents[0]?.id, "ci:build-delivery-9");
  });
});

function capturingWatch(events: DevelopmentEvent[]): {
  accept(event: DevelopmentEvent): Promise<AgenticWatchOutcome>;
} {
  return {
    accept(event) {
      events.push(event);
      return Promise.resolve({
        decision: { kind: "IGNORE", reason: "no-matching-rule", event },
      });
    },
  };
}

function signature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
