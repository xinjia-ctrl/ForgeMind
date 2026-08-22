import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { parseAgenticConfig } from "../../src/agentic/config.js";
import {
  FileAgenticDispatchStore,
  ForgeMindAgenticRunDispatcher,
} from "../../src/agentic/dispatcher.js";
import { AgenticFeedbackCoordinator } from "../../src/agentic/feedback.js";
import { GitHubApiClient } from "../../src/agentic/github.js";
import { FileAgenticStateStore } from "../../src/agentic/state.js";
import { AgenticTriggerEngine } from "../../src/agentic/trigger.js";
import { AgenticWatchService } from "../../src/agentic/watch.js";
import { GitHubWebhookReceiver } from "../../src/agentic/webhook.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import type { RunExecution, RunOptions } from "../../src/runtime/run.js";

it("runs the signed webhook to PR/comment loop exactly once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-agentic-e2e-"));
  try {
    const apiCalls: Array<{ readonly url: string; readonly method: string }> = [];
    const github = new GitHubApiClient({
      token: "token",
      baseUrl: "http://localhost:8080",
      fetcher: (input, init) => {
        const url = requestUrl(input);
        const method = init?.method ?? "GET";
        apiCalls.push({ url, method });
        if (url.includes("/pulls?") && method === "GET") {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.endsWith("/pulls") && method === "POST") {
          return Promise.resolve(
            jsonResponse({ number: 8, html_url: "https://github.example/acme/api/pull/8" }, 201),
          );
        }
        if (url.includes("/comments?") && method === "GET") {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.endsWith("/comments") && method === "POST") {
          return Promise.resolve(
            jsonResponse({ id: 9, html_url: "https://github.example/comment/9" }, 201),
          );
        }
        return Promise.resolve(jsonResponse({ message: "not found" }, 404));
      },
    });
    const config = parseAgenticConfig({
      repositories: ["acme/api"],
      guardrails: { allowedTools: ["read_file"], allowedCommands: [["git", "status"]] },
      rules: [
        {
          id: "fix-agentic-issue",
          match: { type: "issue.updated", source: "github", labelsAll: ["agentic"] },
          run: { requirement: "Implement {{object.title}}", priority: "high" },
          cooldownMs: 60_000,
        },
      ],
    });
    let runs = 0;
    const dispatcher = new ForgeMindAgenticRunDispatcher({
      config,
      provider: new FakeChatProvider([]),
      model: "fake",
      store: new FileAgenticDispatchStore({ directory: path.join(directory, "dispatch") }),
      resolveRepositories: () => [
        { repository: "acme/api", path: "/workspace/api", baseBranch: "main" },
      ],
      feedback: new AgenticFeedbackCoordinator({
        github,
        branchPublisher: { publish: () => Promise.resolve() },
      }),
      run(options) {
        runs += 1;
        return Promise.resolve(execution(options));
      },
    });
    const watch = new AgenticWatchService({
      trigger: new AgenticTriggerEngine({ config }),
      dispatcher,
      stateStore: new FileAgenticStateStore({ filePath: path.join(directory, "watch.json") }),
    });
    const receiver = new GitHubWebhookReceiver({ secret: "secret", watch });
    const body = JSON.stringify({
      action: "edited",
      repository: { full_name: "acme/api" },
      issue: {
        number: 42,
        title: "signed webhook loop",
        updated_at: "2026-08-21T11:00:00Z",
        state: "open",
        labels: [{ name: "agentic" }],
      },
    });
    const headers = {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-e2e-42",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
    };

    const first = await receiver.receive({ headers, body });
    const duplicate = await receiver.receive({ headers, body });
    assert.equal(first.outcome?.decision.kind, "TRIGGER");
    assert.equal(duplicate.outcome?.decision.reason, "duplicate-event");
    assert.equal(runs, 1);
    assert.equal(
      apiCalls.filter((call) => call.method === "POST" && call.url.endsWith("/pulls")).length,
      1,
    );
    assert.equal(
      apiCalls.filter((call) => call.method === "POST" && call.url.endsWith("/comments")).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function execution(options: RunOptions): RunExecution {
  const runId = options.runId ?? "missing";
  return {
    eventLogPath: `/events/${runId}.jsonl`,
    result: {
      status: "SUCCEEDED",
      summary: "Issue fixed",
      context: {
        runId,
        requirement: options.requirement,
        repo: { path: `/worktrees/${runId}`, branch: `forgemind/${runId}` },
        plan: null,
        architecture: null,
        artifacts: [],
        gates: [],
        meta: {
          attempt: { stage: "COMMIT", count: 1 },
          tokenBudget: {
            PLAN: { input: 1, output: 1 },
            ARCH: { input: 1, output: 1 },
            CODE: { input: 1, output: 1 },
            REVIEW: { input: 1, output: 1 },
            TEST: { input: 1, output: 1 },
            COMMIT: { input: 1, output: 1 },
          },
        },
      },
    },
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
