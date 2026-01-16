import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger } from '../log';
import type { ToolArguments } from '../tool';

const log = createLogger('mcp/sdk-client');

export type McpListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export class McpSdkClient {
  private readonly serverId: string;
  private readonly client: Client;

  private closed: boolean = false;

  private constructor(params: { serverId: string; client: Client }) {
    this.serverId = params.serverId;
    this.client = params.client;
  }

  static async connectStdio(params: {
    serverId: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<McpSdkClient> {
    const transport = new StdioClientTransport({
      command: params.command,
      args: params.args,
      env: params.env,
      cwd: params.cwd,
      stderr: 'pipe',
    });

    const stderr = transport.stderr;
    if (stderr) {
      stderr.on('data', (chunk: unknown) => {
        const text =
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : String(chunk);
        const trimmed = text.trimEnd();
        if (!trimmed) return;
        log.debug(`[${params.serverId}][stderr] ${trimmed}`);
      });
    }

    return await McpSdkClient.connectWithTransport(params.serverId, transport);
  }

  static async connectStreamableHttp(params: {
    serverId: string;
    url: string;
    headers: Record<string, string>;
    sessionId?: string;
  }): Promise<McpSdkClient> {
    const transport = new StreamableHTTPClientTransport(new URL(params.url), {
      requestInit: { headers: params.headers },
      sessionId: params.sessionId,
    });
    return await McpSdkClient.connectWithTransport(params.serverId, transport);
  }

  private static async connectWithTransport(
    serverId: string,
    transport: Transport,
  ): Promise<McpSdkClient> {
    const client = new Client(
      { name: 'dominds', version: 'dev' },
      {
        capabilities: {},
      },
    );
    await client.connect(transport, { timeout: 15_000 });
    return new McpSdkClient({ serverId, client });
  }

  async listTools(timeoutMs: number = 15_000): Promise<McpListedTool[]> {
    this.ensureOpen();
    const out: McpListedTool[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await this.client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
      for (const t of res.tools) {
        out.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(
    mcpToolName: string,
    args: ToolArguments,
    timeoutMs: number = 60_000,
  ): Promise<string> {
    this.ensureOpen();
    const res = await this.client.callTool({ name: mcpToolName, arguments: args }, undefined, {
      timeout: timeoutMs,
    });
    return stringifyToolCallResult(res);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch (err) {
      log.debug('MCP SDK client close failed', { serverId: this.serverId, err });
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error(`MCP client is closed (${this.serverId})`);
    }
  }
}

function stringifyToolCallResult(value: unknown): string {
  if (!isRecord(value) || Array.isArray(value)) {
    return JSON.stringify(value);
  }

  if ('content' in value) {
    const content = value.content;
    if (!Array.isArray(content)) {
      return JSON.stringify(value);
    }
    const parts: string[] = [];
    for (const item of content) {
      if (isRecord(item) && !Array.isArray(item)) {
        const t = item.type;
        if (t === 'text' && typeof item.text === 'string') {
          parts.push(item.text);
          continue;
        }
      }
      parts.push(JSON.stringify(item));
    }
    const joined = parts.join('\n').trim();
    if (joined) return joined;
    return JSON.stringify(value);
  }

  if ('toolResult' in value) {
    return JSON.stringify(value.toolResult);
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
