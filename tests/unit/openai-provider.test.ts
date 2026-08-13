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
});
