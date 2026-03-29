import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../log';
import type { ToolArguments } from '../tool';

const log = createLogger('mcp/sdk-client');
const STREAMABLE_HTTP_DIAG_TIMEOUT_MS = 5_000;
const HTTP_BODY_PREVIEW_LIMIT = 280;

export type McpDiagnosticTextI18n = Readonly<{
  en: string;
  zh: string;
}>;

type HttpProbeResult =
  | Readonly<{
      kind: 'response';
      method: 'GET' | 'POST';
      url: string;
      status: number;
      statusText: string;
      contentType: string | null;
      bodyPreview: string;
    }>
  | Readonly<{
      kind: 'network_error';
      method: 'GET' | 'POST';
      url: string;
      errorText: string;
    }>;

export type McpListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export class McpDiagnosticError extends Error {
  public readonly detailTextI18n: McpDiagnosticTextI18n;

  constructor(detailTextI18n: McpDiagnosticTextI18n) {
    super(detailTextI18n.en);
    this.name = 'McpDiagnosticError';
    this.detailTextI18n = detailTextI18n;
  }
}

export function extractMcpDiagnosticTextI18n(err: unknown): McpDiagnosticTextI18n | undefined {
  return err instanceof McpDiagnosticError ? err.detailTextI18n : undefined;
}

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
    const endpointUrl = new URL(params.url);
    const transport = new StreamableHTTPClientTransport(endpointUrl, {
      requestInit: { headers: params.headers },
      sessionId: params.sessionId,
    });
    try {
      return await McpSdkClient.connectWithTransport(params.serverId, transport);
    } catch (err: unknown) {
      try {
        await transport.close();
      } catch {
        // best-effort
      }
      throw new McpDiagnosticError(
        await diagnoseStreamableHttpConnectFailure({
          serverId: params.serverId,
          endpointUrl,
          headers: params.headers,
          originalError: err,
        }),
      );
    }
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

  async callToolRaw(
    mcpToolName: string,
    args: ToolArguments,
    timeoutMs: number = 60_000,
  ): Promise<unknown> {
    this.ensureOpen();
    return await this.client.callTool({ name: mcpToolName, arguments: args }, undefined, {
      timeout: timeoutMs,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch (err) {
      log.debug('MCP SDK client close failed', err, { serverId: this.serverId });
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

        if (t === 'image') {
          const mimeType = typeof item.mimeType === 'string' ? item.mimeType : 'unknown';
          const data = item.data;
          const dataSize = typeof data === 'string' ? data.length : 0;
          parts.push(
            JSON.stringify({
              type: 'image',
              mimeType,
              data: `[omitted base64; length=${dataSize}]`,
            }),
          );
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

async function diagnoseStreamableHttpConnectFailure(params: {
  serverId: string;
  endpointUrl: URL;
  headers: Record<string, string>;
  originalError: unknown;
}): Promise<McpDiagnosticTextI18n> {
  const postProbeBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 'dominds-streamable-http-diagnostic',
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'dominds',
        version: 'dev-diagnostic',
      },
    },
  });

  const [postProbe, healthProbe] = await Promise.all([
    runHttpProbe({
      method: 'POST',
      url: params.endpointUrl,
      headers: {
        ...params.headers,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: postProbeBody,
    }),
    runHttpProbe({
      method: 'GET',
      url: new URL('/health', params.endpointUrl),
      headers: {},
    }),
  ]);

  return {
    en: [
      `MCP streamable_http connect failed for server '${params.serverId}' (endpoint: ${params.endpointUrl.toString()}).`,
      `Original SDK error: ${formatUnknownError(params.originalError)}`,
      `Probe summary: ${formatHttpProbe(postProbe, 'en')}; ${formatHttpProbe(healthProbe, 'en')}`,
      `Likely cause: ${inferStreamableHttpLikelyCause(postProbe, healthProbe, 'en')}`,
      `Suggested next step: ${buildStreamableHttpRepairHint(params.serverId, postProbe, healthProbe, 'en')}`,
    ].join('\n'),
    zh: [
      `MCP streamable_http 连接失败：服务 '${params.serverId}'，端点 ${params.endpointUrl.toString()}。`,
      `SDK 返回的原始错误：${formatUnknownError(params.originalError)}`,
      `探测结果：${formatHttpProbe(postProbe, 'zh')}；${formatHttpProbe(healthProbe, 'zh')}`,
      `判断：${inferStreamableHttpLikelyCause(postProbe, healthProbe, 'zh')}`,
      `建议：${buildStreamableHttpRepairHint(params.serverId, postProbe, healthProbe, 'zh')}`,
    ].join('\n'),
  };
}

async function runHttpProbe(params: {
  method: 'GET' | 'POST';
  url: URL;
  headers: Record<string, string>;
  body?: string;
}): Promise<HttpProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAMABLE_HTTP_DIAG_TIMEOUT_MS);
  try {
    const response = await fetch(params.url, {
      method: params.method,
      headers: params.headers,
      body: params.body,
      signal: controller.signal,
    });
    const responseText = await response.text().catch(() => '');
    return {
      kind: 'response',
      method: params.method,
      url: params.url.toString(),
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      bodyPreview: formatBodyPreview(responseText),
    };
  } catch (err: unknown) {
    return {
      kind: 'network_error',
      method: params.method,
      url: params.url.toString(),
      errorText: formatUnknownError(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatHttpProbe(result: HttpProbeResult, language: 'en' | 'zh'): string {
  if (result.kind === 'network_error') {
    return language === 'zh'
      ? `${result.method} ${result.url} -> 网络错误：${result.errorText}`
      : `${result.method} ${result.url} -> network error: ${result.errorText}`;
  }
  const contentType =
    result.contentType !== null && result.contentType.trim() !== '' ? result.contentType : '<none>';
  return language === 'zh'
    ? `${result.method} ${result.url} -> HTTP ${result.status}；content-type=${contentType}；响应体=${result.bodyPreview}`
    : `${result.method} ${result.url} -> ${result.status} ${result.statusText}; content-type=${contentType}; body=${result.bodyPreview}`;
}

function inferStreamableHttpLikelyCause(
  postProbe: HttpProbeResult,
  healthProbe: HttpProbeResult,
  language: 'en' | 'zh',
): string {
  if (postProbe.kind === 'network_error') {
    if (healthProbe.kind === 'response' && healthProbe.status >= 200 && healthProbe.status < 300) {
      return language === 'zh'
        ? '主机是通的，但这个 MCP 端点没法作为 MCP 的 POST 路由访问。'
        : 'the host is reachable, but the configured MCP endpoint could not be reached as an MCP POST route';
    }
    return language === 'zh'
      ? '这个 MCP URL 现在连不上；要么服务没起来，要么还没提供 MCP 就先崩了。'
      : 'the target service is not reachable on the configured MCP URL, or it crashed before serving MCP';
  }

  if (postProbe.status === 404) {
    return language === 'zh'
      ? '这个 MCP URL 没指到实际存在的 MCP 路由。'
      : 'the configured MCP URL does not map to a live MCP route';
  }
  if (postProbe.status === 401 || postProbe.status === 403) {
    return language === 'zh'
      ? 'MCP 端点把请求拒了，多半是认证头缺失或不对。'
      : 'the MCP endpoint rejected the request due to missing or invalid auth headers';
  }
  if (postProbe.status >= 500) {
    if (healthProbe.kind === 'response' && healthProbe.status >= 200 && healthProbe.status < 300) {
      return language === 'zh'
        ? '目标进程还活着，但 MCP 处理入口在服务端先报错了，还没来得及返回合法响应。'
        : 'the target process is up, but its MCP handler is failing server-side before returning a valid MCP response';
    }
    return language === 'zh'
      ? 'MCP 服务在服务端先报错了，还没来得及返回合法响应。'
      : 'the MCP server is failing server-side before returning a valid MCP response';
  }
  if (postProbe.status >= 400) {
    return language === 'zh'
      ? '端点能通，但在握手完成前就把 MCP initialize 探测拒掉了。'
      : 'the endpoint is reachable, but it rejected the MCP initialize probe before handshake completed';
  }
  return language === 'zh'
    ? '端点能通，但没走完合法的 MCP Streamable HTTP initialize/listTools 流程。'
    : 'the endpoint is reachable, but it is not completing a valid MCP Streamable HTTP initialize/listTools flow';
}

function buildStreamableHttpRepairHint(
  serverId: string,
  postProbe: HttpProbeResult,
  healthProbe: HttpProbeResult,
  language: 'en' | 'zh',
): string {
  if (postProbe.kind === 'network_error') {
    return language === 'zh'
      ? `先把这个 URL 背后的服务拉起来或修好，确认端口已经在监听，再重新运行 mcp_restart({"serverId":"${serverId}"}).`
      : `start or repair the target service behind this URL, confirm the port is listening, then rerun mcp_restart({"serverId":"${serverId}"}).`;
  }
  if (postProbe.status === 404) {
    return language === 'zh'
      ? `先核对 .minds/mcp.yaml 里的 servers.${serverId}.url 是否写对，再确认目标应用真的暴露了这个 MCP 路径。`
      : `verify servers.${serverId}.url in .minds/mcp.yaml points to the real MCP route, and make the target app expose that exact path.`;
  }
  if (postProbe.status === 401 || postProbe.status === 403) {
    return language === 'zh'
      ? `先核对 servers.${serverId}.headers 和相关认证环境变量，再重新运行 mcp_restart({"serverId":"${serverId}"}).`
      : `verify servers.${serverId}.headers and any referenced auth env vars, then rerun mcp_restart({"serverId":"${serverId}"}).`;
  }
  if (postProbe.status >= 500) {
    if (healthProbe.kind === 'response' && healthProbe.status >= 200 && healthProbe.status < 300) {
      return language === 'zh'
        ? `先看目标应用在失败 POST ${postProbe.url} 附近的日志和 stderr；把 MCP 服务修到能正常返回 initialize/listTools 的 JSON-RPC 或 SSE，而不是 HTTP ${postProbe.status}，再重新运行 mcp_restart({"serverId":"${serverId}"}).`
        : `inspect the target app logs/stderr around the failing POST ${postProbe.url}; fix the MCP server so initialize/listTools returns JSON-RPC or SSE instead of HTTP ${postProbe.status}, then rerun mcp_restart({"serverId":"${serverId}"}).`;
    }
    return language === 'zh'
      ? `把目标 MCP 服务的实现或运行时修好，让 POST ${postProbe.url} 能返回合法 MCP 响应，再重新运行 mcp_restart({"serverId":"${serverId}"}).`
      : `repair the target MCP service implementation/runtime so POST ${postProbe.url} returns a valid MCP response, then rerun mcp_restart({"serverId":"${serverId}"}).`;
  }
  return language === 'zh'
    ? `把目标端点修到能返回合法的 MCP initialize 响应和 listTools 响应，再重新运行 mcp_restart({"serverId":"${serverId}"}).`
    : `make the target endpoint return a valid MCP initialize response and a valid listTools response, then rerun mcp_restart({"serverId":"${serverId}"}).`;
}

function formatUnknownError(value: unknown): string {
  if (value instanceof Error) {
    const message = value.message.trim();
    if (message !== '') return message;
    return value.name.trim() !== '' ? value.name : 'Error';
  }
  return String(value);
}

function formatBodyPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '<empty>';
  const normalized = trimmed.replace(/\s+/g, ' ');
  if (normalized.length <= HTTP_BODY_PREVIEW_LIMIT) {
    return JSON.stringify(normalized);
  }
  return JSON.stringify(`${normalized.slice(0, HTTP_BODY_PREVIEW_LIMIT)}...[truncated]`);
}
