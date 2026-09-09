import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { supportsStructuredOutput } from "../../src/llm/capabilities.js";
import { FakeChatProvider } from "../../src/llm/fake-provider.js";
import { interpolatePrompt, loadPrompt, structuredOutputFor } from "../../src/prompts/index.js";

describe("prompt governance", () => {
  it("loads versioned five-section prompt resources and interpolates bounded variables", async () => {
    const prompt = await loadPrompt("CODE", {
      maxSteps: "10",
      maxActions: "3",
      fastCheckIds: "primary",
    });
    assert.equal(prompt.version, "code.v4");
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
    assert.match(prompt.content, /"kind":"write"/);
    assert.throws(() => interpolatePrompt("Hello {{name}}", {}), /Unresolved/);
    const architecturePrompt = await loadPrompt("ARCH");
    assert.equal(architecturePrompt.version, "architecture.v3");
    assert.match(architecturePrompt.content, /arrays of JSON strings, never arrays of objects/);
    const reviewPrompt = await loadPrompt("REVIEW");
    assert.equal(reviewPrompt.version, "review.v4");
    assert.match(reviewPrompt.content, /explicitly assigned to REVIEW/);
  });

  it("exposes strict schemas and honors the provider capability", () => {
    const planOutput = structuredOutputFor("PLAN");
    assert.equal(planOutput.name, "forgemind_plan_v4");
    const planSchema = planOutput.jsonSchema as {
      properties: {
        steps: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    assert.deepEqual(planSchema.properties.steps.items.required, ["title", "description"]);
    assert.equal("id" in planSchema.properties.steps.items.properties, false);
    const supported = new FakeChatProvider([], { supportsStructuredOutput: true });
    const disabled = new FakeChatProvider([], { supportsStructuredOutput: false });
    assert.equal(supportsStructuredOutput(supported), true);
    assert.equal(supportsStructuredOutput(disabled), false);
    const architectureSchema = structuredOutputFor("ARCH").jsonSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.ok("alternatives" in architectureSchema.properties);
    assert.equal(architectureSchema.required.includes("alternatives"), true);
  });
});
