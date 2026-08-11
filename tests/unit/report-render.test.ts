import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventDataMap, EventType, ForgeMindEvent } from "../../src/core/events.js";
import { escapeHtml, renderReportHtml } from "../../src/report/render-html.js";
import { buildReportViewModel } from "../../src/report/view-model.js";

describe("report HTML rendering", () => {
  it("escapes every HTML control character", () => {
    assert.equal(
      escapeHtml(`<tag attr="value">Tom & 'Ada'</tag>`),
      "&lt;tag attr=&quot;value&quot;&gt;Tom &amp; &#39;Ada&#39;&lt;/tag&gt;",
    );
  });

  it("renders a self-contained, escaped, and re-audited failure report", () => {
    const model = buildReportViewModel([
      event(1, "run.started", {
        runId: "secure-run",
        requirement: "Render <script>alert('requirement')</script>",
        branch: "forgemind/secure-run",
      }),
      event(2, "stage.started", { runId: "secure-run", stage: "CODE", attempt: 1 }),
      event(3, "tool.called", {
        runId: "secure-run",
        stage: "CODE",
        tool: "write_file",
        args: {
          path: "index.ts",
          content: "TOP SECRET <script>alert(1)</script>",
          token: "sensitive-token",
          search: "PRIVATE SEARCH",
        },
        result: {
          ok: false,
          content: "PRIVATE RESULT",
          error: "write denied",
          data: {
            diff: "PRIVATE DIFF",
            stdout: "PRIVATE STDOUT",
            matches: [{ path: "index.ts", line: 1, text: "PRIVATE SOURCE LINE" }],
          },
        },
        policy: "workspace write",
      }),
      event(4, "artifact.produced", {
        runId: "secure-run",
        stage: "CODE",
        path: `"><img src=x onerror=alert(1)>`,
        kind: "source",
        summary: "Unsafe-looking path fixture",
      }),
      event(5, "stage.failed", {
        runId: "secure-run",
        stage: "CODE",
        kind: "HARD",
        error: "Policy <b>denied</b>",
      }),
      event(6, "run.finished", {
        runId: "secure-run",
        status: "FAILED",
        summary: "Policy denied",
      }),
    ]);

    const html = renderReportHtml(model);

    assert.match(html, /^<!doctype html>/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /&lt;script&gt;alert\(&#39;requirement&#39;\)&lt;\/script&gt;/);
    assert.match(html, /Policy &lt;b&gt;denied&lt;\/b&gt;/);
    assert.match(html, /&lt;redacted:.*bytes&gt;/);
    assert.doesNotMatch(
      html,
      /TOP SECRET|PRIVATE RESULT|PRIVATE SEARCH|PRIVATE DIFF|PRIVATE STDOUT|PRIVATE SOURCE LINE|sensitive-token/,
    );
    assert.doesNotMatch(html, /<script>alert|<img src=x/i);
    assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
    assert.doesNotMatch(html, /@import/i);
    assert.match(html, /Stage statistics/);
    assert.match(html, /Workflow timeline/);

    const tamperedHtml = renderReportHtml({
      ...model,
      status: `FAILED" onmouseover="alert(2)` as typeof model.status,
    });
    assert.doesNotMatch(tamperedHtml, /class="status [^"]*"\s+onmouseover=/i);
  });
});

function event<K extends EventType>(
  seq: number,
  type: K,
  data: EventDataMap[K],
): Extract<ForgeMindEvent, { readonly type: K }> {
  return {
    v: 1,
    seq,
    ts: new Date(seq * 1_000).toISOString(),
    type,
    data,
  } as Extract<ForgeMindEvent, { readonly type: K }>;
}
