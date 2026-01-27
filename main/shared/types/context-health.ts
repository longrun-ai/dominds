export type LlmUsageStats =
  | {
      kind: 'unavailable';
    }
  | {
      kind: 'available';
      promptTokens: number;
      completionTokens: number;
      totalTokens?: number;
    };

export type ContextHealthLevel = 'healthy' | 'caution' | 'critical';

export type ContextHealthSnapshot =
  | {
      kind: 'unavailable';
      reason: 'usage_unavailable' | 'model_limit_unavailable';
      modelContextWindowText?: string;
      modelContextLimitTokens?: number;
      effectiveOptimalMaxTokens?: number;
      optimalMaxTokensConfigured?: number;
      effectiveCriticalMaxTokens?: number;
      criticalMaxTokensConfigured?: number;
    }
  | {
      kind: 'available';
      promptTokens: number;
      completionTokens: number;
      totalTokens?: number;
      modelContextWindowText?: string;
      modelContextLimitTokens: number;
      effectiveOptimalMaxTokens: number;
      optimalMaxTokensConfigured?: number;
      effectiveCriticalMaxTokens: number;
      criticalMaxTokensConfigured?: number;
      hardUtil: number;
      optimalUtil: number;
      level: ContextHealthLevel;
    };
