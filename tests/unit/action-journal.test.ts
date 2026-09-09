import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { FileActionJournal } from "../../src/core/action-journal.js";

it("persists PLANNED → EXECUTED → VERIFIED transitions and rejects drift", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgemind-action-journal-"));
  try {
    const journal = new FileActionJournal(path.join(directory, "actions.json"));
    const expectation = { beforeHash: "before", expectedAfterHash: "after" };
    const planned = await journal.planned("CODE:1:1:1", "write:a", expectation);
    assert.equal(planned.state, "PLANNED");
    assert.equal(planned.beforeHash, "before");
    assert.equal(planned.expectedAfterHash, "after");
    assert.equal((await journal.executed("CODE:1:1:1")).state, "EXECUTED");
    const verified = await journal.verified("CODE:1:1:1", "fingerprint");
    assert.equal(verified.state, "VERIFIED");
    assert.equal(verified.workspaceFingerprint, "fingerprint");
    assert.equal(
      (await new FileActionJournal(path.join(directory, "actions.json")).get("CODE:1:1:1"))?.state,
      "VERIFIED",
    );
    await assert.rejects(
      () => journal.planned("CODE:1:1:1", "different-action", expectation),
      /Action journal conflict/,
    );
    await assert.rejects(
      () =>
        journal.planned("CODE:1:1:1", "write:a", {
          beforeHash: "different-before",
          expectedAfterHash: "after",
        }),
      /Action journal conflict/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
