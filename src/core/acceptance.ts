import { createHash } from "node:crypto";
import { StageFailure } from "./errors.js";
import type {
  AcceptanceCriterion,
  GateResult,
  GateStage,
  RequiredEvidence,
  TaskContext,
  VerificationEvidence,
} from "./types.js";

const ACCEPTANCE_ID = /^AC-[1-9]\d*$/;

export function testSuiteCriterion(
  id: string,
  description: string,
  commandId = "primary",
): AcceptanceCriterion {
  return {
    id,
    description,
    requiredEvidence: ["test"],
    verifier: { kind: "test-suite", commandId },
  };
}

export function reviewCriterion(
  id: string,
  description: string,
  rubric = description,
): AcceptanceCriterion {
  return {
    id,
    description,
    requiredEvidence: ["review"],
    verifier: { kind: "review", rubric },
  };
}

export function acceptanceContractHash(criteria: readonly AcceptanceCriterion[]): string {
  assertAcceptanceContract(criteria);
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

export function renderAcceptanceContract(criteria: readonly AcceptanceCriterion[]): string {
  return criteria
    .map(
      (criterion) =>
        `${criterion.id}: ${criterion.description}\nrequiredEvidence=${criterion.requiredEvidence.join(",")}\nverifier=${JSON.stringify(criterion.verifier)}`,
    )
    .join("\n\n");
}

export function evidenceRequirementsFor(criterion: AcceptanceCriterion, stage: GateStage): boolean {
  return criterion.requiredEvidence.includes(evidenceSourceFor(stage));
}

export function requiredCriteriaForStage(
  criteria: readonly AcceptanceCriterion[],
  stage: GateStage,
): readonly AcceptanceCriterion[] {
  return criteria.filter((criterion) => evidenceRequirementsFor(criterion, stage));
}

export function failedVerificationEvidence(
  criteria: readonly AcceptanceCriterion[],
  stage: GateStage,
  artifactFingerprint: string,
  details: string,
): readonly VerificationEvidence[] {
  return requiredCriteriaForStage(criteria, stage).map((criterion) => ({
    criterionId: criterion.id,
    verifierKind: criterion.verifier.kind,
    source: evidenceSourcePrefix(stage),
    artifactFingerprint,
    passed: false,
    details,
  }));
}

export function assertAcceptanceSatisfied(ctx: TaskContext): void {
  if (ctx.plan === null) throw new StageFailure("Run has no acceptance contract");
  assertAcceptanceContract(ctx.plan.acceptanceCriteria);
  const latestReview = latestGate(ctx.gates, "REVIEW");
  const latestTest = latestGate(ctx.gates, "TEST");
  if (latestReview?.passed !== true || latestTest?.passed !== true) {
    throw new StageFailure("Acceptance verification requires passing TEST and REVIEW gates");
  }
  if (latestReview.artifactFingerprint !== latestTest.artifactFingerprint) {
    throw new StageFailure("TEST and REVIEW verified different workspace fingerprints");
  }
  assertCompleteEvidence(ctx.plan.acceptanceCriteria, "TEST", latestTest);
  assertCompleteEvidence(ctx.plan.acceptanceCriteria, "REVIEW", latestReview);
}

export function assertCompleteEvidence(
  criteria: readonly AcceptanceCriterion[],
  stage: GateStage,
  gate: Pick<GateResult, "artifactFingerprint" | "verificationEvidence">,
): void {
  const expected = requiredCriteriaForStage(criteria, stage);
  const received = gate.verificationEvidence;
  const byId = new Map<string, VerificationEvidence>();
  for (const item of received) {
    if (byId.has(item.criterionId)) {
      throw new StageFailure(`${stage} returned duplicate evidence for ${item.criterionId}`);
    }
    byId.set(item.criterionId, item);
  }
  for (const criterion of expected) {
    const item = byId.get(criterion.id);
    if (item === undefined) {
      throw new StageFailure(`${stage} is missing verification evidence for ${criterion.id}`);
    }
    if (
      item.verifierKind !== criterion.verifier.kind ||
      item.source !== expectedEvidenceSource(criterion, stage) ||
      item.artifactFingerprint !== gate.artifactFingerprint ||
      item.details.trim().length === 0
    ) {
      throw new StageFailure(`${stage} returned invalid verification evidence for ${criterion.id}`);
    }
    if (!item.passed) {
      throw new StageFailure(`${stage} did not satisfy ${criterion.id}: ${item.details}`);
    }
  }
  if (byId.size !== expected.length) {
    throw new StageFailure(`${stage} returned evidence for an unassigned acceptance criterion`);
  }
}

export function assertAcceptanceContract(criteria: readonly AcceptanceCriterion[]): void {
  if (criteria.length === 0) throw new StageFailure("Acceptance contract must not be empty");
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (!ACCEPTANCE_ID.test(criterion.id) || ids.has(criterion.id)) {
      throw new StageFailure(`Invalid or duplicate acceptance criterion id: ${criterion.id}`);
    }
    ids.add(criterion.id);
    if (criterion.description.trim().length === 0) {
      throw new StageFailure(`${criterion.id} must have a description`);
    }
    if (
      criterion.requiredEvidence.length === 0 ||
      new Set(criterion.requiredEvidence).size !== criterion.requiredEvidence.length
    ) {
      throw new StageFailure(`${criterion.id} must have unique required evidence sources`);
    }
    assertVerifier(criterion);
  }
}

function assertVerifier(criterion: AcceptanceCriterion): void {
  const verifier = criterion.verifier;
  if (verifier.kind === "review") {
    if (
      !criterion.requiredEvidence.includes("review") ||
      criterion.requiredEvidence.includes("test") ||
      verifier.rubric.trim().length === 0
    ) {
      throw new StageFailure(
        `${criterion.id} review verifier requires a rubric and REVIEW evidence`,
      );
    }
    return;
  }
  if (!criterion.requiredEvidence.includes("test")) {
    throw new StageFailure(`${criterion.id} ${verifier.kind} verifier requires TEST evidence`);
  }
  switch (verifier.kind) {
    case "test-suite":
      if (verifier.commandId.trim().length === 0) invalidVerifier(criterion);
      break;
    case "test-case":
      if (verifier.commandId.trim().length === 0 || verifier.pattern.trim().length === 0) {
        invalidVerifier(criterion);
      }
      break;
    case "file":
      if (
        verifier.path.trim().length === 0 ||
        (verifier.assertion === "contains" && (verifier.value?.length ?? 0) === 0)
      ) {
        invalidVerifier(criterion);
      }
      break;
    case "behavior":
      if (verifier.probeId.trim().length === 0) invalidVerifier(criterion);
      break;
  }
}

function invalidVerifier(criterion: AcceptanceCriterion): never {
  throw new StageFailure(`${criterion.id} has an invalid ${criterion.verifier.kind} verifier`);
}

function latestGate(gates: readonly GateResult[], stage: GateStage): GateResult | undefined {
  return [...gates].reverse().find((gate) => gate.stage === stage);
}

function evidenceSourceFor(stage: GateStage): RequiredEvidence {
  return stage === "TEST" ? "test" : "review";
}

function evidenceSourcePrefix(stage: GateStage): string {
  return `${evidenceSourceFor(stage)}:`;
}

function expectedEvidenceSource(criterion: AcceptanceCriterion, stage: GateStage): string {
  if (stage === "REVIEW") return "review:model";
  switch (criterion.verifier.kind) {
    case "test-suite":
      return `test:command:${criterion.verifier.commandId}`;
    case "test-case":
      return `test:case:${criterion.verifier.commandId}`;
    case "file":
      return `test:file:${criterion.verifier.assertion}`;
    case "behavior":
      return `test:behavior:${criterion.verifier.probeId}`;
    case "review":
      return "test:unsupported-review-verifier";
  }
}
