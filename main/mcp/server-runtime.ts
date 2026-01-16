import { createLogger } from '../log';
import type { FuncTool, ToolArguments } from '../tool';
import type { McpListedTool, McpSdkClient } from './sdk-client';

const log = createLogger('mcp/server-runtime');

export type McpServerRuntimeParams = {
  serverId: string;
  toolsetName: string;
  client: McpSdkClient;
  listedTools: McpListedTool[];
};

export class McpServerRuntime {
  public readonly serverId: string;
  public readonly toolsetName: string;
  public readonly listedTools: readonly McpListedTool[];

  private readonly client: McpSdkClient;
  private inFlightCount: number = 0;
  private stopRequested: boolean = false;
  private closed: boolean = false;
  private forceKillTimer: NodeJS.Timeout | undefined;

  constructor(params: McpServerRuntimeParams) {
    this.serverId = params.serverId;
    this.toolsetName = params.toolsetName;
    this.client = params.client;
    this.listedTools = params.listedTools;
  }

  public makeFuncTool(params: {
    domindsToolName: string;
    mcpToolName: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }): FuncTool {
    return {
      type: 'func',
      name: params.domindsToolName,
      description: params.description,
      parameters: params.inputSchema,
      argsValidation: 'passthrough',
      call: async (_dlg, _caller, args: ToolArguments) => {
        return await this.callTool(params.mcpToolName, args);
      },
    };
  }

  public async callTool(mcpToolName: string, args: ToolArguments): Promise<string> {
    if (this.closed) {
      throw new Error(`MCP server ${this.serverId} is closed`);
    }
    this.inFlightCount++;
    try {
      return await this.client.callTool(mcpToolName, args);
    } finally {
      this.inFlightCount--;
      if (this.stopRequested && this.inFlightCount <= 0) {
        await this.closeNow();
      }
    }
  }

  public requestStop(params?: { forceKillAfterMs?: number }): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    const forceKillAfterMs = params?.forceKillAfterMs ?? 30_000;
    if (this.inFlightCount <= 0) {
      void this.closeNow();
      return;
    }
    if (!this.forceKillTimer) {
      this.forceKillTimer = setTimeout(() => {
        log.warn(`Force-killing MCP server after timeout`, { serverId: this.serverId });
        void this.closeNow();
      }, forceKillAfterMs);
    }
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = undefined;
    }
    await this.client.close();
  }
}
