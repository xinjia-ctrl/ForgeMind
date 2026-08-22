import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("dist", "tests", "smoke");
const files = (await readdir(directory))
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join(directory, file));

if (files.length === 0) throw new Error("No compiled smoke tests found");

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, FORGEMIND_REQUIRE_EXTERNAL_SMOKE: "1" },
});

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
