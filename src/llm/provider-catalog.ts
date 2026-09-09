export const PROVIDER_IDS = [
  "openai",
  "deepseek",
  "bigmodel",
  "dashscope",
  "moonshot",
  "custom",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderModelDefinition {
  readonly id: string;
  readonly label: string;
}

export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnvironments: readonly string[];
  readonly defaultModel: string;
  readonly models: readonly ProviderModelDefinition[];
  readonly compatibility: string;
}

export interface ProviderCredential {
  readonly apiKey: string;
  readonly environment: string;
}

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvironments: ["OPENAI_API_KEY"],
    defaultModel: "gpt-5.4-mini",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4 · 复杂编码" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini · 推荐" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini · 稳定快速" },
    ],
    compatibility: "JSON Schema 结构化输出",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnvironments: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-v4-flash",
    models: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash · 推荐" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro · 高质量" },
    ],
    compatibility: "非思考模式 + JSON Object",
  },
  {
    id: "bigmodel",
    label: "智谱 BigModel",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnvironments: ["BIGMODEL_API_KEY", "ZHIPU_API_KEY"],
    defaultModel: "glm-4.7-flash",
    models: [
      { id: "glm-5.2", label: "GLM-5.2 · 最新旗舰" },
      { id: "glm-5.1", label: "GLM-5.1" },
      { id: "glm-5-turbo", label: "GLM-5 Turbo" },
      { id: "glm-4.7-flash", label: "GLM-4.7 Flash · 推荐" },
      { id: "glm-4.7-flashx", label: "GLM-4.7 FlashX" },
      { id: "glm-4.7", label: "GLM-4.7" },
    ],
    compatibility: "非思考模式 + JSON Object",
  },
  {
    id: "dashscope",
    label: "阿里云百炼 / 千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvironments: ["DASHSCOPE_API_KEY"],
    defaultModel: "qwen3.7-flash",
    models: [
      { id: "qwen3.8-max", label: "Qwen3.8 Max · 旗舰" },
      { id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
      { id: "qwen3.7-flash", label: "Qwen3.7 Flash · 推荐" },
    ],
    compatibility: "JSON Object 结构化输出",
  },
  {
    id: "moonshot",
    label: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnvironments: ["MOONSHOT_API_KEY"],
    defaultModel: "kimi-k2.6",
    models: [
      { id: "kimi-k2.6", label: "Kimi K2.6 · 推荐" },
      { id: "kimi-k2.5", label: "Kimi K2.5" },
      { id: "kimi-k2", label: "Kimi K2" },
      { id: "kimi-k2-thinking", label: "Kimi K2 Thinking" },
    ],
    compatibility: "JSON Schema 结构化输出",
  },
  {
    id: "custom",
    label: "自定义 OpenAI-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvironments: ["OPENAI_API_KEY"],
    defaultModel: "",
    models: [],
    compatibility: "使用自定义地址和模型名",
  },
];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerDefinition(providerId: ProviderId): ProviderDefinition {
  const definition = PROVIDER_CATALOG.find((candidate) => candidate.id === providerId);
  if (definition === undefined) throw new Error(`Unknown provider: ${providerId}`);
  return definition;
}

export function configuredProviderId(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderId {
  const explicit = environment["FORGEMIND_PROVIDER"]?.trim();
  if (explicit !== undefined && isProviderId(explicit)) return explicit;
  return inferProviderId(environment["OPENAI_BASE_URL"]);
}

export function inferProviderId(baseUrl: string | undefined): ProviderId {
  if (baseUrl === undefined || baseUrl.trim().length === 0) return "openai";
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === "api.openai.com") return "openai";
    if (hostname === "api.deepseek.com") return "deepseek";
    if (hostname === "open.bigmodel.cn") return "bigmodel";
    if (hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".maas.aliyuncs.com")) {
      return "dashscope";
    }
    if (hostname === "api.moonshot.cn" || hostname === "api.moonshot.ai") return "moonshot";
  } catch {
    return "custom";
  }
  return "custom";
}

export function resolveProviderApiKey(
  providerId: ProviderId,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return resolveProviderCredential(providerId, environment)?.apiKey;
}

export function resolveProviderCredential(
  providerId: ProviderId,
  environment: Readonly<Record<string, string | undefined>>,
): ProviderCredential | undefined {
  const definition = providerDefinition(providerId);
  for (const key of definition.apiKeyEnvironments) {
    if (key === "OPENAI_API_KEY") continue;
    const configured = nonEmpty(environment[key]);
    if (configured !== undefined) return { apiKey: configured, environment: key };
  }

  const legacyKey = nonEmpty(environment["OPENAI_API_KEY"]);
  if (legacyKey === undefined) return undefined;
  const defaultProviderId = configuredProviderId(environment);
  if (providerId === defaultProviderId) return legacyCredential();
  if (providerId === "custom" && defaultProviderId === "openai") return legacyCredential();
  if ((providerId === "openai" || providerId === "custom") && hasDedicatedDefaultKey()) {
    return legacyCredential();
  }
  return undefined;

  function legacyCredential(): ProviderCredential {
    return { apiKey: legacyKey as string, environment: "OPENAI_API_KEY" };
  }

  function hasDedicatedDefaultKey(): boolean {
    return providerDefinition(defaultProviderId).apiKeyEnvironments.some(
      (key) => key !== "OPENAI_API_KEY" && nonEmpty(environment[key]) !== undefined,
    );
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}
