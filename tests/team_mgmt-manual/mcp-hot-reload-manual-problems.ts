import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  getMcpDeclaredServerRuntimeStatuses,
  requestMcpConfigReload,
} from '../../main/mcp/supervisor';
import { clearProblems, listProblems } from '../../main/problems';
import { getToolset } from '../../main/tools/registry';
import { writeMcpStdioFixture } from '../helpers/mcp-stdio-fixture';

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  clearProblems({ source: 'mcp' });
  await writeMcpStdioFixture();
  const problemId = 'mcp/server/sdk_stdio/toolset_manual_unknown_fields';
  const config = `version: 1\nservers:\n  sdk_stdio:\n    transport: stdio\n    command: ${JSON.stringify(process.execPath)}\n    args: ['.minds/mock-mcp-server.cjs']\n    cwd: '.'\n    manual:\n      content: SDK metadata lookup\n`;
  try {
    await fs.writeFile('.minds/mcp.yaml', config + '      extraHint: ignored\n');
    assert.deepEqual(await requestMcpConfigReload('manual-warning'), { ok: true });
    const warning = listProblems({ source: 'mcp', resolved: false, problemId });
    assert.equal(warning.length, 1);
    assert.equal(warning[0].severity, 'warning');
    assert.equal(getMcpDeclaredServerRuntimeStatuses()[0]?.status, 'loaded');
    assert.equal(
      getToolset('sdk_stdio')?.length,
      1,
      'warning-only manual must not prevent capability registration',
    );

    await fs.writeFile('.minds/mcp.yaml', 'version: [');
    assert.deepEqual(await requestMcpConfigReload('invalid-yaml'), { ok: true });
    assert.equal(listProblems({ source: 'mcp', resolved: false, problemId }).length, 0);
    assert.equal(listProblems({ source: 'mcp', resolved: true, problemId }).length, 1);
    assert.ok(
      listProblems({ source: 'mcp', resolved: false }).some(
        (problem) => problem.kind === 'mcp_workspace_config_error',
      ),
    );

    await fs.writeFile('.minds/mcp.yaml', config);
    assert.deepEqual(await requestMcpConfigReload('manual-fixed'), { ok: true });
    assert.equal(listProblems({ source: 'mcp', resolved: false }).length, 0);
    assert.equal(listProblems({ source: 'mcp', resolved: true, problemId }).length, 1);
    assert.equal(getMcpDeclaredServerRuntimeStatuses()[0]?.status, 'loaded');
    assert.equal(getToolset('sdk_stdio')?.length, 1);
  } finally {
    await fs.writeFile('.minds/mcp.yaml', 'version: 1\nservers: {}\n');
    await requestMcpConfigReload('test-cleanup');
  }
  assert.deepEqual(getMcpDeclaredServerRuntimeStatuses(), []);
  assert.equal(
    getToolset('sdk_stdio'),
    undefined,
    'removing the server revokes its registered toolset',
  );
  console.log('MCP hot reload problem lifecycle tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
