/**
 * Module: tools/mcp
 *
 * Local MCP supervisor control tools for testing and operations.
 */

import type { Dialog } from '../dialog';
import { createLogger } from '../log';
import { Team } from '../team';
import type { FuncTool, JsonSchema, ToolArguments } from '../tool';

const log = createLogger('tools/mcp');

type McpRestartArgs = Readonly<{
  serverId: string;
}>;

function parseMcpRestartArgs(args: ToolArguments): McpRestartArgs {
  const serverId = args.serverId;
  if (typeof serverId !== 'string' || !serverId.trim()) {
    throw new Error(`mcp_restart.serverId must be a non-empty string`);
  }
  return { serverId };
}

const mcpRestartSchema: JsonSchema = {
  type: 'object',
  properties: {
    serverId: {
      type: 'string',
      description:
        "MCP server id from `.minds/mcp.yaml` (e.g., 'sdk_stdio'). Restarts this server only.",
    },
  },
  required: ['serverId'],
  additionalProperties: false,
};

export const mcpRestartTool: FuncTool = {
  type: 'func',
  name: 'mcp_restart',
  description:
    'Restart a configured MCP server using the current `.minds/mcp.yaml` config (best-effort).',
  parameters: mcpRestartSchema,
  argsValidation: 'dominds',
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments) => {
    const parsed = parseMcpRestartArgs(args);

    const supervisor = await import('../mcp/supervisor');
    const res = await supervisor.requestMcpServerRestart(parsed.serverId);

    log.warn('mcp_restart', { caller: caller.id, serverId: parsed.serverId, ok: res.ok });

    if (!res.ok) return `error: ${res.errorText}`;
    return `ok: restarted ${parsed.serverId}`;
  },
};

