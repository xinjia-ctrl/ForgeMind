import { createHash } from "node:crypto";

export function workspaceFingerprint(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}
