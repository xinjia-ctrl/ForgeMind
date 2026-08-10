import { errorMessage } from "../core/errors.js";
import { estimateTokens } from "../core/token-budget.js";
import { objectArgs, stringArg } from "./file-tools.js";
import { runProcess } from "./process.js";
import type { Tool, ToolPolicy, ToolResult } from "./types.js";

export class GitStatusTool implements Tool {
  public readonly name = "git_status";
  public readonly description = "Read porcelain Git status";
  public readonly parameters = { type: "object", properties: {} } as const;

  public async execute(_args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    return await runGitRead(policy, ["status", "--short"]);
  }
}

export class GitDiffTool implements Tool {
  public readonly name = "git_diff";
  public readonly description = "Read the current Git diff, including staged changes";
  public readonly parameters = { type: "object", properties: {} } as const;

  public async execute(_args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const unstaged = await git(policy, ["diff", "--no-ext-diff", "--"]);
      const staged = await git(policy, ["diff", "--cached", "--no-ext-diff", "--"]);
      const untracked = await git(policy, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      let untrackedDiff = "";
      if (untracked.exitCode === 0) {
        const files = untracked.stdout.split("\0").filter(Boolean).slice(0, 100);
        for (const file of files) {
          if (Buffer.byteLength(untrackedDiff) >= policy.maxResultBytes) break;
          const result = await git(policy, [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--",
            "/dev/null",
            file,
          ]);
          // git diff --no-index returns 1 when differences are found.
          if (result.exitCode === 0 || result.exitCode === 1) {
            untrackedDiff += result.stdout;
          }
        }
      }
      const combined = `${unstaged.stdout}${staged.stdout}${untrackedDiff}`;
      const text = Buffer.from(combined).subarray(0, policy.maxResultBytes).toString("utf8");
      return {
        ok:
          unstaged.exitCode === 0 &&
          staged.exitCode === 0 &&
          untracked.exitCode === 0,
        data: {
          diff: text,
          stderr: `${unstaged.stderr}${staged.stderr}${untracked.stderr}`,
        },
        truncated:
          unstaged.truncated ||
          staged.truncated ||
          untracked.truncated ||
          Buffer.byteLength(combined) > policy.maxResultBytes,
        tokenCost: estimateTokens(text),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

export class GitCommitTool implements Tool {
  public readonly name = "git_commit";
  public readonly description = "Stage all workspace changes and create one Git commit";
  public readonly parameters = {
    type: "object",
    required: ["message"],
    properties: { message: { type: "string" } },
  } as const;

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      if (!policy.writable || policy.stage !== "COMMIT") {
        return { ok: false, error: "git_commit requires the COMMIT write policy" };
      }
      const message = stringArg(objectArgs(args), "message").trim();
      if (message.length === 0 || message.length > 200 || message.includes("\0")) {
        return { ok: false, error: "Commit message must contain 1-200 characters" };
      }
      const status = await git(policy, ["status", "--porcelain"]);
      if (status.exitCode !== 0) return processFailure(status);
      if (status.stdout.trim().length === 0) {
        return { ok: false, error: "No changes are available to commit" };
      }
      const add = await git(policy, ["add", "--all", "--"]);
      if (add.exitCode !== 0) return processFailure(add);
      const commit = await git(policy, ["commit", "--no-verify", "-m", message]);
      if (commit.exitCode !== 0) return processFailure(commit);
      const revision = await git(policy, ["rev-parse", "HEAD"]);
      if (revision.exitCode !== 0) return processFailure(revision);
      return {
        ok: true,
        data: { commit: revision.stdout.trim(), output: commit.stdout },
        tokenCost: estimateTokens(commit.stdout),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

async function runGitRead(policy: ToolPolicy, args: readonly string[]): Promise<ToolResult> {
  try {
    const result = await git(policy, args);
    return {
      ok: result.exitCode === 0,
      data: { stdout: result.stdout, stderr: result.stderr },
      ...(result.exitCode === 0 ? {} : { error: `git exited with ${result.exitCode}` }),
      truncated: result.truncated,
      tokenCost: estimateTokens(`${result.stdout}\n${result.stderr}`),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function git(policy: ToolPolicy, args: readonly string[]) {
  return await runProcess("git", args, {
    cwd: policy.workspaceRoot,
    timeoutMs: policy.commandTimeoutMs,
    maxBytes: policy.maxResultBytes,
  });
}

function processFailure(result: Awaited<ReturnType<typeof git>>): ToolResult {
  return {
    ok: false,
    error: result.stderr.trim() || `git exited with ${result.exitCode}`,
    data: result,
    truncated: result.truncated,
  };
}
