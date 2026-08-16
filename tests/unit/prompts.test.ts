import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { supportsStructuredOutput } from "../../src/llm/capabilities.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { interpolatePrompt, loadPrompt, structuredOutputFor } from "../../src/prompts/index.js";

describe("prompt governance", () => {
  it("loads versioned five-section prompt resources and interpolates bounded variables", async () => {
    const prompt = await loadPrompt("CODE", { maxOperations: "30" });
    assert.equal(prompt.version, "code.v1");
    for (const heading of [
      "角色与职责",
      "输入契约摘要",
      "约束与边界",
      "输出 JSON Schema",
      "成功判据",
    ]) {
      assert.match(prompt.content, new RegExp(heading));
    }
    assert.doesNotMatch(prompt.content, /{{/);
    assert.throws(() => interpolatePrompt("Hello {{name}}", {}), /Unresolved/);
  });

  it("exposes strict schemas and honors the structured-output kill switch", () => {
    assert.equal(structuredOutputFor("PLAN").name, "forgemind_plan_v1");
    const provider = new FakeChatProvider([], { supportsStructuredOutput: true });
    assert.equal(supportsStructuredOutput(provider, {}), true);
    assert.equal(supportsStructuredOutput(provider, { FORGEMIND_STRUCTURED_OUTPUT: "0" }), false);
    const architectureSchema = structuredOutputFor("ARCH").jsonSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.ok("alternatives" in architectureSchema.properties);
    assert.equal(architectureSchema.required.includes("alternatives"), true);
  });
});
