import { readFile } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import { ROLES, type Actor, type Role } from "./types.js";

export interface ActorPolicySource {
  readonly actors: readonly Actor[];
}

export async function loadActorPolicy(filePath: string): Promise<ActorPolicySource> {
  let content: string;
  try {
    content = await readFile(path.resolve(filePath), "utf8");
  } catch (error) {
    throw new HardFailure(`Cannot read actor policy ${filePath}`, { cause: error });
  }
  return parseActorPolicy(content, filePath);
}

export function parseActorPolicy(content: string, source = "actor policy"): ActorPolicySource {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new HardFailure(`Invalid JSON in actor policy ${source}`, { cause: error });
  }
  if (!isObject(value)) throw new HardFailure(`${source} must be an object`);
  assertOnlyKeys(value, ["actors"], source);
  if (!Array.isArray(value["actors"])) throw new HardFailure(`${source}.actors must be an array`);
  const ids = new Set<string>();
  const actors = value["actors"].map((entry, index): Actor => {
    const location = `${source}.actors[${index}]`;
    if (!isObject(entry)) throw new HardFailure(`${location} must be an object`);
    assertOnlyKeys(entry, ["id", "role", "repos", "teams"], location);
    const id = nonEmptyString(entry["id"], `${location}.id`);
    if (ids.has(id)) throw new HardFailure(`Duplicate actor id: ${id}`);
    ids.add(id);
    return {
      id,
      role: role(entry["role"], `${location}.role`),
      ...(entry["repos"] === undefined
        ? {}
        : { repos: stringArray(entry["repos"], `${location}.repos`) }),
      ...(entry["teams"] === undefined
        ? {}
        : { teams: stringArray(entry["teams"], `${location}.teams`) }),
    };
  });
  return { actors };
}

export function actorById(source: ActorPolicySource, actorId: string): Actor | undefined {
  return source.actors.find((actor) => actor.id === actorId);
}

function role(value: unknown, location: string): Role {
  if (typeof value !== "string" || !ROLES.includes(value as Role)) {
    throw new HardFailure(`${location} must be one of: ${ROLES.join(", ")}`);
  }
  return value as Role;
}

function stringArray(value: unknown, location: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new HardFailure(`${location} must be an array of non-empty strings`);
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new HardFailure(`${location} must not contain duplicates`);
  }
  return normalized;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HardFailure(`${location} must be a non-empty string`);
  }
  return value.trim();
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
