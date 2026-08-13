import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assemblePromptInput,
  rankWorkspaceFiles,
  searchTerms,
} from "../../src/context/assembler.js";

describe("context assembler", () => {
  it("prioritizes architecture files, then grep and keyword relevance", () => {
    const ranked = rankWorkspaceFiles({
      files: ["README.md", "src/health.ts", "src/router.ts", "test/router.test.ts"],
      expectedFiles: ["src/router.ts"],
      query: "health route",
      grepMatches: [
        { path: "src/health.ts", line: 1, text: "health" },
        { path: "test/router.test.ts", line: 4, text: "health route" },
      ],
      limit: 3,
    });
    assert.deepEqual(ranked, ["src/router.ts", "test/router.test.ts", "src/health.ts"]);
  });

  it("assembles source-labelled sections with deterministic token evidence", () => {
    const prompt = assemblePromptInput([
      { name: "Requirement", content: "Add health route", source: "contract" },
      { name: "Memory", content: "Reuse router", source: "memory", references: ["memory.json"] },
    ]);
    assert.match(prompt.content, /source=contract/);
    assert.ok(prompt.tokenEstimate > 0);
    assert.deepEqual(searchTerms("Add a health-check route"), ["health-check", "route", "add"]);
  });

  it("uses deterministic path order to break identical relevance scores", () => {
    assert.deepEqual(
      rankWorkspaceFiles({
        files: ["src/zeta.ts", "src/alpha.ts"],
        expectedFiles: [],
        query: "unrelated",
        limit: 2,
      }),
      ["src/alpha.ts", "src/zeta.ts"],
    );
  });
});
