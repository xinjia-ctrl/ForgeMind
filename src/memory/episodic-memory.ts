import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ForgeMindEvent } from "../core/events.js";
import { EventLog } from "../core/event-log.js";
import type { ArtifactRef, TaskContext } from "../core/types.js";
import { keywords } from "./keywords.js";
import type { MemoryProvider, RecallOptions, Retrieval } from "./memory-provider.js";

export interface EpisodicMemoryOptions {
  readonly eventsDirectory: string;
  readonly currentRunId?: string;
}

export class EpisodicMemory implements MemoryProvider {
  readonly #eventsDirectory: string;
  readonly #currentRunId: string | undefined;

  public constructor(options: EpisodicMemoryOptions) {
    this.#eventsDirectory = options.eventsDirectory;
    this.#currentRunId = options.currentRunId;
  }

  public remember(_ctx: TaskContext, _artifact: ArtifactRef): Promise<void> {
    return Promise.resolve();
  }

  public async recall(query: string, options: RecallOptions = {}): Promise<readonly Retrieval[]> {
    if (options.scopes !== undefined && !options.scopes.includes("episodic")) return [];
    const queryTerms = keywords(query);
    let files: readonly string[];
    try {
      files = await readdir(this.#eventsDirectory);
    } catch {
      return [];
    }
    const episodes = await Promise.all(
      files
        .filter((file) => file.endsWith(".jsonl"))
        .map(async (file): Promise<Retrieval | null> => {
          const runId = file.slice(0, -".jsonl".length);
          if (runId === this.#currentRunId) return null;
          let events: readonly ForgeMindEvent[];
          try {
            events = await EventLog.open(this.#eventsDirectory, runId).load();
          } catch {
            return null;
          }
          return episodeRetrieval(queryTerms, file, events, options);
        }),
    );
    return episodes
      .filter((item): item is Retrieval => item !== null)
      .sort((left, right) => right.score - left.score || right.source.localeCompare(left.source))
      .slice(0, options.limit ?? 5);
  }
}

function episodeRetrieval(
  queryTerms: readonly string[],
  file: string,
  events: readonly ForgeMindEvent[],
  options: RecallOptions,
): Retrieval | null {
  const started = events.find((event) => event.type === "run.started");
  const finished = [...events].reverse().find((event) => event.type === "run.finished");
  if (started?.type !== "run.started" || finished?.type !== "run.finished") return null;
  if (options.statuses !== undefined && !options.statuses.includes(finished.data.status))
    return null;
  const requirementTerms = new Set(keywords(started.data.requirement));
  const overlap = queryTerms.filter((term) => requirementTerms.has(term));
  if (queryTerms.length > 0 && overlap.length === 0) return null;
  const rejections = events
    .filter((event) => event.type === "gate.rejected")
    .map((event) => `${event.data.stage}: ${event.data.reason} — ${event.data.feedback}`);
  const failures = events
    .filter((event) => event.type === "stage.failed")
    .map((event) => `${event.data.stage}: ${event.data.error}`);
  const evidence = [...rejections, ...failures];
  const content = [
    `Historical run ${started.data.runId} finished ${finished.data.status}.`,
    `Requirement: ${started.data.requirement}`,
    evidence.length === 0 ? "No rejected gates or stage failures." : evidence.join("\n"),
  ].join("\n");
  return {
    content,
    source: path.join("runs", file),
    score: overlap.length + (finished.data.status === "FAILED" ? 0.25 : 0.1),
    scope: "episodic",
    reason: `requirement keyword overlap: ${overlap.join(", ") || "empty query"}; status=${finished.data.status}`,
  };
}
