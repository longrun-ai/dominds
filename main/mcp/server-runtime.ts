import { createLogger } from '../log';
import type { ToolArguments } from '../tool';
import type { McpSdkClient } from './sdk-client';

const log = createLogger('mcp/server-runtime');

export type McpServerRuntimeParams = {
  serverId: string;
  toolsetName: string;
  client: McpSdkClient;
};

export class McpServerRuntime {
  public readonly serverId: string;
  public readonly toolsetName: string;

  private readonly client: McpSdkClient;
  private inFlightCount: number = 0;
  private stopRequested: boolean = false;
  private closed: boolean = false;
  private forceKillTimer: NodeJS.Timeout | undefined;

  constructor(params: McpServerRuntimeParams) {
    this.serverId = params.serverId;
    this.toolsetName = params.toolsetName;
    this.client = params.client;
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

  public async callToolRaw(mcpToolName: string, args: ToolArguments): Promise<unknown> {
    if (this.closed) {
      throw new Error(`MCP server ${this.serverId} is closed`);
    }
    this.inFlightCount++;
    try {
      return await this.client.callToolRaw(mcpToolName, args);
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
