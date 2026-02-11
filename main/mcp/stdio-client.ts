import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import { createLogger } from '../log';

const log = createLogger('mcp/stdio-client');

type JsonRpcId = number;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: unknown;
};

export type McpListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export class McpStdioClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private nextId: number = 1;
  private readonly pending: Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
      method: string;
    }
  > = new Map();
  private closed: boolean = false;

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
  }

  static async spawn(params: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
  }): Promise<McpStdioClient> {
    const proc = spawn(params.command, params.args, {
      stdio: 'pipe',
      env: params.env,
      cwd: params.cwd,
      windowsHide: true,
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    const client = new McpStdioClient(proc);
    client.attachIo();
    return client;
  }

  private attachIo(): void {
    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleLine(trimmed);
    });
    rl.on('close', () => {
      // stdout closed. Process exit handler will finish cleanup.
    });

    this.proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trimEnd();
      if (!text) return;
      log.debug(`[stderr] ${text}`);
    });

    this.proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const msg = `MCP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      if (!this.closed) {
        log.warn(msg);
      } else {
        log.debug(msg);
      }
      this.closed = true;
      for (const [id, p] of this.pending.entries()) {
        clearTimeout(p.timeout);
        p.reject(new Error(`MCP request ${id} (${p.method}) failed: process exited`));
      }
      this.pending.clear();
    });

    this.proc.on('error', (err: Error) => {
      log.warn('MCP process error', err);
    });
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      log.warn('Failed to parse MCP JSON-RPC line as JSON', undefined, { line, err });
      return;
    }
    if (!isRecord(parsed)) {
      log.warn('Ignoring MCP line: not an object', undefined, { line });
      return;
    }

    const jsonrpc = parsed.jsonrpc;
    if (jsonrpc !== '2.0') {
      log.warn('Ignoring MCP line: jsonrpc is not 2.0', undefined, { line });
      return;
    }

    if ('id' in parsed) {
      const id = parsed.id;
      if (typeof id !== 'number') {
        log.warn('Ignoring MCP response: id is not a number', undefined, { line });
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        log.warn('Ignoring MCP response: no pending request', undefined, { id });
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timeout);

      const errVal = 'error' in parsed ? (parsed as { error?: unknown }).error : undefined;
      const resultVal = 'result' in parsed ? (parsed as { result?: unknown }).result : undefined;
      if (errVal !== undefined) {
        pending.reject(new Error(formatJsonRpcError(errVal)));
        return;
      }
      pending.resolve(resultVal);
      return;
    }

    if ('method' in parsed && typeof parsed.method === 'string') {
      // Notification: ignored for now.
      return;
    }

    log.warn('Ignoring MCP line: not a response or notification', undefined, { line });
  }

  async initialize(timeoutMs: number = 15_000): Promise<void> {
    // Best-effort MCP initialize handshake.
    // If servers require a different protocolVersion, they will reject and we'll surface the error.
    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dominds', version: 'dev' },
      },
      timeoutMs,
    );
    await this.notify('notifications/initialized', undefined);
  }

  async listTools(timeoutMs: number = 15_000): Promise<McpListedTool[]> {
    const all: McpListedTool[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs);
      const parsed = parseToolsListResult(res);
      all.push(...parsed.tools);
      cursor = parsed.nextCursor;
      if (!cursor) break;
    }
    return all;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number = 60_000,
  ): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return stringifyToolCallResult(res);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.proc.kill();
    } catch (err) {
      log.debug('Failed to kill MCP process', err);
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.writeMessage(msg);
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) {
      throw new Error('MCP client is closed');
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout (${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject: (e: Error) => reject(e),
        timeout,
        method,
      });
      this.writeMessage(msg);
    });
  }

  private writeMessage(msg: JsonRpcRequest | JsonRpcNotification): void {
    const line = JSON.stringify(msg);
    try {
      this.proc.stdin.write(`${line}\n`, 'utf8');
    } catch (err) {
      log.warn('Failed to write MCP message to stdin', err);
    }
  }
}

function parseToolsListResult(value: unknown): { tools: McpListedTool[]; nextCursor?: string } {
  const obj = asRecord(value, 'tools/list result');
  const toolsVal = obj.tools;
  if (!Array.isArray(toolsVal)) {
    throw new Error(`Invalid MCP tools/list result: expected tools[]`);
  }
  const tools: McpListedTool[] = [];
  for (const t of toolsVal) {
    const toolObj = asRecord(t, 'tools/list tool');
    const name = toolObj.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`Invalid MCP tool entry: missing name`);
    }
    const description =
      typeof toolObj.description === 'string' ? (toolObj.description as string) : undefined;
    const inputSchemaVal = toolObj.inputSchema;
    if (!isRecord(inputSchemaVal) || Array.isArray(inputSchemaVal)) {
      throw new Error(`Invalid MCP tool entry '${name}': inputSchema must be an object`);
    }
    tools.push({ name, description, inputSchema: inputSchemaVal });
  }

  const nextCursor =
    typeof obj.nextCursor === 'string' && obj.nextCursor.trim()
      ? (obj.nextCursor as string)
      : undefined;

  return { tools, nextCursor };
}

function stringifyToolCallResult(value: unknown): string {
  if (!isRecord(value) || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const contentVal = 'content' in value ? (value as { content?: unknown }).content : undefined;
  if (!Array.isArray(contentVal)) {
    return JSON.stringify(value);
  }
  const parts: string[] = [];
  for (const item of contentVal) {
    if (isRecord(item) && !Array.isArray(item)) {
      const t = item.type;
      if (t === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }
    }
    parts.push(JSON.stringify(item));
  }
  return parts.join('\n').trim();
}

function formatJsonRpcError(errVal: unknown): string {
  if (!isRecord(errVal) || Array.isArray(errVal)) {
    return `MCP error: ${JSON.stringify(errVal)}`;
  }
  const code = 'code' in errVal ? errVal.code : undefined;
  const message = 'message' in errVal ? errVal.message : undefined;
  const data = 'data' in errVal ? errVal.data : undefined;
  const codeStr = typeof code === 'number' ? `code=${code}` : undefined;
  const msgStr = typeof message === 'string' ? message : JSON.stringify(errVal);
  const dataStr = data !== undefined ? ` data=${JSON.stringify(data)}` : '';
  return `MCP error${codeStr ? ` (${codeStr})` : ''}: ${msgStr}${dataStr}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Invalid MCP payload: expected object at ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
