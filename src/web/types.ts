import type { RunStatus, StageId } from "../core/types.js";
import type { ProviderId } from "../llm/provider-catalog.js";

export interface WebRunRequest {
  readonly repoPath: string;
  readonly requirement: string;
  readonly providerId: ProviderId;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxRework: number;
  readonly structuredOutput: boolean;
  readonly configPath?: string;
  readonly approveAll: boolean;
}

export interface WebRunResult {
  readonly status: RunStatus;
  readonly summary: string;
  readonly branch: string;
  readonly eventLogPath: string;
  readonly reportPath?: string;
}

export interface WebRunProgress {
  readonly stage?: StageId;
  readonly completedStages: readonly StageId[];
}

export interface WebRunView extends WebRunProgress {
  readonly id: string;
  readonly status: "RUNNING" | RunStatus | "ERROR";
  readonly repoPath: string;
  readonly requirement: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly branch?: string;
  readonly eventLogPath?: string;
  readonly reportAvailable: boolean;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface DirectoryListing {
  readonly root: string;
  readonly current: string;
  readonly parent: string | null;
  readonly entries: readonly DirectoryEntry[];
}

export interface RepositoryInspection {
  readonly root: string;
  readonly branch: string;
  readonly clean: boolean;
}

export interface WebUiDefaults {
  readonly providerId: ProviderId;
  readonly baseUrl: string;
  readonly model: string;
  readonly temperature: number | null;
  readonly maxRework: number;
  readonly structuredOutput: boolean;
  readonly providers: readonly WebProviderOption[];
  readonly configPath: string | null;
  readonly homeDirectory: string;
}

export interface WebProviderOption {
  readonly id: ProviderId;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnvironment: string;
  readonly apiKeyConfigured: boolean;
  readonly defaultModel: string;
  readonly models: readonly WebProviderModelOption[];
  readonly compatibility: string;
}

export interface WebProviderModelOption {
  readonly id: string;
  readonly label: string;
}
