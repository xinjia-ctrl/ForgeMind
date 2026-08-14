import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HardFailure } from "../../src/core/errors.js";
import { normalizeDevelopmentEvent } from "../../src/agentic/normalize.js";

describe("development event normalization", () => {
  it("normalizes GitHub issue and CI events into one bounded contract", () => {
    const issue = normalizeDevelopmentEvent({
      source: "github",
      event: "issues",
      deliveryId: "delivery-1",
      receivedAt: "2026-08-14T08:00:00Z",
      payload: {
        action: "labeled",
        repository: { full_name: "acme/api" },
        sender: { login: "alice" },
        issue: {
          number: 42,
          title: "Build audit endpoint",
          html_url: "https://example.invalid/acme/api/issues/42",
          updated_at: "2026-08-14T07:59:00Z",
          state: "open",
          labels: [{ name: "forgemind:build" }, { name: "backend" }],
        },
      },
    });

    assert.deepEqual(issue, {
      id: "github:delivery-1",
      source: "github",
      type: "issue.updated",
      repo: "acme/api",
      object: {
        kind: "issue",
        id: "42",
        title: "Build audit endpoint",
        url: "https://example.invalid/acme/api/issues/42",
      },
      occurredAt: "2026-08-14T07:59:00.000Z",
      actor: "alice",
      labels: ["backend", "forgemind:build"],
      context: { action: "labeled", state: "open" },
    });

    const failure = normalizeDevelopmentEvent({
      source: "github",
      event: "workflow_run",
      deliveryId: "delivery-2",
      payload: {
        repository: { full_name: "acme/api" },
        workflow_run: {
          id: 99,
          name: "verify",
          conclusion: "failure",
          head_sha: "abc123",
          updated_at: "2026-08-14T08:01:00Z",
        },
      },
      receivedAt: "2026-08-14T08:02:00Z",
    });
    assert.equal(failure?.type, "ci.failed");
    assert.equal(failure.object.id, "99");
    assert.equal(failure.context["workflow"], "verify");
  });

  it("normalizes Jira assignment and filters irrelevant PR comments", () => {
    const assigned = normalizeDevelopmentEvent({
      source: "jira",
      event: "jira:issue_updated",
      deliveryId: "jira-1",
      repository: "acme/web",
      receivedAt: "2026-08-14T09:00:00Z",
      payload: {
        issue: {
          key: "WEB-7",
          fields: {
            summary: "Repair login",
            updated: "2026-08-14T08:58:00Z",
            labels: ["forgemind:build"],
            status: { name: "In Progress" },
          },
        },
        changelog: { items: [{ field: "assignee" }] },
        user: { accountId: "jira-user" },
      },
    });
    assert.equal(assigned?.type, "issue.assigned");
    assert.equal(assigned.actor, "jira-user");
    assert.equal(assigned.repo, "acme/web");

    const ignored = normalizeDevelopmentEvent({
      source: "github",
      event: "pull_request_review_comment",
      deliveryId: "comment-1",
      receivedAt: "2026-08-14T09:00:00Z",
      payload: {
        repository: { full_name: "acme/web" },
        pull_request: { number: 5 },
        comment: { id: 8, body: "Looks good" },
      },
    });
    assert.equal(ignored, null);
  });

  it("fails closed when required event identity or repository data is malformed", () => {
    assert.throws(
      () =>
        normalizeDevelopmentEvent({
          source: "ci",
          event: "build.finished",
          deliveryId: "ci-1",
          receivedAt: "not-a-time",
          payload: { id: "build-1", status: "failed" },
        }),
      HardFailure,
    );
  });
});
