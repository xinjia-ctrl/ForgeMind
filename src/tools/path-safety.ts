import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import type { ToolPolicy } from "./types.js";

export async function resolveWorkspacePath(
  policy: ToolPolicy,
  requestedPath: string,
  options: { readonly forWrite?: boolean } = {},
): Promise<string> {
  if (requestedPath.includes("\0")) {
    throw new HardFailure("Paths cannot contain null bytes");
  }
  const workspace = await realpath(policy.workspaceRoot);
  const resolved = path.resolve(workspace, requestedPath);
  assertWithin(workspace, resolved);
  assertNotGitMetadata(workspace, resolved);

  if (options.forWrite === true) {
    if (!policy.writable) {
      throw new HardFailure(`Stage ${policy.stage} has a read-only policy`);
    }
    assertWritablePrefix(workspace, resolved, policy.writablePrefixes);
    assertNotForbiddenPrefix(workspace, resolved, policy.forbiddenWritePrefixes);
    const existingAncestor = await nearestExistingAncestor(resolved);
    assertWithin(workspace, await realpath(existingAncestor));
  } else {
    assertWithin(workspace, await realpath(resolved));
  }
  return resolved;
}

function assertNotForbiddenPrefix(
  root: string,
  candidate: string,
  prefixes: readonly string[],
): void {
  const relative = relativeWorkspacePath(root, candidate);
  const forbidden = prefixes.some((prefix) => {
    const normalized = prefix.replace(/^\.\//, "").replace(/\/$/, "");
    return relative === normalized || relative.startsWith(`${normalized}/`);
  });
  if (forbidden) {
    throw new HardFailure(`Path is protected from writes: ${relative}`);
  }
}

export function relativeWorkspacePath(root: string, absolutePath: string): string {
  return path.relative(path.resolve(root), absolutePath).split(path.sep).join("/");
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HardFailure(`Path escapes workspace: ${candidate}`);
  }
}

function assertNotGitMetadata(root: string, candidate: string): void {
  const relative = relativeWorkspacePath(root, candidate);
  if (relative === ".git" || relative.startsWith(".git/")) {
    throw new HardFailure("Direct access to Git metadata is forbidden");
  }
}

function assertWritablePrefix(
  root: string,
  candidate: string,
  prefixes: readonly string[],
): void {
  if (prefixes.length === 0) return;
  const relative = relativeWorkspacePath(root, candidate);
  const allowed = prefixes.some((prefix) => {
    const normalized = prefix.replace(/^\.\//, "").replace(/\/$/, "");
    return relative === normalized || relative.startsWith(`${normalized}/`);
  });
  if (!allowed) {
    throw new HardFailure(`Path is outside writable prefixes: ${relative}`);
  }
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
