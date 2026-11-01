import assert from 'node:assert/strict';
import { McpSdkClient } from '../main/mcp/sdk-client';
import { startMcpHttpFixture } from './helpers/mcp-http-fixture';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-mcp-http-diagnostics-');
async function main() {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1');
  const fixture = await startMcpHttpFixture();
  try {
    const client = await McpSdkClient.connectStreamableHttp({
      serverId: 'broken-http',
      url: fixture.endpointUrl,
      headers: {},
    });
    try {
      assert.deepEqual(await client.listTools(), [fixture.listedTool]);
    } finally {
      await client.close();
    }
    fixture.setBroken(true);
    const start = fixture.requests.length;
    let failure: unknown;
    let unexpectedClient: McpSdkClient | undefined;
    try {
      unexpectedClient = await McpSdkClient.connectStreamableHttp({
        serverId: 'broken-http',
        url: fixture.endpointUrl,
        headers: {},
      });
    } catch (error) {
      failure = error;
    } finally {
      await unexpectedClient?.close();
    }
    assert.equal(unexpectedClient, undefined);
    assert.ok(failure instanceof Error);
    const observations = fixture.requests.slice(start);
    assert.ok(
      observations.some(
        (r) => r.method === 'POST' && r.url === '/mcp' && r.status === 500 && r.responseBody === '',
      ),
    );
    assert.ok(
      observations.some((r) => r.method === 'GET' && r.url === '/health' && r.status === 200),
    );
    evidence.record({
      id: 'failed-handler-healthy-process',
      scenario:
        'The same owned endpoint first completes a real SDK handshake and lists a supplied tool; its MCP handler is then changed to return HTTP500 with an empty body while health remains HTTP200.',
      businessValue:
        'An operator needs an evidence-based diagnosis and a practical recovery step without an invented credential or process outage.',
      context: {
        endpoint: fixture.endpointUrl,
        requests: JSON.stringify(observations),
        scope:
          'Real SDK handshake and HTTP diagnostics; no external MCP service and no tool execution.',
      },
      reviewQuestions: [
        'Does the full diagnostic accurately convey the observed boundary and distinguish a reachable process from a failing handler?',
        'Is the likely cause qualified, and is its recovery advice usable for the identified server?',
      ],
      actualText: failure.message,
    });
  } finally {
    await fixture.close();
  }
  await evidence.write();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
