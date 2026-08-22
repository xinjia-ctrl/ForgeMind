import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HardFailure, StageFailure } from "../../src/core/errors.js";
import { OpenAICompatibleEmbeddingProvider } from "../../src/memory/openai-compatible-embedding-provider.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI-compatible embedding provider", () => {
  it("calls the external embeddings contract and validates its dimension", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = (input, init) => {
      requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
        }),
      );
    };
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "test",
      model: "embedding-model",
      dimension: 3,
      baseUrl: "https://model.example/v1/",
    });

    assert.deepEqual(await provider.embed("semantic memory"), [0.1, 0.2, 0.3]);
    assert.equal(requestUrl, "https://model.example/v1/embeddings");
    assert.deepEqual(JSON.parse(requestBody), {
      model: "embedding-model",
      input: "semantic memory",
      encoding_format: "float",
    });
  });

  it("fails closed for bad configuration, HTTP errors, and malformed vectors", async () => {
    assert.throws(
      () =>
        new OpenAICompatibleEmbeddingProvider({
          apiKey: "test",
          model: "model",
          dimension: 0,
        }),
      HardFailure,
    );
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "test",
      model: "model",
      dimension: 2,
    });
    globalThis.fetch = () => Promise.resolve(new Response("unavailable", { status: 503 }));
    await assert.rejects(() => provider.embed("x"), /HTTP 503/);

    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }),
      );
    await assert.rejects(() => provider.embed("x"), StageFailure);
  });
});
