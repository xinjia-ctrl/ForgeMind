import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main } from "../../src/runtime/cli.js";

describe("CLI validation", () => {
  it("rejects unknown options before executing a run", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main(["run", "--repo", ".", "--requirement", "x", "--typo", "value"]),
      ),
      1,
    );
  });

  it("rejects an invalid rework count before reading credentials", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main(["run", "--repo", ".", "--requirement", "x", "--max-rework", "1.5"]),
      ),
      1,
    );
  });

  it("rejects an invalid Git hook policy before reading credentials", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main(["run", "--repo", ".", "--requirement", "x", "--skip-git-hooks", "sometimes"]),
      ),
      1,
    );
  });

  it("rejects conflicting approval flags before reading credentials", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main(["run", "--repo", ".", "--requirement", "x", "--yes", "--no-approve"]),
      ),
      1,
    );
  });

  it("parses and validates the nested dag run command before reading credentials", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main(["dag", "run", "--repos", ".", "--requirement", "x", "--max-concurrency", "0"]),
      ),
      1,
    );
  });

  it("rejects unknown dag run options", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main(["dag", "run", "--repos", ".", "--requirement", "x", "--merge", "true"]),
      ),
      1,
    );
  });

  it("validates nested audit export options without credentials", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main([
          "audit",
          "export",
          "--repo",
          ".",
          "--from",
          "2025-01-01T00:00:00Z",
          "--to",
          "2025-01-02T00:00:00Z",
          "--format",
          "xml",
        ]),
      ),
      1,
    );
  });

  it("requires actor id and policy to be provided together", async () => {
    assert.equal(
      await withMutedStderr(() =>
        main(["run", "--repo", ".", "--requirement", "x", "--actor", "alice"]),
      ),
      1,
    );
  });
});

async function withMutedStderr(action: () => Promise<number>): Promise<number> {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await action();
  } finally {
    process.stderr.write = original;
  }
}
