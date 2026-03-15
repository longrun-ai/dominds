import type { WorkspaceProblem } from '@longrun-ai/kernel/types/problems';
import type { FuncTool } from '../tool';

export type ProviderToolProjectionResult = {
  tools: FuncTool[];
  problems: WorkspaceProblem[];
};

/**
 * Provider-specific "safe" projection of tools.
 *
 * Dominds passes function-tool JSON Schema through to providers as-is and relies on shared
 * tool-name validity rules to avoid name rejections across providers.
 */
export function projectFuncToolsForProvider(
  _apiType: string,
  funcTools: FuncTool[],
): ProviderToolProjectionResult {
  return { tools: funcTools, problems: [] };
}
