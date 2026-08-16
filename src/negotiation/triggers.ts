import type { ArchDecision, TaskContext } from "../core/types.js";
import type { NegotiationArtifact, NegotiationEvidence } from "./types.js";

export function detectArchitectureConflict(architecture: ArchDecision): NegotiationEvidence | null {
  const alternatives = architecture.alternatives ?? [];
  const distinct = alternatives.filter(
    (alternative, index) =>
      alternatives.findIndex(
        (candidate) => normalize(candidate.position) === normalize(alternative.position),
      ) === index,
  );
  if (distinct.length < 2) return null;
  const [proposal, ...counters] = distinct;
  if (proposal === undefined) return null;
  return {
    trigger: "arch-conflict",
    topic: `Architecture alternatives for: ${architecture.summary}`,
    proposal: describeAlternative(proposal.position, proposal.tradeoffs),
    counter: counters
      .map((alternative) => describeAlternative(alternative.position, alternative.tradeoffs))
      .join("\n"),
  };
}

export function detectRepeatedReviewRejection(
  context: TaskContext,
  threshold = 2,
): NegotiationEvidence | null {
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error("Review negotiation threshold must be an integer of at least 2");
  }
  const reviewGates = context.gates.filter((gate) => gate.stage === "REVIEW");
  const trailingRejections = [];
  for (let index = reviewGates.length - 1; index >= 0; index -= 1) {
    const gate = reviewGates[index];
    if (gate === undefined || gate.passed) break;
    trailingRejections.push(gate);
  }
  if (trailingRejections.length < threshold) return null;
  const codeSummaries = context.artifacts
    .filter((artifact) => artifact.stage === "CODE")
    .slice(-threshold)
    .map((artifact) => artifact.summary);
  return {
    trigger: "review-repeated-rejection",
    topic: `Repeated review rejection for: ${context.requirement}`,
    proposal:
      codeSummaries.length === 0
        ? (context.architecture?.summary ?? context.requirement)
        : codeSummaries.join("\n"),
    counter: trailingRejections
      .slice(0, threshold)
      .reverse()
      .map((gate) => `${gate.reason}: ${gate.feedback}`)
      .join("\n"),
  };
}

export function detectArtifactMismatch(
  artifacts: readonly NegotiationArtifact[],
): NegotiationEvidence | null {
  const ordered = [...artifacts].sort(
    (left, right) =>
      left.artifact.path.localeCompare(right.artifact.path) ||
      left.taskId.localeCompare(right.taskId),
  );
  const byPath = new Map<string, NegotiationArtifact[]>();
  for (const artifact of ordered) {
    const entries = byPath.get(artifact.artifact.path) ?? [];
    entries.push(artifact);
    byPath.set(artifact.artifact.path, entries);
  }
  for (const [path, entries] of byPath) {
    const tasks = new Set(entries.map((entry) => entry.taskId));
    const meanings = new Set(entries.map((entry) => normalize(entry.artifact.summary)));
    if (tasks.size < 2 || meanings.size < 2) continue;
    const [proposal, ...counters] = entries;
    if (proposal === undefined) continue;
    return {
      trigger: "artifact-mismatch",
      topic: `Cross-task artifact mismatch at ${path}`,
      proposal: `${proposal.taskId}: ${proposal.artifact.summary}`,
      counter: counters.map((entry) => `${entry.taskId}: ${entry.artifact.summary}`).join("\n"),
    };
  }
  return null;
}

function describeAlternative(position: string, tradeoffs: readonly string[]): string {
  return `${position}\nTradeoffs: ${tradeoffs.join("; ")}`;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
