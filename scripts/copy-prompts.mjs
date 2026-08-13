import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/src/prompts", { recursive: true });
await cp("src/prompts", "dist/src/prompts", {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
