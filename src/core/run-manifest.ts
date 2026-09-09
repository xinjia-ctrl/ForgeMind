import { createHash } from "node:crypto";
import { acceptanceContractHash } from "./acceptance.js";
import { FatalFailure } from "./errors.js";
import type { AcceptanceCriterion, TaskContext } from "./types.js";

export interface RunManifest {
  readonly requirementHash: string;
  readonly acceptanceContractHash: string;
  readonly initialHead: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersions: Readonly<Record<string, string>>;
  readonly policyHash: string;
  readonly testCommandHash: string;
  readonly budgetHash: string;
  readonly upstreamCommitHashes: readonly string[];
}

export function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

export function manifestForContext(base: RunManifest, ctx: TaskContext): RunManifest {
  return {
    ...base,
    acceptanceContractHash:
      ctx.plan === null
        ? base.acceptanceContractHash
        : acceptanceContractHash(ctx.plan.acceptanceCriteria),
  };
}

export function initialAcceptanceHash(
  criteria: readonly AcceptanceCriterion[] | undefined,
): string {
  return criteria === undefined ? "" : acceptanceContractHash(criteria);
}

export function assertResumeManifest(
  requested: RunManifest,
  restored: RunManifest,
  restoredContext: TaskContext,
): void {
  const expected = {
    ...requested,
    acceptanceContractHash:
      requested.acceptanceContractHash.length === 0
        ? restored.acceptanceContractHash
        : requested.acceptanceContractHash,
  };
  if (JSON.stringify(expected) !== JSON.stringify(restored)) {
    throw new FatalFailure(
      "Run checkpoint manifest does not match the current runtime configuration",
    );
  }
  if (
    restoredContext.plan !== null &&
    acceptanceContractHash(restoredContext.plan.acceptanceCriteria) !==
      restored.acceptanceContractHash
  ) {
    throw new FatalFailure("Run checkpoint acceptance contract fingerprint is invalid");
  }
}
