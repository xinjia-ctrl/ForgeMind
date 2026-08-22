import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseAgenticConfig } from "../../src/agentic/config.js";
import {
  AgenticDispatchInProgressError,
  FileAgenticDispatchStore,
  ForgeMindAgenticRunDispatcher,
} from "../../src/agentic/dispatcher.js";
import type { AgenticFeedbackPublisher } from "../../src/agentic/feedback.js";
import type { AgenticRunRequest } from "../../src/agentic/types.js";
import type { DagRunExecution, DagRunOptions } from "../../src/dag/run.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import type { RunExecution, RunOptions } from "../../src/runtime/run.js";

describe("idempotent agentic run dispatcher", () => {
  it("does not rerun a completed request when feedback is retried after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-dispatch-"));
    try {
      let runs = 0;
      let feedbackAttempts = 0;
      const feedback: AgenticFeedbackPublisher = {
        publish() {
          feedbackAttempts += 1;
          return feedbackAttempts === 1
            ? Promise.reject(new Error("feedback unavailable"))
            : Promise.resolve();
        },
      };
      const createDispatcher = () =>
        new ForgeMindAgenticRunDispatcher({
          config: config(),
          provider: new FakeChatProvider([]),
          model: "fake",
          store: new FileAgenticDispatchStore({ directory }),
          resolveRepositories: () => [target("acme/api", "/workspace/api")],
          feedback,
          run(options) {
            runs += 1;
            return Promise.resolve(singleExecution(options, "Implemented fix"));
          },
        });

      await assert.rejects(() => createDispatcher().dispatch(request()), /feedback unavailable/);
      const recovered = await createDispatcher().dispatch(request());
      const cached = await createDispatcher().dispatch(request());
      assert.equal(recovered.runId, cached.runId);
      assert.equal(runs, 1);
      assert.equal(feedbackAttempts, 2);
      assert.equal(recovered.pullRequests[0]?.head, `forgemind/${recovered.runId}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records known failures and retries with a new attempt run id", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-dispatch-retry-"));
    try {
      const runIds: string[] = [];
      const dispatcher = new ForgeMindAgenticRunDispatcher({
        config: config(),
        provider: new FakeChatProvider([]),
        model: "fake",
        store: new FileAgenticDispatchStore({ directory }),
        resolveRepositories: () => [target("acme/api", "/workspace/api")],
        run(options) {
          runIds.push(options.runId ?? "");
          return runIds.length === 1
            ? Promise.reject(new Error("model timeout"))
            : Promise.resolve(singleExecution(options, "Recovered"));
        },
      });
      await assert.rejects(() => dispatcher.dispatch(request()), /model timeout/);
      const result = await dispatcher.dispatch(request());
      assert.equal(runIds.length, 2);
      assert.equal(runIds[1], `${runIds[0]}-2`);
      assert.equal(result.status, "SUCCEEDED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes multi-repository requests to DAG execution with logical authorization", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-dispatch-dag-"));
    try {
      let received: DagRunOptions | undefined;
      const dispatcher = new ForgeMindAgenticRunDispatcher({
        config: config(["acme/api", "acme/web"]),
        provider: new FakeChatProvider([]),
        model: "fake",
        store: new FileAgenticDispatchStore({ directory }),
        resolveRepositories: () => [
          target("acme/api", "/workspace/api"),
          target("acme/web", "/workspace/web"),
        ],
        runDag(options) {
          received = options;
          return Promise.resolve(dagExecution(options));
        },
      });
      const receipt = await dispatcher.dispatch(request());
      assert.equal(receipt.mode, "dag");
      assert.ok(received);
      assert.deepEqual(received.authorizationRepositories, ["acme/api", "acme/web"]);
      assert.deepEqual(received.toolAllowlist, ["read_file"]);
      assert.deepEqual(received.commandAllowlist, [["git", "status"]]);
      assert.equal(receipt.pullRequests[0]?.repository, "acme/api");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on an ambiguous RUNNING record", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-dispatch-running-"));
    try {
      const store = new FileAgenticDispatchStore({ directory });
      const current = request();
      const fingerprint = await fingerprintByClaim(store, current);
      const dispatcher = new ForgeMindAgenticRunDispatcher({
        config: config(),
        provider: new FakeChatProvider([]),
        model: "fake",
        store,
        resolveRepositories: () => [target("acme/api", "/workspace/api")],
        run: (options) => Promise.resolve(singleExecution(options, "should not run")),
      });
      await assert.rejects(
        () => dispatcher.dispatch(current),
        (error: unknown) =>
          error instanceof AgenticDispatchInProgressError && error.runId === fingerprint,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function fingerprintByClaim(
  store: FileAgenticDispatchStore,
  current: AgenticRunRequest,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const canonical = canonicalJson(current);
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  const claim = await store.claim(current.id, fingerprint, "ambiguous-run");
  assert.equal(claim.kind, "claimed");
  return claim.record.runId;
}

function config(repositories: readonly string[] = ["acme/api"]) {
  return parseAgenticConfig({
    repositories,
    guardrails: {
      allowedTools: ["read_file"],
      allowedCommands: [["git", "status"]],
    },
    rules: [
      {
        id: "diagnose",
        match: { type: "ci.failed" },
        run: { requirement: "Fix the failing build", priority: "high" },
        cooldownMs: 60_000,
      },
    ],
  });
}

function request(): AgenticRunRequest {
  return {
    id: "diagnose:github:delivery-7",
    actor: "agentic",
    repository: "acme/api",
    requirement: "Fix the failing build",
    priority: "high",
    ruleId: "diagnose",
    sourceEventIds: ["github:delivery-7"],
    triggeredAt: "2026-08-21T10:00:00.000Z",
    origin: {
      source: "github",
      type: "ci.failed",
      object: { kind: "workflow", id: "77", title: "CI" },
      context: { pullRequestNumber: "42" },
    },
  };
}

function target(repository: string, repositoryPath: string) {
  return { repository, path: repositoryPath, baseBranch: "main" } as const;
}

function singleExecution(options: RunOptions, summary: string): RunExecution {
  const runId = options.runId ?? "missing-run";
  return {
    eventLogPath: `/events/${runId}.jsonl`,
    result: {
      status: "SUCCEEDED",
      summary,
      context: {
        runId,
        requirement: options.requirement,
        repo: { path: `/worktrees/${runId}`, branch: `forgemind/${runId}` },
        plan: null,
        architecture: null,
        artifacts: [],
        gates: [],
        meta: {
          attempt: { stage: "PLAN", count: 1 },
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

function dagExecution(options: DagRunOptions): DagRunExecution {
  const runId = options.parentRunId ?? "missing-run";
  return {
    eventLogPath: `/events/${runId}.jsonl`,
    plan: {
      summary: "Cross repository change",
      tasks: [{ taskId: "api", deps: [], repo: "/workspace/api", requirement: "Update API" }],
    },
    result: {
      parentRunId: runId,
      status: "SUCCEEDED",
      tasks: [],
      decisionRecords: [],
      prList: [
        {
          taskId: "api",
          repo: "/workspace/api",
          branch: `forgemind/${runId}-api`,
          requirement: "Update API",
          summary: "API updated",
        },
      ],
    },
    workspaces: [
      {
        taskId: "api",
        repo: "/workspace/api",
        root: `/worktrees/${runId}-api`,
        branch: `forgemind/${runId}-api`,
      },
    ],
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
