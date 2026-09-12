import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { OpenAICompatibleChatProvider } from "../../src/llm/openai-compatible-provider.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI-compatible structured output", () => {
  it("sends a strict json_schema response format", async () => {
    let requestBody = "";
    globalThis.fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
          { status: 200 },
        ),
      );
    };
    const provider = new OpenAICompatibleChatProvider({ apiKey: "test" });
    const completion = await provider.complete([{ role: "user", content: "x" }], {
      model: "model",
      temperature: 0,
      maxOutputTokens: 100,
      structuredOutput: {
        name: "test_schema",
        jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    assert.equal(completion.content, '{"ok":true}');
    const body = JSON.parse(requestBody) as { response_format?: { type?: string } };
    assert.equal(body.response_format?.type, "json_schema");
  });

  it("marks schema support unavailable after a 400 without retrying", async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "unsupported response_format" } }), {
          status: 400,
        }),
      );
    };
    const provider = new OpenAICompatibleChatProvider({ apiKey: "test" });
    await assert.rejects(
      () =>
        provider.complete([{ role: "user", content: "x" }], {
          model: "model",
          temperature: 0,
          maxOutputTokens: 100,
          structuredOutput: { name: "test", jsonSchema: { type: "object" } },
        }),
      /HTTP 400/,
    );
    assert.equal(calls, 1);
    assert.equal(provider.supportsStructuredOutput, false);
  });

  it("returns parseable content from a structured-output rejection without retrying", async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
          { status: 400 },
        ),
      );
    };
    const provider = new OpenAICompatibleChatProvider({ apiKey: "test" });
    const completion = await provider.complete([{ role: "user", content: "x" }], {
      model: "model",
      temperature: 0,
      maxOutputTokens: 100,
      structuredOutput: { name: "test", jsonSchema: { type: "object" } },
    });

    assert.match(completion.content, /"ok":true/);
    assert.equal(calls, 1);
    assert.equal(provider.supportsStructuredOutput, false);
  });

  it("supports an explicit provider temperature override", async () => {
    let requestBody = "";
    globalThis.fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        }),
      );
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test",
      structuredOutput: false,
      temperatureOverride: 0.01,
    });
    await provider.complete([{ role: "user", content: "x" }], {
      model: "model",
      temperature: 0,
      maxOutputTokens: 100,
    });
    const body = JSON.parse(requestBody) as {
      temperature?: number;
      response_format?: unknown;
    };
    assert.equal(body.temperature, 0.01);
    assert.equal(body.response_format, undefined);
  });

  it("uses non-thinking JSON output for the official DeepSeek V4.1 endpoint", async () => {
    let requestBody = "";
    globalThis.fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
          }),
          { status: 200 },
        ),
      );
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
    });
    await provider.complete([{ role: "user", content: "return json" }], {
      model: "deepseek-flash",
      temperature: 0,
      maxOutputTokens: 100,
      structuredOutput: {
        name: "test_schema",
        jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    const body = JSON.parse(requestBody) as {
      thinking?: { type?: string };
      response_format?: { type?: string; json_schema?: unknown };
    };
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("uses non-thinking JSON output for supported GLM models on the official BigModel endpoint", async () => {
    let requestBody = "";
    globalThis.fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
          }),
          { status: 200 },
        ),
      );
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    });
    await provider.complete([{ role: "user", content: "return json" }], {
      model: "glm-4.7-flash",
      temperature: 0,
      maxOutputTokens: 100,
      structuredOutput: {
        name: "test_schema",
        jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    const body = JSON.parse(requestBody) as {
      thinking?: { type?: string };
      response_format?: { type?: string; json_schema?: unknown };
    };
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("uses JSON Object without provider-specific thinking fields for Qwen on DashScope", async () => {
    let requestBody = "";
    globalThis.fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
          }),
          { status: 200 },
        ),
      );
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    await provider.complete([{ role: "user", content: "return json" }], {
      model: "qwen3.8-max",
      temperature: 0,
      maxOutputTokens: 100,
      structuredOutput: {
        name: "test_schema",
        jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    const body = JSON.parse(requestBody) as {
      thinking?: unknown;
      response_format?: { type?: string; json_schema?: unknown };
    };
    assert.equal(body.thinking, undefined);
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("fails clearly when the provider reports a truncated completion", async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: '{"ok":' } }],
            usage: { prompt_tokens: 3, completion_tokens: 100 },
          }),
          { status: 200 },
        ),
      );
    const provider = new OpenAICompatibleChatProvider({ apiKey: "test" });
    await assert.rejects(
      () =>
        provider.complete([{ role: "user", content: "x" }], {
          model: "model",
          temperature: 0,
          maxOutputTokens: 100,
        }),
      /truncated at the maximum output token limit/,
    );
  });

  it("rejects an invalid provider temperature override", () => {
    assert.throws(
      () => new OpenAICompatibleChatProvider({ apiKey: "test", temperatureOverride: 3 }),
      /between 0 and 2/,
    );
  });

  it("retries a transient rate limit and returns the later completion", async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        }),
      );
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test",
      retryAttempts: 2,
      retryDelayMs: 0,
    });

    const completion = await provider.complete([{ role: "user", content: "x" }], {
      model: "model",
      temperature: 0,
      maxOutputTokens: 100,
    });

    assert.equal(completion.content, "ok");
    assert.equal(calls, 2);
  });

  it("retries a temporary provider resource interruption", async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              calls === 1
                ? { finish_reason: "insufficient_system_resource", message: { content: "" } }
                : { finish_reason: "stop", message: { content: "recovered" } },
            ],
          }),
          { status: 200 },
        ),
      );
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test",
      retryAttempts: 1,
      retryDelayMs: 0,
    });

    const completion = await provider.complete([{ role: "user", content: "x" }], {
      model: "model",
      temperature: 0,
      maxOutputTokens: 100,
    });

    assert.equal(completion.content, "recovered");
    assert.equal(calls, 2);
  });

  it("does not retry a permanent authentication failure", async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }),
      );
    };
    const provider = new OpenAICompatibleChatProvider({
      apiKey: "test",
      retryAttempts: 2,
      retryDelayMs: 0,
    });

    await assert.rejects(
      () =>
        provider.complete([{ role: "user", content: "x" }], {
          model: "model",
          temperature: 0,
          maxOutputTokens: 100,
        }),
      /HTTP 401 after 1 attempt/,
    );
    assert.equal(calls, 1);
  });
});
