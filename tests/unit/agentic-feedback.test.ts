import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HttpCiFeedbackClient } from "../../src/agentic/ci.js";
import type { AgenticExecutionReceipt } from "../../src/agentic/dispatcher.js";
import { AgenticFeedbackCoordinator } from "../../src/agentic/feedback.js";
import type { ExternalAction, ExternalActionGovernor } from "../../src/agentic/external-action.js";
import { ApprovalExternalActionGovernor } from "../../src/agentic/external-action.js";
import { GitHubApiClient } from "../../src/agentic/github.js";
import { JiraApiClient } from "../../src/agentic/jira.js";
import type { AgenticRunRequest } from "../../src/agentic/types.js";
import { EventLog } from "../../src/core/event-log.js";
import { AutoApprovalGateway } from "../../src/policy/auto-gateway.js";

describe("agentic feedback", () => {
  it("pushes a safe branch, creates a PR, and idempotently comments on GitHub", async () => {
    const calls: Array<{ readonly url: string; readonly method: string; readonly body?: unknown }> =
      [];
    let createdPullRequest: unknown;
    let createdComment: unknown;
    const fetcher: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      const body = optionalParsedBody(init);
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.includes("/pulls?") && method === "GET") {
        return Promise.resolve(
          jsonResponse(createdPullRequest === undefined ? [] : [createdPullRequest]),
        );
      }
      if (url.endsWith("/pulls") && method === "POST") {
        createdPullRequest = { number: 12, html_url: "https://github.example/acme/api/pull/12" };
        return Promise.resolve(jsonResponse(createdPullRequest, 201));
      }
      if (url.includes("/comments?") && method === "GET") {
        return Promise.resolve(jsonResponse(createdComment === undefined ? [] : [createdComment]));
      }
      if (url.endsWith("/comments") && method === "POST") {
        const commentBody = body as { readonly body: string };
        createdComment = {
          id: 99,
          html_url: "https://github.example/comment/99",
          body: commentBody.body,
        };
        return Promise.resolve(jsonResponse(createdComment, 201));
      }
      return Promise.resolve(jsonResponse({ message: "not found" }, 404));
    };
    const published: string[] = [];
    const coordinator = new AgenticFeedbackCoordinator({
      github: new GitHubApiClient({
        token: "token",
        baseUrl: "http://localhost:8080",
        fetcher,
      }),
      branchPublisher: {
        publish(candidate) {
          published.push(candidate.head);
          return Promise.resolve();
        },
        verify: () => Promise.resolve(true),
      },
      governor: allowGovernor(),
    });
    const currentRequest = request("github");
    const currentReceipt = receipt();
    await coordinator.publish(currentRequest, currentReceipt);
    await coordinator.publish(currentRequest, currentReceipt);

    assert.deepEqual(published, ["forgemind/run-7", "forgemind/run-7"]);
    assert.equal(
      calls.filter((call) => call.method === "POST" && call.url.endsWith("/pulls")).length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.method === "POST" && call.url.endsWith("/comments")).length,
      1,
    );
    const pullCreate = calls.find((call) => call.method === "POST" && call.url.endsWith("/pulls"));
    assert.deepEqual(pullCreate?.body, {
      title: "Fix CI",
      head: "forgemind/run-7",
      base: "main",
      body: "Automated fix",
      draft: false,
    });
  });

  it("writes Jira ADF comments and posts generic CI feedback", async () => {
    const jiraCalls: Array<{
      readonly url: string;
      readonly method: string;
      readonly body?: unknown;
    }> = [];
    let jiraComment: unknown;
    const jiraFetcher: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      const body = optionalParsedBody(init);
      jiraCalls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (method === "GET")
        return Promise.resolve(
          jsonResponse({ comments: jiraComment === undefined ? [] : [jiraComment] }),
        );
      jiraComment = { id: "10001", body };
      return Promise.resolve(jsonResponse({ id: "10001" }, 201));
    };
    const jira = new AgenticFeedbackCoordinator({
      jira: new JiraApiClient({
        baseUrl: "http://localhost:8080",
        authentication: { bearerToken: "token" },
        fetcher: jiraFetcher,
      }),
      governor: allowGovernor(),
    });
    await jira.publish(request("jira"), { ...receipt(), pullRequests: [] });
    const jiraPost = jiraCalls.find((call) => call.method === "POST");
    assert.match(jiraPost?.url ?? "", /\/rest\/api\/3\/issue\/FM-7\/comment$/);
    assert.match(JSON.stringify(jiraPost?.body), /ForgeMind run/);

    const ciCalls: Array<{ readonly headers: Headers; readonly body: unknown }> = [];
    const ciClient = new HttpCiFeedbackClient({
      endpoint: "http://localhost:8080/build-comment",
      token: "ci-token",
      fetcher: (_input, init) => {
        const body = optionalParsedBody(init);
        assert.notEqual(body, undefined);
        ciCalls.push({
          headers: new Headers(init?.headers),
          body,
        });
        return Promise.resolve(jsonResponse({ accepted: true }, 202));
      },
    });
    const ci = new AgenticFeedbackCoordinator({ ci: ciClient, governor: allowGovernor() });
    await ci.publish(request("ci"), { ...receipt(), pullRequests: [] });
    const ciCall = ciCalls[0];
    assert.ok(ciCall);
    assert.equal(ciCall.headers.get("idempotency-key"), "diagnose:event-7:feedback");
    assert.equal(ciCall.headers.get("authorization"), "Bearer ci-token");
  });

  it("refuses to publish test as a source branch", async () => {
    const coordinator = new AgenticFeedbackCoordinator({});
    await assert.rejects(
      () =>
        coordinator.publish(request("github"), {
          ...receipt(),
          pullRequests: [{ ...receipt().pullRequests[0]!, head: "test" }],
        }),
      /test branch/,
    );
  });

  it("approves, verifies, and audits external actions through the shared event contract", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-external-action-"));
    try {
      const eventLog = await EventLog.create(directory, "external-action-run");
      const governor = new ApprovalExternalActionGovernor({
        approvalGateway: new AutoApprovalGateway(),
      });
      const result = await governor.execute({
        runId: "external-action-run",
        eventLog,
        tool: "external_push",
        args: { head: "forgemind/run" },
        target: "acme/api:forgemind/run",
        idempotencyKey: "push-1",
        risk: "high",
        execute: () => Promise.resolve("commit-1"),
        verify: (commit) => Promise.resolve(commit === "commit-1"),
      });
      assert.equal(result, "commit-1");
      const events = await eventLog.load();
      assert.deepEqual(
        events.map((event) => event.type),
        ["approval.requested", "approval.approved", "tool.called"],
      );
      const tool = events[2];
      assert.equal(tool?.type, "tool.called");
      assert.deepEqual(tool.data.result, {
        ok: true,
        verified: true,
        target: "acme/api:forgemind/run",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function allowGovernor(): ExternalActionGovernor {
  return {
    async execute<T>(action: ExternalAction<T>): Promise<T> {
      const result = await action.execute();
      assert.equal(await action.verify(result), true);
      return result;
    },
  };
}

function request(source: "github" | "jira" | "ci"): AgenticRunRequest {
  return {
    id: "diagnose:event-7",
    actor: "agentic",
    repository: "acme/api",
    requirement: "Fix CI",
    priority: "high",
    ruleId: "diagnose",
    sourceEventIds: ["event-7"],
    triggeredAt: "2026-08-21T10:00:00.000Z",
    origin: {
      source,
      type: source === "ci" ? "ci.failed" : "issue.updated",
      object:
        source === "jira"
          ? { kind: "issue", id: "FM-7" }
          : source === "ci"
            ? { kind: "workflow", id: "build-7" }
            : { kind: "issue", id: "42" },
      context: {},
    },
  };
}

function receipt(): AgenticExecutionReceipt {
  return {
    runId: "run-7",
    mode: "single",
    status: "SUCCEEDED",
    summary: "CI fixed",
    pullRequests: [
      {
        repository: "acme/api",
        localPath: "/workspace/api",
        head: "forgemind/run-7",
        base: "main",
        title: "Fix CI",
        body: "Automated fix",
      },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function optionalParsedBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") throw new Error("Expected a string request body");
  return JSON.parse(body) as unknown;
}
