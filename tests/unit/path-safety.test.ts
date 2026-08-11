import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveWorkspacePath } from "../../src/tools/path-safety.js";
import { ToolPolicy } from "../../src/tools/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace path safety", () => {
  it("rejects traversal and direct Git metadata access", async () => {
    const root = await temporaryWorkspace();
    const policy = writablePolicy(root);
    await assert.rejects(
      resolveWorkspacePath(policy, "../outside.txt", { forWrite: true }),
      /escapes workspace/,
    );
    await assert.rejects(resolveWorkspacePath(policy, ".git/config"), /Git metadata/);
  });

  it("rejects a symlink that escapes the workspace", async () => {
    const root = await temporaryWorkspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), "forgemind-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(root, "escape"));
    await assert.rejects(
      resolveWorkspacePath(writablePolicy(root), "escape/secret.txt"),
      /escapes workspace/,
    );
  });

  it("enforces writable and protected prefixes", async () => {
    const root = await temporaryWorkspace();
    const policy = new ToolPolicy({
      workspaceRoot: root,
      stage: "CODE",
      allowedTools: ["write_file"],
      writable: true,
      writablePrefixes: ["src"],
      forbiddenWritePrefixes: ["src/generated"],
    });
    assert.equal(
      await resolveWorkspacePath(policy, "src/index.ts", { forWrite: true }),
      path.join(await realpath(root), "src/index.ts"),
    );
    await assert.rejects(
      resolveWorkspacePath(policy, "tests/index.test.ts", { forWrite: true }),
      /outside writable prefixes/,
    );
    await assert.rejects(
      resolveWorkspacePath(policy, "src/generated/schema.ts", { forWrite: true }),
      /protected from writes/,
    );
  });
});

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgemind-path-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "src"));
  return root;
}

function writablePolicy(root: string): ToolPolicy {
  return new ToolPolicy({
    workspaceRoot: root,
    stage: "CODE",
    allowedTools: ["read_file", "write_file"],
    writable: true,
  });
}
