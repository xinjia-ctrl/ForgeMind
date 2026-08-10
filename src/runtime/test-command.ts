import { readFile } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";

const ALLOWED_EXECUTABLES = new Set(["npm", "node", "pnpm", "yarn", "bun"]);
const SAFE_ARGUMENT = /^[a-zA-Z0-9@%_+=:,./-]+$/;

export async function resolveTestCommand(
  repoRoot: string,
  explicit?: string,
): Promise<readonly string[]> {
  if (explicit !== undefined) return parseTestCommand(explicit);
  try {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    if (typeof packageJson.scripts?.["test"] === "string") return ["npm", "test"];
  } catch {
    // A non-Node target can still use Node's built-in test discovery when configured.
  }
  return ["node", "--test"];
}

export function parseTestCommand(value: string): readonly string[] {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const executable = parts[0];
  if (executable === undefined || !ALLOWED_EXECUTABLES.has(executable)) {
    throw new HardFailure(
      `Test command executable must be one of: ${[...ALLOWED_EXECUTABLES].join(", ")}`,
    );
  }
  if (!parts.every((part) => SAFE_ARGUMENT.test(part))) {
    throw new HardFailure("Test command contains unsupported shell characters");
  }
  if (parts.some((part) => part.split("/").includes(".."))) {
    throw new HardFailure("Test command cannot reference paths outside the workspace");
  }
  if (!isTestInvocation(parts)) {
    throw new HardFailure("Only package test scripts or node --test are allowed");
  }
  return parts;
}

function isTestInvocation(parts: readonly string[]): boolean {
  const [executable, first, second] = parts;
  if (executable === "node") return first === "--test" || first?.startsWith("--test=") === true;
  if (executable === "npm") {
    return first === "test" || (first === "run" && second === "test");
  }
  return first === "test" || (first === "run" && second === "test");
}
