import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTestCommand } from "../../src/runtime/test-command.js";

describe("test command policy", () => {
  it("accepts explicit test runners without a shell", () => {
    assert.deepEqual(parseTestCommand("npm test"), ["npm", "test"]);
    assert.deepEqual(parseTestCommand("npm run test -- --runInBand"), [
      "npm",
      "run",
      "test",
      "--",
      "--runInBand",
    ]);
    assert.deepEqual(parseTestCommand("node --test tests/example.test.js"), [
      "node",
      "--test",
      "tests/example.test.js",
    ]);
  });

  it("rejects shell syntax, arbitrary package commands, and traversal", () => {
    assert.throws(() => parseTestCommand("npm test && curl example.com"));
    assert.throws(() => parseTestCommand("npm exec arbitrary-package"));
    assert.throws(() => parseTestCommand("node --test ../../outside.test.js"));
  });
});
