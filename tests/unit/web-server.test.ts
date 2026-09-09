import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  createWebApp,
  parseWebRunRequest,
  progressFromEvents,
  type WebRunExecutorOptions,
} from "../../src/web/server.js";
import type { ForgeMindEvent } from "../../src/core/events.js";
import type { WebRunResult } from "../../src/web/types.js";

describe("ForgeMind local web workspace", () => {
  it("serves the local-only UI, creates a clean demo repository, and bounds concurrent runs", async () => {
    const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "forgemind-web-home-"));
    const resolvedHome = await realpath(homeDirectory);
    let received: WebRunExecutorOptions | undefined;
    let complete: ((result: WebRunResult) => void) | undefined;
    const pending = new Promise<WebRunResult>((resolve) => {
      complete = resolve;
    });
    const server = createWebApp({
      homeDirectory,
      configPath: path.join(homeDirectory, "missing-policy.json"),
      environment: {
        DEEPSEEK_API_KEY: "never-return-this-secret",
        FORGEMIND_PROVIDER: "deepseek",
        FORGEMIND_MODEL: "deepseek-v4-flash",
        FORGEMIND_TEMPERATURE: "0.01",
        FORGEMIND_MAX_REWORK: "8",
        FORGEMIND_STRUCTURED_OUTPUT: "0",
      },
      execute(options) {
        received = options;
        return pending;
      },
    });
    try {
      const page = await localRequest(server, "GET", "/");
      const html = page.body;
      assert.equal(page.status, 200);
      assert.match(html, /ForgeMind 工作台/);
      assert.match(html, /<meta name="color-scheme" content="light">/);
      assert.match(html, /--bg:#f2e8d9/);
      assert.match(html, /--panel:#fffaf2/);
      assert.doesNotMatch(html, /--panel:#ffffff/);
      assert.match(html, /id="provider"/);
      assert.match(html, /list="model-options"/);
      assert.match(html, /模型名称（可输入筛选）/);
      assert.doesNotMatch(html, /id="api-key"/);
      assert.match(page.headers["content-security-policy"] ?? "", /default-src 'none'/);
      assert.doesNotMatch(html, /never-return-this-secret/);

      const defaults = await localJson(server, "GET", "/api/config");
      assert.equal(defaults["providerId"], "deepseek");
      assert.equal(defaults["baseUrl"], "https://api.deepseek.com");
      assert.equal(defaults["model"], "deepseek-v4-flash");
      assert.equal(defaults["temperature"], 0.01);
      assert.equal(defaults["maxRework"], 8);
      assert.equal(defaults["structuredOutput"], false);
      const deepSeek = providerOption(defaults, "deepseek");
      assert.equal(deepSeek["apiKeyEnvironment"], "DEEPSEEK_API_KEY");
      assert.equal(deepSeek["apiKeyConfigured"], true);
      assert.equal(providerOption(defaults, "openai")["apiKeyConfigured"], false);
      assert.ok(modelIds(deepSeek).includes("deepseek-v4-flash"));
      assert.ok(providerIds(defaults).includes("deepseek"));
      assert.ok(providerIds(defaults).includes("dashscope"));
      assert.ok(providerIds(defaults).includes("moonshot"));
      assert.equal(JSON.stringify(defaults).includes("never-return-this-secret"), false);

      const outside = await localRequest(
        server,
        "GET",
        `/api/directories?path=${encodeURIComponent(path.dirname(homeDirectory))}`,
      );
      assert.equal(outside.status, 403);

      const demo = await localJson(server, "POST", "/api/demo-repository", {});
      const demoPath = stringValue(demo["path"]);
      assert.equal(path.dirname(demoPath), resolvedHome);
      const inspection = await localJson(server, "POST", "/api/repositories/inspect", {
        path: demoPath,
      });
      assert.equal(inspection["root"], demoPath);
      assert.equal(inspection["branch"], "main");
      assert.equal(inspection["clean"], true);

      const request = {
        repoPath: demoPath,
        requirement: "Add a subtraction function with tests",
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com/",
        model: "deepseek-v4-flash",
        temperature: 0.01,
        maxRework: 8,
        structuredOutput: true,
        memory: false,
        approveAll: true,
      };
      const startedResponse = await localRequest(server, "POST", "/api/runs", request);
      assert.equal(startedResponse.status, 202);
      const started = parseRecord(startedResponse.body);
      assert.equal(started["status"], "RUNNING");
      assert.ok(received);
      assert.equal(received.request.providerId, "deepseek");
      assert.equal(received.request.apiKey, "never-return-this-secret");
      assert.equal(received.request.baseUrl, "https://api.deepseek.com");
      assert.equal(received.request.structuredOutput, true);
      assert.equal(received.request.maxRework, 8);
      assert.equal(received.request.configPath, undefined);
      assert.equal(JSON.stringify(started).includes("never-return-this-secret"), false);

      const duplicate = await localRequest(server, "POST", "/api/runs", request);
      assert.equal(duplicate.status, 409);

      complete?.({
        status: "SUCCEEDED",
        summary: "Demo change complete",
        branch: "forgemind/demo",
        eventLogPath: "/tmp/demo-events.jsonl",
      });
      const runId = stringValue(started["id"]);
      const finished = await waitForFinished(server, `/api/runs/${encodeURIComponent(runId)}`);
      assert.equal(finished["status"], "SUCCEEDED");
      assert.equal(finished["summary"], "Demo change complete");
      assert.equal(finished["branch"], "forgemind/demo");
      assert.equal(finished["reportAvailable"], false);
      assert.equal(JSON.stringify(finished).includes("never-return-this-secret"), false);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("strictly parses local web run configuration without exposing the environment key", () => {
    const parsed = parseWebRunRequest(
      {
        repoPath: "/tmp/repo",
        requirement: "Fix tests",
        providerId: "custom",
        baseUrl: "https://example.test/v1/",
        model: "model",
        temperature: 0.25,
        maxRework: 9,
        structuredOutput: false,
        memory: true,
        approveAll: true,
      },
      { OPENAI_API_KEY: "environment-secret" },
      "/tmp/policy.json",
    );
    assert.equal(parsed.apiKey, "environment-secret");
    assert.equal(parsed.providerId, "custom");
    assert.equal(parsed.baseUrl, "https://example.test/v1");
    assert.equal(parsed.temperature, 0.25);
    assert.equal(parsed.maxRework, 9);
    assert.equal(parsed.configPath, "/tmp/policy.json");
    const browserRequest = {
      repoPath: parsed.repoPath,
      requirement: parsed.requirement,
      providerId: parsed.providerId,
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      maxRework: parsed.maxRework,
      structuredOutput: parsed.structuredOutput,
      memory: parsed.memory,
      approveAll: parsed.approveAll,
    };
    assert.throws(
      () => parseWebRunRequest({ ...browserRequest, merge: true }, {}),
      /未知配置字段：merge/,
    );
    assert.throws(
      () => parseWebRunRequest({ ...browserRequest, apiKey: "browser-secret" }, {}),
      /未知配置字段：apiKey/,
    );
    assert.throws(
      () => parseWebRunRequest({ ...browserRequest, baseUrl: "file:///tmp/api" }, {}),
      /http/,
    );
    assert.throws(
      () =>
        parseWebRunRequest(
          { ...browserRequest, maxRework: 11.5 },
          { OPENAI_API_KEY: "environment-secret" },
        ),
      /整数/,
    );
    assert.throws(
      () =>
        parseWebRunRequest(
          { ...browserRequest, maxRework: 13 },
          { OPENAI_API_KEY: "environment-secret" },
        ),
      /0 到 12/,
    );
  });

  it("resolves provider-specific backend keys and rejects a missing selected-provider key", () => {
    const request = {
      repoPath: "/tmp/repo",
      requirement: "Fix tests",
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      temperature: 0,
      maxRework: 6,
      structuredOutput: true,
      memory: false,
      approveAll: true,
    };
    const parsed = parseWebRunRequest(request, {
      OPENAI_API_KEY: "openai-secret",
      DEEPSEEK_API_KEY: "deepseek-secret",
    });
    assert.equal(parsed.apiKey, "deepseek-secret");
    assert.equal(parsed.baseUrl, "https://api.deepseek.com");
    assert.throws(
      () => parseWebRunRequest(request, { OPENAI_API_KEY: "openai-secret" }),
      /DEEPSEEK_API_KEY/,
    );
    assert.throws(
      () => parseWebRunRequest({ ...request, baseUrl: "https://example.test/v1" }, {}),
      /自定义/,
    );
  });

  it("projects live stage progress from the shared EventLog contract", () => {
    const events = [
      event(1, "stage.started", { runId: "web-progress", stage: "PLAN", attempt: 1 }),
      event(2, "stage.completed", {
        runId: "web-progress",
        stage: "PLAN",
        status: "SUCCEEDED",
      }),
      event(3, "stage.started", { runId: "web-progress", stage: "ARCH", attempt: 1 }),
    ];
    assert.deepEqual(progressFromEvents(events), {
      stage: "ARCH",
      completedStages: ["PLAN"],
    });
  });
});

function event<T extends ForgeMindEvent["type"]>(
  seq: number,
  type: T,
  data: Extract<ForgeMindEvent, { readonly type: T }>["data"],
): Extract<ForgeMindEvent, { readonly type: T }> {
  return { v: 1, seq, ts: `2026-08-22T00:00:0${seq}.000Z`, type, data } as Extract<
    ForgeMindEvent,
    { readonly type: T }
  >;
}

async function waitForFinished(server: Server, url: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await localJson(server, "GET", url);
    if (result["status"] !== "RUNNING") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Web run did not finish in time");
}

interface LocalResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

async function localJson(
  server: Server,
  method: string,
  url: string,
  value?: unknown,
): Promise<Record<string, unknown>> {
  const response = await localRequest(server, method, url, value);
  assert.ok(response.status >= 200 && response.status < 300, response.body);
  return parseRecord(response.body);
}

async function localRequest(
  server: Server,
  method: string,
  url: string,
  value?: unknown,
): Promise<LocalResponse> {
  const body = value === undefined ? "" : JSON.stringify(value);
  const request = Object.assign(Readable.from(body.length === 0 ? [] : [Buffer.from(body)]), {
    method,
    url,
    headers: { "content-type": "application/json" },
  });
  return await new Promise<LocalResponse>((resolve) => {
    let status = 200;
    let headers: Record<string, string> = {};
    let responseBody = "";
    const response = {
      writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
        status = nextStatus;
        headers = nextHeaders;
        return this;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) responseBody += chunk.toString();
        resolve({ status, headers, body: responseBody });
        return this;
      },
    };
    server.emit("request", request, response);
  });
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  assert.equal(typeof parsed, "object");
  assert.ok(parsed !== null && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function providerIds(defaults: Record<string, unknown>): string[] {
  const providers = defaults["providers"];
  assert.ok(Array.isArray(providers));
  return providers.map((provider) => stringValue(objectRecord(provider)["id"]));
}

function providerOption(
  defaults: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> {
  const providers = defaults["providers"];
  assert.ok(Array.isArray(providers));
  const provider = providers.map(objectRecord).find((candidate) => candidate["id"] === providerId);
  assert.ok(provider);
  return provider;
}

function modelIds(provider: Record<string, unknown>): string[] {
  const models = provider["models"];
  assert.ok(Array.isArray(models));
  return models.map((model) => stringValue(objectRecord(model)["id"]));
}

function objectRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
