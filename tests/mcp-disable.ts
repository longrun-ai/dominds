import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Dialog } from '../main/dialog';
import { parseMcpYaml } from '../main/mcp/config';
import { requestMcpConfigReload } from '../main/mcp/supervisor';
import { Team } from '../main/team';
import { renderToolsetManual } from '../main/tools/manual/render';
import { mcpDisableTool, mcpRestartTool } from '../main/tools/mcp';
import { getToolset, getToolsetMeta } from '../main/tools/registry';
import { readMcpToolsetMappingSnapshot } from '../main/tools/team_mgmt-mcp-manual';

async function runExistingEnabledPositionCase(tmpDir: string): Promise<void> {
  const mcpYamlPath = path.join(tmpDir, '.minds', 'mcp.yaml');
  await fs.writeFile(
    mcpYamlPath,
    [
      'version: 1',
      'servers:',
      '  local_http:',
      '    transport: streamable_http',
      '    enabled: true',
      '    url: http://127.0.0.1:9/mcp',
      '',
    ].join('\n'),
    'utf8',
  );

  const caller = new Team.Member({ id: 'tester', name: 'Tester' });
  const result = await mcpDisableTool.call({} as Dialog, caller, { serverId: 'local_http' });
  assert.equal(result.content, 'ok: disabled local_http and set enabled=false');

  const raw = await fs.readFile(mcpYamlPath, 'utf8');
  assert.match(raw, /local_http:\n    transport: streamable_http\n    enabled: false\n    url:/);
}

async function runAlreadyDisabledNoRewriteCase(tmpDir: string): Promise<void> {
  const mcpYamlPath = path.join(tmpDir, '.minds', 'mcp.yaml');
  const originalRaw = [
    'version: 1',
    'servers:',
    '  local_http:',
    '    transport: streamable_http',
    '    enabled: false',
    '    url: http://127.0.0.1:9/mcp',
    '',
  ].join('\n');
  await fs.writeFile(mcpYamlPath, originalRaw, 'utf8');

  const caller = new Team.Member({ id: 'tester', name: 'Tester' });
  const result = await mcpDisableTool.call({} as Dialog, caller, { serverId: 'local_http' });
  assert.equal(result.content, 'ok: disabled local_http and set enabled=false');

  const raw = await fs.readFile(mcpYamlPath, 'utf8');
  assert.equal(raw, originalRaw);
}

async function main(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-mcp-disable-'));
  const oldCwd = process.cwd();

  try {
    await fs.mkdir(path.join(tmpDir, '.minds'), { recursive: true });
    const mcpYamlPath = path.join(tmpDir, '.minds', 'mcp.yaml');
    await fs.writeFile(
      mcpYamlPath,
      [
        'version: 1',
        'servers:',
        '  local_http:',
        '    transport: streamable_http',
        '    url: http://127.0.0.1:9/mcp',
        '    manual:',
        '      content: "Manual content from mcp.yaml."',
        '      sections:',
        '        - title: "Unavailable handling"',
        '          content: "Ask the MCP administrator to enable this server."',
        '',
      ].join('\n'),
      'utf8',
    );

    process.chdir(tmpDir);

    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    const result = await mcpDisableTool.call({} as Dialog, caller, { serverId: 'local_http' });
    assert.equal(result.content, 'ok: disabled local_http and set enabled=false');

    const raw = await fs.readFile(mcpYamlPath, 'utf8');
    assert.match(raw, /local_http:/);
    assert.match(raw, /enabled: false/);
    assert.match(raw, /local_http:\n    enabled: false\n    transport:/);

    const parsed = parseMcpYaml(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(Object.keys(parsed.config.servers), []);
    assert.deepEqual(parsed.serverIdsInYamlOrder, ['local_http']);
    assert.deepEqual(parsed.validServerIdsInYamlOrder, []);
    assert.deepEqual(parsed.disabledServerIdsInYamlOrder, ['local_http']);

    assert.deepEqual(getToolset('local_http'), []);
    assert.match(getToolsetMeta('local_http')?.descriptionI18n?.en ?? '', /disabled/);
    const snapshot = await readMcpToolsetMappingSnapshot();
    assert.equal(snapshot.kind, 'loaded');
    if (snapshot.kind !== 'loaded') return;
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.status),
      ['disabled'],
    );
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.loadedToolCount),
      [0],
    );
    const manual = renderToolsetManual({
      toolsetId: 'local_http',
      language: 'en',
      request: {},
    });
    assert.equal(manual.foundToolset, true);
    assert.match(manual.content, /enabled: false/);
    assert.match(manual.content, /Manual content from mcp\.yaml/);
    assert.match(manual.content, /Ask the MCP administrator/);
    assert.doesNotMatch(manual.content, /Missing manual sections/);

    await fs.writeFile(
      mcpYamlPath,
      [
        'version: 1',
        'servers:',
        '  local_http:',
        '    enabled: nope',
        '    transport: streamable_http',
        '    url: http://127.0.0.1:9/mcp',
        '',
      ].join('\n'),
      'utf8',
    );
    const invalidReload = await requestMcpConfigReload('test_mcp_disable_invalid_after_disabled');
    assert.equal(invalidReload.ok, true);
    assert.equal(getToolset('local_http'), undefined);
    const invalidSnapshot = await readMcpToolsetMappingSnapshot();
    assert.equal(invalidSnapshot.kind, 'loaded');
    if (invalidSnapshot.kind !== 'loaded') return;
    assert.deepEqual(
      invalidSnapshot.entries.map((entry) => entry.status),
      ['declared_invalid'],
    );

    await fs.writeFile(
      mcpYamlPath,
      [
        'version: 1',
        'servers:',
        '  local_http:',
        '    enabled: false',
        '    transport: streamable_http',
        '    url: http://127.0.0.1:9/mcp',
        '',
      ].join('\n'),
      'utf8',
    );
    const restartResult = await mcpRestartTool.call({} as Dialog, caller, {
      serverId: 'local_http',
    });
    assert.equal(restartResult.outcome, 'failure');

    const enabledRaw = await fs.readFile(mcpYamlPath, 'utf8');
    assert.match(enabledRaw, /local_http:/);
    assert.match(enabledRaw, /enabled: true/);
    assert.match(enabledRaw, /local_http:\n    enabled: true\n    transport:/);
    assert.equal(getToolset('local_http'), undefined);

    await runExistingEnabledPositionCase(tmpDir);
    await runAlreadyDisabledNoRewriteCase(tmpDir);
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  console.log('mcp disable test: ok');
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
