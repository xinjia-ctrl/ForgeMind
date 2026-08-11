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
