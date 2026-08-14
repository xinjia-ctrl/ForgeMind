import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actorById, parseActorPolicy } from "../../src/auth/policy-source.js";

describe("actor policy source", () => {
  it("parses strict role and scope mappings", () => {
    const source = parseActorPolicy(
      JSON.stringify({
        actors: [
          {
            id: "alice",
            role: "approver",
            repos: ["/repos/api"],
            teams: ["platform"],
          },
        ],
      }),
    );
    assert.deepEqual(actorById(source, "alice"), {
      id: "alice",
      role: "approver",
      repos: ["/repos/api"],
      teams: ["platform"],
    });
    assert.equal(actorById(source, "missing"), undefined);
  });

  it("rejects unknown fields, roles, duplicate actors, and duplicate scopes", () => {
    for (const policy of [
      { actors: [{ id: "a", role: "owner" }] },
      { actors: [{ id: "a", role: "viewer", token: "secret" }] },
      {
        actors: [
          { id: "a", role: "viewer" },
          { id: "a", role: "admin" },
        ],
      },
      { actors: [{ id: "a", role: "developer", repos: ["/repo", "/repo"] }] },
    ]) {
      assert.throws(() => parseActorPolicy(JSON.stringify(policy)));
    }
  });
});
