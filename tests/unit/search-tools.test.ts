import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GlobTool, GrepTool, WorkspaceFileIndex } from "../../src/tools/search-tools.js";
import { ToolPolicy } from "../../src/tools/types.js";

describe("workspace search tools", () => {
  it("keeps the single-query grep contract", async () => {
    const fixture = await searchFixture();
    try {
      const result = await new GrepTool().execute(
        { query: "ALPHA", pattern: "**/*.txt", caseSensitive: false },
        fixture.policy,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(matchLocations(result.data), ["a.txt:1", "b.txt:1"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("searches multiple terms in one pass and consumes a primed file index once", async () => {
    const fixture = await searchFixture();
    try {
      const fileIndex = new WorkspaceFileIndex();
      const glob = new GlobTool(fileIndex);
      const grep = new GrepTool(fileIndex);
      assert.equal((await glob.execute({ pattern: "**/*" }, fixture.policy)).ok, true);
      await writeFile(path.join(fixture.directory, "later.txt"), "alpha gamma\n", "utf8");

      const indexed = await grep.execute(
        { queries: ["alpha", "gamma"], pattern: "**/*.txt", caseSensitive: false },
        fixture.policy,
      );
      assert.deepEqual(matchLocations(indexed.data), ["a.txt:1", "b.txt:1", "b.txt:2"]);

      const refreshed = await grep.execute(
        { query: "gamma", pattern: "**/*.txt", caseSensitive: false },
        fixture.policy,
      );
      assert.deepEqual(matchLocations(refreshed.data), ["b.txt:2", "later.txt:1"]);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function searchFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-search-"));
  await writeFile(path.join(directory, "a.txt"), "Alpha and beta\nbeta\n", "utf8");
  await writeFile(path.join(directory, "b.txt"), "alpha\nGamma beta\n", "utf8");
  return {
    directory,
    policy: new ToolPolicy({
      workspaceRoot: directory,
      stage: "CODE",
      allowedTools: ["glob", "grep"],
      writable: false,
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function matchLocations(data: unknown): readonly string[] {
  if (typeof data !== "object" || data === null || !("matches" in data)) return [];
  const matches: unknown = data.matches;
  if (!Array.isArray(matches)) return [];
  return matches.flatMap((match: unknown) => {
    if (
      typeof match !== "object" ||
      match === null ||
      !("path" in match) ||
      typeof match.path !== "string" ||
      !("line" in match) ||
      typeof match.line !== "number"
    ) {
      return [];
    }
    return [`${match.path}:${match.line}`];
  });
}
