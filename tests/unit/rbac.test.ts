import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approvalAction, authorize } from "../../src/auth/rbac.js";
import type { Actor, GovernedAction, Role } from "../../src/auth/types.js";

const ACTIONS: readonly GovernedAction[] = [
  "view",
  "run",
  "approve:medium",
  "approve:high",
  "configure",
];

const EXPECTED: Readonly<Record<Role, readonly boolean[]>> = {
  viewer: [true, false, false, false, false],
  developer: [true, true, true, false, false],
  approver: [true, true, true, true, false],
  admin: [true, true, true, true, true],
};

describe("RBAC", () => {
  it("enforces the complete role and action matrix", () => {
    for (const role of Object.keys(EXPECTED) as Role[]) {
      const actor: Actor = { id: role, role, repos: ["/repo"] };
      assert.deepEqual(
        ACTIONS.map((action) => authorize(actor, { repo: "/repo" }, action)),
        EXPECTED[role],
      );
    }
  });

  it("denies missing actors and out-of-scope repositories or teams by default", () => {
    const actor: Actor = {
      id: "dev",
      role: "developer",
      repos: ["/allowed"],
      teams: ["platform"],
    };
    assert.equal(authorize(undefined, { repo: "/allowed" }, "view"), false);
    assert.equal(authorize(actor, {}, "view"), false);
    assert.equal(authorize(actor, { repo: "/other" }, "run"), false);
    assert.equal(authorize(actor, { repo: "/allowed", team: "product" }, "run"), false);
    assert.equal(authorize(actor, { repo: "/allowed", team: "platform" }, "run"), true);
  });

  it("maps risk levels to the required approval action", () => {
    assert.equal(approvalAction("low"), null);
    assert.equal(approvalAction("medium"), "approve:medium");
    assert.equal(approvalAction("high"), "approve:high");
  });
});
