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
      modelContextLimitTokens?: number;
      effectiveOptimalMaxTokens?: number;
      optimalMaxTokensConfigured?: number;
    }
  | {
      kind: 'available';
      promptTokens: number;
      completionTokens: number;
      totalTokens?: number;
      modelContextLimitTokens: number;
      effectiveOptimalMaxTokens: number;
      optimalMaxTokensConfigured?: number;
      hardUtil: number;
      optimalUtil: number;
      level: ContextHealthLevel;
    };
