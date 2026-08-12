import { readFile } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import { STAGES, type StageId } from "../core/types.js";
import type { PolicyRule } from "../policy/types.js";
import type { SandboxConfig } from "../sandbox/types.js";

export interface ForgeMindPolicyConfig {
  readonly defaultMode: "allow" | "approve" | "deny";
  readonly rules: readonly PolicyRule[];
  readonly sandbox: SandboxConfig;
}

export interface LoadPolicyConfigOptions {
  readonly repositoryRoot: string;
  readonly explicitPath?: string;
  readonly testCommand: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface PolicyConfigLayer {
  readonly defaultMode?: "allow" | "approve" | "deny";
  readonly rules?: readonly PolicyRule[];
  readonly sandbox?: Partial<SandboxConfig>;
}

const SAFE_TOOLS = [
  "read_file",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "write_file",
  "edit_file",
] as const;

export async function loadPolicyConfig(
  options: LoadPolicyConfigOptions,
): Promise<ForgeMindPolicyConfig> {
  const environment = options.environment ?? process.env;
  const layers: PolicyConfigLayer[] = [builtInPolicy(options.testCommand)];
  const globalPath = environment["FORGEMIND_GLOBAL_CONFIG"];
  if (globalPath !== undefined && globalPath.trim().length > 0) {
    layers.push(await readConfigFile(globalPath, true));
  }
  const policyJson = environment["FORGEMIND_POLICY_JSON"];
  if (policyJson !== undefined && policyJson.trim().length > 0) {
    layers.push(parseConfig(policyJson, "FORGEMIND_POLICY_JSON"));
  }
  if (options.explicitPath !== undefined) {
    layers.push(await readConfigFile(options.explicitPath, true));
  }
  layers.push(
    await readConfigFile(path.join(options.repositoryRoot, "forgemind.config.json"), false),
  );
  return mergePolicyLayers(layers);
}

export function mergePolicyLayers(layers: readonly PolicyConfigLayer[]): ForgeMindPolicyConfig {
  let defaultMode: ForgeMindPolicyConfig["defaultMode"] = "deny";
  let sandbox: SandboxConfig = { mode: "container", runtime: "auto" };
  const rules: PolicyRule[] = [];
  for (const layer of layers) {
    if (layer.defaultMode !== undefined) defaultMode = layer.defaultMode;
    if (layer.rules !== undefined) rules.push(...layer.rules);
    if (layer.sandbox !== undefined) sandbox = mergeSandbox(sandbox, layer.sandbox);
  }
  validateFinalSandbox(sandbox, defaultMode);
  return { defaultMode, rules, sandbox };
}

function builtInPolicy(testCommand: readonly string[]): PolicyConfigLayer {
  return {
    defaultMode: "deny",
    rules: [
      ...SAFE_TOOLS.map((tool): PolicyRule => ({ match: { tool }, mode: "allow" })),
      { match: { tool: "run_command" }, mode: "approve" },
      {
        match: { stage: "TEST", tool: "run_command", command: testCommand },
        mode: "allow",
      },
      { match: { stage: "COMMIT", tool: "git_commit" }, mode: "approve" },
    ],
    sandbox: {
      mode: "container",
      runtime: "auto",
      cpu: 1,
      memoryMb: 512,
      pidsLimit: 128,
      network: false,
    },
  };
}

async function readConfigFile(filePath: string, required: boolean): Promise<PolicyConfigLayer> {
  try {
    return parseConfig(await readFile(path.resolve(filePath), "utf8"), filePath);
  } catch (error) {
    if (!required && isMissingFile(error)) return {};
    if (error instanceof HardFailure) throw error;
    throw new HardFailure(`Cannot read policy config ${filePath}`, { cause: error });
  }
}

function parseConfig(content: string, source: string): PolicyConfigLayer {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new HardFailure(`Invalid JSON in policy config ${source}`, { cause: error });
  }
  if (!isObject(value)) throw new HardFailure(`Policy config ${source} must be an object`);
  assertOnlyKeys(value, ["defaultMode", "rules", "sandbox"], source);
  const layer: PolicyConfigLayer = {
    ...(value["defaultMode"] === undefined
      ? {}
      : { defaultMode: policyMode(value["defaultMode"], `${source}.defaultMode`) }),
    ...(value["rules"] === undefined ? {} : { rules: policyRules(value["rules"], source) }),
    ...(value["sandbox"] === undefined ? {} : { sandbox: sandboxLayer(value["sandbox"], source) }),
  };
  return layer;
}

function policyRules(value: unknown, source: string): readonly PolicyRule[] {
  if (!Array.isArray(value)) throw new HardFailure(`${source}.rules must be an array`);
  return value.map((entry, index): PolicyRule => {
    const location = `${source}.rules[${index}]`;
    if (!isObject(entry)) throw new HardFailure(`${location} must be an object`);
    assertOnlyKeys(entry, ["match", "mode"], location);
    if (!isObject(entry["match"])) throw new HardFailure(`${location}.match must be an object`);
    const match = entry["match"];
    assertOnlyKeys(match, ["stage", "tool", "command"], `${location}.match`);
    const tool = nonEmptyString(match["tool"], `${location}.match.tool`);
    const stage =
      match["stage"] === undefined ? undefined : stageId(match["stage"], `${location}.match.stage`);
    const command =
      match["command"] === undefined
        ? undefined
        : commandParts(match["command"], `${location}.match.command`);
    return {
      match: {
        tool,
        ...(stage === undefined ? {} : { stage }),
        ...(command === undefined ? {} : { command }),
      },
      mode: policyMode(entry["mode"], `${location}.mode`),
    };
  });
}

function sandboxLayer(value: unknown, source: string): Partial<SandboxConfig> {
  if (!isObject(value)) throw new HardFailure(`${source}.sandbox must be an object`);
  assertOnlyKeys(
    value,
    ["mode", "runtime", "image", "cpu", "memoryMb", "pidsLimit", "network"],
    `${source}.sandbox`,
  );
  return {
    ...(value["mode"] === undefined
      ? {}
      : { mode: enumeration(value["mode"], ["container", "local"], `${source}.sandbox.mode`) }),
    ...(value["runtime"] === undefined
      ? {}
      : {
          runtime: enumeration(
            value["runtime"],
            ["docker", "podman", "auto"],
            `${source}.sandbox.runtime`,
          ),
        }),
    ...(value["image"] === undefined
      ? {}
      : { image: nonEmptyString(value["image"], `${source}.sandbox.image`) }),
    ...(value["cpu"] === undefined
      ? {}
      : { cpu: positiveNumber(value["cpu"], `${source}.sandbox.cpu`) }),
    ...(value["memoryMb"] === undefined
      ? {}
      : { memoryMb: positiveInteger(value["memoryMb"], `${source}.sandbox.memoryMb`) }),
    ...(value["pidsLimit"] === undefined
      ? {}
      : { pidsLimit: positiveInteger(value["pidsLimit"], `${source}.sandbox.pidsLimit`) }),
    ...(value["network"] === undefined
      ? {}
      : { network: booleanValue(value["network"], `${source}.sandbox.network`) }),
  };
}

function mergeSandbox(base: SandboxConfig, override: Partial<SandboxConfig>): SandboxConfig {
  return {
    ...base,
    ...override,
  };
}

function validateFinalSandbox(
  sandbox: SandboxConfig,
  defaultMode: ForgeMindPolicyConfig["defaultMode"],
): void {
  if (sandbox.mode === "local" && defaultMode !== "deny") {
    throw new HardFailure("sandbox.mode=local requires defaultMode=deny");
  }
  if (
    sandbox.mode === "container" &&
    (sandbox.image === undefined || !/@sha256:[a-f0-9]{64}$/i.test(sandbox.image))
  ) {
    throw new HardFailure("Container sandbox image must be configured with a sha256 digest");
  }
}

function policyMode(value: unknown, location: string): "allow" | "approve" | "deny" {
  return enumeration(value, ["allow", "approve", "deny"], location);
}

function stageId(value: unknown, location: string): StageId {
  return enumeration(value, STAGES, location);
}

function commandParts(value: unknown, location: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new HardFailure(`${location} must be a non-empty array of non-empty strings`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  location: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new HardFailure(`${location} must be one of: ${values.join(", ")}`);
  }
  return value;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HardFailure(`${location} must be a non-empty string`);
  }
  return value;
}

function positiveNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HardFailure(`${location} must be a positive number`);
  }
  return value;
}

function positiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HardFailure(`${location} must be a positive integer`);
  }
  return value;
}

function booleanValue(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") throw new HardFailure(`${location} must be a boolean`);
  return value;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  location: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new HardFailure(`Unknown option ${location}.${unknown}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isObject(error) && error["code"] === "ENOENT";
}
