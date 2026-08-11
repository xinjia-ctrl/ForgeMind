import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateUtf8 } from "../../src/core/text.js";

describe("truncateUtf8", () => {
  it("uses UTF-8 bytes and preserves complete multibyte characters", () => {
    const result = truncateUtf8("你好a", 6);
    assert.deepEqual(result, { text: "你好", truncated: true, bytes: 6 });
    assert.equal(Buffer.byteLength(result.text, "utf8"), 6);
  });

  it("does not split surrogate pairs", () => {
    assert.deepEqual(truncateUtf8("🙂x", 4), {
      text: "🙂",
      truncated: true,
      bytes: 4,
    });
  });

  it("returns the original value when it fits", () => {
    assert.deepEqual(truncateUtf8("plain", 5), {
      text: "plain",
      truncated: false,
      bytes: 5,
    });
  });

  it("rejects invalid byte limits", () => {
    assert.throws(() => truncateUtf8("x", -1), RangeError);
    assert.throws(() => truncateUtf8("x", 1.5), RangeError);
  });
});
