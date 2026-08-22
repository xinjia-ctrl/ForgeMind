import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CiEventPoller } from "../../src/agentic/ci.js";
import { GitHubApiClient, GitHubWorkflowRunPoller } from "../../src/agentic/github.js";
import { JiraApiClient, JiraIssuePoller } from "../../src/agentic/jira.js";

describe("agentic development event pollers", () => {
  it("polls failed GitHub workflows with a stable composite cursor", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const fetcher: typeof fetch = (input, init) => {
      requests.push({ url: requestUrl(input), headers: new Headers(init?.headers) });
      return Promise.resolve(
        jsonResponse({
          workflow_runs: [
            {
              id: 9007199254740993n.toString(),
              name: "CI",
              conclusion: "failure",
              updated_at: "2026-08-21T10:00:00Z",
              head_sha: "abc123",
              html_url: "https://github.example/actions/runs/1",
              pull_requests: [{ number: 77 }],
            },
          ],
        }),
      );
    };
    const poller = new GitHubWorkflowRunPoller({
      client: new GitHubApiClient({
        token: "token",
        baseUrl: "http://localhost:8080",
        fetcher,
      }),
      repository: "acme/api",
    });

    const first = await poller.poll();
    const second = await poller.poll(first.cursor);
    assert.equal(first.events.length, 1);
    const event = first.events[0];
    assert.ok(event);
    assert.equal(event.context["pullRequestNumber"], "77");
    assert.equal(second.events.length, 0);
    assert.match(first.cursor ?? "", /9007199254740993/);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.headers.get("x-github-api-version"), "2026-03-10");
    assert.equal(request.headers.get("user-agent"), "ForgeMind-Agentic");
  });

  it("polls Jira search/jql incrementally and emits normalized issues", async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = (_input, init) => {
      const body = parsedBody(init);
      assert.notEqual(body, undefined);
      bodies.push(body);
      return Promise.resolve(
        jsonResponse({
          issues: [
            {
              id: "10007",
              key: "FM-7",
              self: "https://acme.atlassian.net/rest/api/3/issue/10007",
              fields: {
                summary: "Fix API",
                updated: "2026-08-21T10:05:00Z",
                labels: ["agentic"],
                status: { name: "Open" },
              },
            },
          ],
        }),
      );
    };
    const poller = new JiraIssuePoller({
      client: new JiraApiClient({
        baseUrl: "http://localhost:8080",
        authentication: { email: "bot@example.com", apiToken: "token" },
        fetcher,
      }),
      repository: "acme/api",
      jql: "project = FM",
    });

    const first = await poller.poll();
    const second = await poller.poll(first.cursor);
    assert.equal(first.events[0]?.object.id, "FM-7");
    assert.equal(second.events.length, 0);
    const secondBody = bodies[1] as { readonly jql?: string };
    assert.match(secondBody.jql ?? "", /project = FM/);
    assert.match(secondBody.jql ?? "", /updated >=/);
  });

  it("adapts a vendor CI poll source without coupling cursor semantics", async () => {
    const cursors: Array<string | undefined> = [];
    const poller = new CiEventPoller({
      id: "buildkite",
      repository: "acme/api",
      source: {
        poll(cursor) {
          cursors.push(cursor);
          return Promise.resolve({
            cursor: "vendor-cursor-2",
            deliveries: [
              {
                id: "build-2",
                payload: {
                  id: "2",
                  status: "failure",
                  timestamp: "2026-08-21T10:10:00Z",
                  branch: "main",
                },
              },
            ],
          });
        },
      },
    });
    const result = await poller.poll("vendor-cursor-1");
    assert.deepEqual(cursors, ["vendor-cursor-1"]);
    assert.equal(result.cursor, "vendor-cursor-2");
    assert.equal(result.events[0]?.type, "ci.failed");
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function parsedBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a string request body");
  return JSON.parse(body) as unknown;
}
