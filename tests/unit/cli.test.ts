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

  it("requires an explicit run id for resume before reading credentials", async () => {
    assert.equal(
      await withMutedStderr(() => main(["run", "--repo", ".", "--requirement", "x", "--resume"])),
      1,
    );
  });

  it("validates the local web port before starting a server", async () => {
    assert.equal(await withMutedStderr(() => main(["web", "--port", "0"])), 1);
    assert.equal(
      await withMutedStderr(() => main(["web", "--port", "3210", "--public", "true"])),
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
