import { StageFailure } from "../core/errors.js";

export function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.trim().length === 0) {
    throw new StageFailure(`${key} must be a non-empty string`);
  }
  return result.trim();
}

export function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const result = value[key];
  if (typeof result !== "boolean") {
    throw new StageFailure(`${key} must be a boolean`);
  }
  return result;
}

export function stringArray(value: Record<string, unknown>, key: string): string[] {
  const result = value[key];
  if (
    !Array.isArray(result) ||
    !result.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new StageFailure(`${key} must be an array of non-empty strings`);
  }
  return result.map((item) => (item as string).trim());
}

export function objectArray(
  value: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const result = value[key];
  if (
    !Array.isArray(result) ||
    !result.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))
  ) {
    throw new StageFailure(`${key} must be an array of objects`);
  }
  return result as Array<Record<string, unknown>>;
}
