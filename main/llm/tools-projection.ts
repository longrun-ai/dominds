import type { WorkspaceProblem } from '../shared/types/problems';
import type { FuncTool } from '../tool';

export type ProviderToolProjectionResult = {
  tools: FuncTool[];
  problems: WorkspaceProblem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireAllObjectProperties(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const schemaType = 'type' in schema ? schema.type : undefined;
  if (schemaType !== undefined && schemaType !== 'object') return schema;

  const props = 'properties' in schema ? schema.properties : undefined;
  if (!isRecord(props)) return schema;

  const required = Object.keys(props);
  return { ...schema, required };
}

/**
 * Provider-specific "safe" projection of tools.
 *
 * For now, Dominds passes MCP JSON Schema through to providers as-is, and relies on the
 * shared tool-name validity rule to avoid name rejections across providers.
 */
export function projectFuncToolsForProvider(
  apiType: string,
  funcTools: FuncTool[],
): ProviderToolProjectionResult {
  // Codex requires function tool schemas to mark all parameters as required (no optional fields).
  // Optional semantics must be represented via sentinel values (e.g., '' / 0 / false) and handled
  // in tool implementations and docs.
  if (apiType === 'codex') {
    const tools: FuncTool[] = funcTools.map((tool) => ({
      ...tool,
      parameters: requireAllObjectProperties(tool.parameters) as FuncTool['parameters'],
    }));
    return { tools, problems: [] };
  }
  return { tools: funcTools, problems: [] };
}
