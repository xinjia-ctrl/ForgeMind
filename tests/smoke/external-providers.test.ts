import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { OpenAICompatibleChatProvider } from "../../src/llm/openai-compatible-provider.js";
import { detectContainerRuntime } from "../../src/sandbox/detect.js";
import { ContainerProcessRunner } from "../../src/sandbox/docker.js";

it("executes a command inside a real pinned container", { timeout: 180_000 }, async (context) => {
  const image = process.env["FORGEMIND_SMOKE_CONTAINER_IMAGE"];
  if (image === undefined) {
    skipOrFail(context, "FORGEMIND_SMOKE_CONTAINER_IMAGE is not configured");
    return;
  }
  const requested = containerRuntime(process.env["FORGEMIND_SMOKE_CONTAINER_RUNTIME"]);
  let runtime: "docker" | "podman";
  try {
    runtime = await detectContainerRuntime(requested);
  } catch {
    skipOrFail(context, `No usable ${requested} container runtime is available`);
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-container-smoke-"));
  try {
    const runner = new ContainerProcessRunner({
      runtime,
      image,
      cpu: 1,
      memoryMb: 256,
      pidsLimit: 64,
      network: false,
    });
    const result = await runner.run(
      { command: "node", args: ["-e", "process.stdout.write('FORGEMIND_CONTAINER_OK')"] },
      { cwd: directory, timeoutMs: 60_000, maxBytes: 8_000 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "FORGEMIND_CONTAINER_OK");
    assert.ok(result.sandbox);
    assert.equal(result.sandbox.mode, "container");
    assert.equal(result.sandbox.network, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("calls a real external chat model", { timeout: 180_000 }, async (context) => {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = process.env["FORGEMIND_SMOKE_MODEL"] ?? process.env["FORGEMIND_MODEL"];
  if (apiKey === undefined || model === undefined) {
    skipOrFail(context, "OPENAI_API_KEY and FORGEMIND_SMOKE_MODEL are not configured");
    return;
  }
  const provider = new OpenAICompatibleChatProvider({
    apiKey,
    ...(process.env["OPENAI_BASE_URL"] === undefined
      ? {}
      : { baseUrl: process.env["OPENAI_BASE_URL"] }),
    timeoutMs: 120_000,
  });
  const completion = await provider.complete(
    [
      {
        role: "user",
        content: "Reply with exactly FORGEMIND_MODEL_OK and no other text.",
      },
    ],
    { model, temperature: 0, maxOutputTokens: 32 },
  );
  assert.match(completion.content.trim(), /^FORGEMIND_MODEL_OK$/);
});

function containerRuntime(value: string | undefined): "docker" | "podman" | "auto" {
  if (value === undefined || value === "auto") return "auto";
  if (value === "docker" || value === "podman") return value;
  throw new Error("FORGEMIND_SMOKE_CONTAINER_RUNTIME must be docker, podman, or auto");
}

function skipOrFail(context: { skip(message: string): void }, message: string): void {
  if (process.env["FORGEMIND_REQUIRE_EXTERNAL_SMOKE"] === "1") throw new Error(message);
  context.skip(message);
}
