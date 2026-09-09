import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AcceptanceCriterion, VerificationEvidence } from "../core/types.js";
import type { ToolResult } from "../tools/types.js";

export interface BehaviorProbe {
  readonly id: string;
  readonly command: readonly string[];
  readonly outputPattern?: string;
}

export interface AcceptanceVerifierRegistryOptions {
  readonly workspaceRoot: string;
  readonly commands: Readonly<Record<string, readonly string[]>>;
  readonly probes?: readonly BehaviorProbe[];
}

export type VerificationCommandRunner = (command: readonly string[]) => Promise<ToolResult>;

export class AcceptanceVerifierRegistry {
  readonly #workspaceRoot: string;
  readonly #commands: ReadonlyMap<string, readonly string[]>;
  readonly #probes: ReadonlyMap<string, BehaviorProbe>;

  public constructor(options: AcceptanceVerifierRegistryOptions) {
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#commands = new Map(
      Object.entries(options.commands).map(([id, command]) => {
        assertIdentifier(id, "command");
        assertCommand(command, id);
        return [id, [...command]] as const;
      }),
    );
    this.#probes = new Map(
      (options.probes ?? []).map((probe) => {
        assertIdentifier(probe.id, "probe");
        assertCommand(probe.command, probe.id);
        return [probe.id, { ...probe, command: [...probe.command] }] as const;
      }),
    );
    if (this.#commands.size === 0) throw new Error("At least one verifier command is required");
  }

  public get commandAllowlist(): readonly (readonly string[])[] {
    return [
      ...new Map(
        [
          ...this.#commands.values(),
          ...[...this.#probes.values()].map((probe) => probe.command),
        ].map((command) => [JSON.stringify(command), command] as const),
      ).values(),
    ];
  }

  public get commandIds(): readonly string[] {
    return [...this.#commands.keys()].sort();
  }

  public get probeIds(): readonly string[] {
    return [...this.#probes.keys()].sort();
  }

  public fingerprint(): string {
    return JSON.stringify({
      commands: [...this.#commands.entries()].sort(([left], [right]) => left.localeCompare(right)),
      probes: [...this.#probes.values()]
        .map((probe) => ({
          id: probe.id,
          command: probe.command,
          outputPattern: probe.outputPattern,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  public async verify(
    criteria: readonly AcceptanceCriterion[],
    artifactFingerprint: string,
    runCommand: VerificationCommandRunner,
  ): Promise<readonly VerificationEvidence[]> {
    const commandResults = new Map<string, Promise<ToolResult>>();
    const execute = async (id: string, command: readonly string[]) => {
      let result = commandResults.get(id);
      if (result === undefined) {
        result = runCommand(command);
        commandResults.set(id, result);
      }
      return await result;
    };
    const evidence: VerificationEvidence[] = [];
    for (const criterion of criteria) {
      if (!criterion.requiredEvidence.includes("test")) continue;
      const verifier = criterion.verifier;
      switch (verifier.kind) {
        case "test-suite": {
          const command = this.#commands.get(verifier.commandId);
          const result =
            command === undefined
              ? undefined
              : await execute(`command:${verifier.commandId}`, command);
          evidence.push(
            verificationEvidence(
              criterion,
              artifactFingerprint,
              `test:command:${verifier.commandId}`,
              result?.ok === true,
              command === undefined
                ? `Unknown verifier command: ${verifier.commandId}`
                : describeCommandResult(command, result as ToolResult),
            ),
          );
          break;
        }
        case "test-case": {
          const command = this.#commands.get(verifier.commandId);
          const result =
            command === undefined
              ? undefined
              : await execute(`command:${verifier.commandId}`, command);
          const output = result === undefined ? "" : processOutput(result);
          const pattern = safeOutputMarker(verifier.pattern);
          const matched = result?.ok === true && pattern !== null && output.includes(pattern);
          evidence.push(
            verificationEvidence(
              criterion,
              artifactFingerprint,
              `test:case:${verifier.commandId}`,
              matched,
              command === undefined
                ? `Unknown verifier command: ${verifier.commandId}`
                : pattern === null
                  ? `Unsafe or invalid test-case output marker: ${verifier.pattern}`
                  : `${describeCommandResult(command, result as ToolResult)}; pattern=${JSON.stringify(verifier.pattern)}; matched=${matched}`,
            ),
          );
          break;
        }
        case "file": {
          const checked = await verifyFile(this.#workspaceRoot, verifier);
          evidence.push(
            verificationEvidence(
              criterion,
              artifactFingerprint,
              `test:file:${verifier.assertion}`,
              checked.passed,
              checked.details,
            ),
          );
          break;
        }
        case "behavior": {
          const probe = this.#probes.get(verifier.probeId);
          const result =
            probe === undefined ? undefined : await execute(`probe:${probe.id}`, probe.command);
          const pattern =
            probe?.outputPattern === undefined ? undefined : safeOutputMarker(probe.outputPattern);
          const output = result === undefined ? "" : processOutput(result);
          const matched =
            pattern === undefined ? true : pattern !== null && output.includes(pattern);
          const passed = result?.ok === true && matched;
          evidence.push(
            verificationEvidence(
              criterion,
              artifactFingerprint,
              `test:behavior:${verifier.probeId}`,
              passed,
              probe === undefined
                ? `Unknown behavior probe: ${verifier.probeId}`
                : pattern === null
                  ? `Unsafe or invalid behavior output pattern for ${verifier.probeId}`
                  : `${describeCommandResult(probe.command, result as ToolResult)}; outputMatched=${matched}`,
            ),
          );
          break;
        }
        case "review":
          evidence.push(
            verificationEvidence(
              criterion,
              artifactFingerprint,
              "test:unsupported-review-verifier",
              false,
              "A review verifier cannot produce deterministic TEST evidence",
            ),
          );
          break;
      }
    }
    return evidence;
  }
}

function verificationEvidence(
  criterion: AcceptanceCriterion,
  artifactFingerprint: string,
  source: string,
  passed: boolean,
  details: string,
): VerificationEvidence {
  return {
    criterionId: criterion.id,
    verifierKind: criterion.verifier.kind,
    source,
    artifactFingerprint,
    passed,
    details: details.trim() || "Verifier returned no diagnostic details",
  };
}

async function verifyFile(
  workspaceRoot: string,
  verifier: Extract<AcceptanceCriterion["verifier"], { kind: "file" }>,
): Promise<{ readonly passed: boolean; readonly details: string }> {
  const canonicalWorkspace = await realpath(workspaceRoot);
  const target = path.resolve(canonicalWorkspace, verifier.path);
  const relative = path.relative(canonicalWorkspace, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { passed: false, details: `File verifier path escapes the workspace: ${verifier.path}` };
  }
  let exists = false;
  try {
    await lstat(target);
    exists = true;
    const resolved = await realpath(target);
    const resolvedRelative = path.relative(canonicalWorkspace, resolved);
    if (
      resolvedRelative === ".." ||
      resolvedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolvedRelative)
    ) {
      return {
        passed: false,
        details: `File verifier symlink escapes the workspace: ${verifier.path}`,
      };
    }
  } catch (error) {
    if (!isMissing(error)) {
      return { passed: false, details: `Cannot inspect ${verifier.path}: ${String(error)}` };
    }
  }
  if (verifier.assertion === "exists") {
    return { passed: exists, details: `${verifier.path} exists=${exists}` };
  }
  if (verifier.assertion === "absent") {
    return { passed: !exists, details: `${verifier.path} absent=${!exists}` };
  }
  if (!exists) return { passed: false, details: `${verifier.path} does not exist` };
  try {
    const content = await readFile(target, "utf8");
    const value = verifier.value ?? "";
    const passed = content.includes(value);
    return {
      passed,
      details: `${verifier.path} contains ${JSON.stringify(value)}=${passed}`,
    };
  } catch (error) {
    return { passed: false, details: `Cannot read ${verifier.path}: ${String(error)}` };
  }
}

function describeCommandResult(command: readonly string[], result: ToolResult): string {
  const output = processOutput(result).slice(-2_000);
  return `command=${command.join(" ")}; ok=${result.ok}; output=${output || "<empty>"}`;
}

function processOutput(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null) return result.error ?? "";
  const stdout = "stdout" in data && typeof data.stdout === "string" ? data.stdout : "";
  const stderr = "stderr" in data && typeof data.stderr === "string" ? data.stderr : "";
  return `${stdout}\n${stderr}`.trim();
}

function safeOutputMarker(pattern: string): string | null {
  const hasUnsafeControl = [...pattern].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
  if (pattern.length === 0 || pattern.length > 256 || hasUnsafeControl) {
    return null;
  }
  return pattern;
}

function assertIdentifier(value: string, kind: string): void {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value)) {
    throw new Error(`Invalid verifier ${kind} id: ${value}`);
  }
}

function assertCommand(command: readonly string[], id: string): void {
  if (command.length === 0 || !command.every((part) => part.length > 0)) {
    throw new Error(`Verifier command ${id} must not be empty`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
