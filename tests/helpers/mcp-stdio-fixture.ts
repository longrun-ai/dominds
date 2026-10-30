import fs from 'node:fs/promises';
import path from 'node:path';

/** Only the external MCP process is replaced; configuration, reload and Problems remain real. */
export async function writeMcpStdioFixture(): Promise<void> {
  await fs.mkdir('.minds', { recursive: true });
  await fs.writeFile(
    path.resolve('.minds/mock-mcp-server.cjs'),
    `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{ name: 'lookup_sdk_meta', description: 'Read SDK metadata', inputSchema: { type: 'object', properties: {} } }] });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, { content: [{ type: 'text', text: 'fixture-sdk-result' }] });
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported fixture method' } }) + '\\n');
  }
});
`,
  );
}
