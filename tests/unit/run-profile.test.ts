import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectRunProfile } from "../../src/core/run-profile.js";

describe("deterministic run profiles", () => {
  it("routes small and architecture-sensitive work without an LLM", () => {
    assert.deepEqual(selectRunProfile({ requirement: "Fix a one-line typo" }).profile, "light");
    assert.equal(
      selectRunProfile({ requirement: "Change the public API and database schema" })
        .includeArchitecture,
      true,
    );
    assert.equal(
      selectRunProfile({ requirement: "Refactor internals", estimatedFileCount: 5 })
        .includeArchitecture,
      true,
    );
    assert.equal(
      selectRunProfile({ requirement: "Update behavior", touchesPublicInterface: true })
        .includeArchitecture,
      true,
    );
  });

  it("rejects invalid deterministic signal counts", () => {
    assert.throws(
      () => selectRunProfile({ requirement: "x", estimatedFileCount: -1 }),
      /estimatedFileCount/,
    );
  });
});
