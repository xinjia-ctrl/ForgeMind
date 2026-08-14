import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RulePolicyResolver } from "../../src/policy/resolver.js";

describe("RulePolicyResolver", () => {
  it("uses command, then stage, then tool specificity and later-layer ties", () => {
    const resolver = new RulePolicyResolver("deny", [
      { match: { tool: "run_command" }, mode: "approve", risk: "medium" },
      { match: { stage: "TEST", tool: "run_command" }, mode: "deny" },
      {
        match: { stage: "TEST", tool: "run_command", command: ["npm", "test"] },
        mode: "allow",
      },
      {
        match: { stage: "TEST", tool: "run_command", command: ["npm", "test"] },
        mode: "approve",
      },
    ]);

    assert.equal(
      resolver.resolve({
        stage: "TEST",
        tool: "run_command",
        args: {},
        command: ["npm", "test"],
      }).mode,
      "approve",
    );
    assert.equal(
      resolver.resolve({ stage: "TEST", tool: "run_command", args: {}, command: ["npm", "ci"] })
        .mode,
      "deny",
    );
    assert.deepEqual(resolver.resolve({ stage: "CODE", tool: "run_command", args: {} }), {
      mode: "approve",
      policy: "rule:0:approve",
      risk: "medium",
    });
    assert.equal(resolver.resolve({ stage: "CODE", tool: "unknown", args: {} }).mode, "deny");
  });
});
