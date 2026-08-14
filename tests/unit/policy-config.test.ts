import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HardFailure } from "../../src/core/errors.js";
import { loadPolicyConfig, mergePolicyLayers } from "../../src/config/policy.js";

describe("policy configuration", () => {
  it("merges layers in order while retaining rules for specificity resolution", () => {
    const config = mergePolicyLayers([
      {
        defaultMode: "deny",
        rules: [{ match: { tool: "git_commit" }, mode: "approve", risk: "high" }],
        sandbox: {
          mode: "container",
          image: `node@sha256:${"a".repeat(64)}`,
          memoryMb: 256,
        },
      },
      {
        rules: [{ match: { stage: "COMMIT", tool: "git_commit" }, mode: "allow" }],
        sandbox: { memoryMb: 768 },
      },
    ]);

    assert.equal(config.defaultMode, "deny");
    assert.equal(config.rules.length, 2);
    assert.equal(config.rules[0]?.risk, "high");
    assert.equal(config.sandbox.memoryMb, 768);
    assert.equal(config.sandbox.image, `node@sha256:${"a".repeat(64)}`);
  });

  it("loads repository config last and rejects unsafe local defaults", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-policy-"));
    try {
      await writeFile(
        path.join(repository, "forgemind.config.json"),
        JSON.stringify({
          defaultMode: "deny",
          rules: [{ match: { tool: "git_commit" }, mode: "deny" }],
          sandbox: { mode: "local" },
        }),
        "utf8",
      );
      const config = await loadPolicyConfig({
        repositoryRoot: repository,
        testCommand: ["npm", "test"],
        environment: {},
      });
      assert.equal(config.sandbox.mode, "local");
      assert.equal(config.rules.at(-1)?.mode, "deny");

      await writeFile(
        path.join(repository, "forgemind.config.json"),
        JSON.stringify({ defaultMode: "allow", sandbox: { mode: "local" } }),
        "utf8",
      );
      await assert.rejects(
        () =>
          loadPolicyConfig({
            repositoryRoot: repository,
            testCommand: ["npm", "test"],
            environment: {},
          }),
        HardFailure,
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("fails fast for an unpinned container image or unknown fields", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-policy-invalid-"));
    try {
      await writeFile(
        path.join(repository, "forgemind.config.json"),
        JSON.stringify({ sandbox: { mode: "container", image: "node:22", privileged: true } }),
        "utf8",
      );
      await assert.rejects(
        () =>
          loadPolicyConfig({
            repositoryRoot: repository,
            testCommand: ["node", "--test"],
            environment: {},
          }),
        /Unknown option/,
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
