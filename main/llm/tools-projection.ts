import type { WorkspaceProblem } from '../shared/types/problems';
import type { FuncTool } from '../tool';

export type ProviderToolProjectionResult = {
  tools: FuncTool[];
  problems: WorkspaceProblem[];
};

/**
 * Provider-specific "safe" projection of tools.
 *
 * For now, Dominds passes MCP JSON Schema through to providers as-is, and relies on the
 * shared tool-name validity rule to avoid name rejections across providers.
 */
export function projectFuncToolsForProvider(
  _apiType: string,
  funcTools: FuncTool[],
): ProviderToolProjectionResult {
  return { tools: funcTools, problems: [] };
}
