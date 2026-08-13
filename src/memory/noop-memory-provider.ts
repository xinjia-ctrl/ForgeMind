import type { ArtifactRef, TaskContext } from "../core/types.js";
import type { MemoryProvider, Retrieval } from "./memory-provider.js";

export class NoopMemoryProvider implements MemoryProvider {
  public remember(_ctx: TaskContext, _artifact: ArtifactRef): Promise<void> {
    // Memory remains an explicit opt-in enhancement.
    return Promise.resolve();
  }

  public recall(_query: string): Promise<readonly Retrieval[]> {
    return Promise.resolve([]);
  }
}
