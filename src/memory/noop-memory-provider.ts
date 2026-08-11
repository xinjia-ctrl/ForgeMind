import type { ArtifactRef, TaskContext } from "../core/types.js";
import type { MemoryProvider, Retrieval } from "./memory-provider.js";

export class NoopMemoryProvider implements MemoryProvider {
  public remember(_ctx: TaskContext, _artifact: ArtifactRef): Promise<void> {
    // MVP intentionally has no cross-run memory.
    return Promise.resolve();
  }

  public recall(_query: string): Promise<readonly Retrieval[]> {
    return Promise.resolve([]);
  }
}
