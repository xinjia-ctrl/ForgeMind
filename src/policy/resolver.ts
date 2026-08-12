import type {
  ActionRequest,
  PolicyDecision,
  PolicyMode,
  PolicyResolver,
  PolicyRule,
} from "./types.js";

export class RulePolicyResolver implements PolicyResolver {
  readonly #defaultMode: PolicyMode;
  readonly #rules: readonly PolicyRule[];

  public constructor(defaultMode: PolicyMode, rules: readonly PolicyRule[]) {
    this.#defaultMode = defaultMode;
    this.#rules = rules;
  }

  public resolve(action: ActionRequest): PolicyDecision {
    let selected: { rule: PolicyRule; score: number; index: number } | undefined;
    this.#rules.forEach((rule, index) => {
      const score = matchScore(rule, action);
      if (
        score !== null &&
        (selected === undefined ||
          score > selected.score ||
          (score === selected.score && index > selected.index))
      ) {
        selected = { rule, score, index };
      }
    });
    if (selected === undefined) {
      return { mode: this.#defaultMode, policy: `default:${this.#defaultMode}` };
    }
    return {
      mode: selected.rule.mode,
      policy: `rule:${selected.index}:${selected.rule.mode}`,
    };
  }
}

function matchScore(rule: PolicyRule, action: ActionRequest): number | null {
  if (rule.match.tool !== action.tool) return null;
  let score = 1;
  if (rule.match.stage !== undefined) {
    if (rule.match.stage !== action.stage) return null;
    score += 2;
  }
  if (rule.match.command !== undefined) {
    if (action.command === undefined || !sameCommand(rule.match.command, action.command))
      return null;
    score += 4;
  }
  return score;
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
