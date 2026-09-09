import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FatalFailure } from "./errors.js";

export interface RunArtifactStore {
  write(name: "plan.md" | "architecture.md", content: string): Promise<string>;
}

export class FileRunArtifactStore implements RunArtifactStore {
  readonly #directory: string;

  public constructor(directory: string) {
    this.#directory = path.resolve(directory);
  }

  public async write(name: "plan.md" | "architecture.md", content: string): Promise<string> {
    await mkdir(this.#directory, { recursive: true });
    const target = path.join(this.#directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
      return target;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new FatalFailure(`Cannot persist run artifact ${name}`, { cause: error });
    }
  }
}
