import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import yaml from 'yaml';
import { parseMcpYaml } from '../main/mcp/config';
import { requestMcpConfigReload, stopMcpSupervisor } from '../main/mcp/supervisor';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { renderToolsetManual } from '../main/tools/manual/render';
import { mcpDisableTool, mcpRestartTool } from '../main/tools/mcp';
import { getToolset, getToolsetMeta } from '../main/tools/registry';
import { readMcpToolsetMappingSnapshot } from '../main/tools/team_mgmt-mcp-manual';
import { startMcpHttpFixture } from './helpers/mcp-http-fixture';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-mcp-disable-');
const manualData = {
  content: 'Manual content from mcp.yaml.',
  sections: [
    { title: 'Unavailable handling', content: 'Ask the MCP administrator to enable this server.' },
  ],
};
const file = '.minds/mcp.yaml';
function record(
  id: string,
  scenario: string,
  actualText: string,
  context: Record<string, string | number | boolean>,
) {
  evidence.record({
    id,
    scenario,
    businessValue:
      'An executing agent sees whether an MCP capability is available and can recover it without losing its configured manual.',
    context,
    reviewQuestions: [
      'Is the complete output consistent with the supplied configuration and observed capability state?',
      'Does the output preserve the supplied manual and give usable recovery guidance without claiming unavailable tools are executable?',
    ],
    actualText,
  });
}
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const dialog = await createMainDialog();
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    const peer = await startMcpHttpFixture();
    function config(enabled?: boolean | string) {
      return yaml.stringify({
        version: 1,
        servers: {
          local_http: {
            transport: 'streamable_http',
            ...(enabled === undefined ? {} : { enabled }),
            url: peer.endpointUrl,
            manual: manualData,
          },
        },
      });
    }
    try {
      for (const language of ['en', 'zh'] as const) {
        setWorkLanguage(language);
        dialog.setLastUserLanguageCode(language);
        await fs.writeFile(file, config());
        const loaded = await mcpRestartTool.call(dialog, caller, { serverId: 'local_http' });
        assert.equal(loaded.outcome, 'success');
        assert.equal(getToolset('local_http')?.length, 1);
        const requestCount = peer.requests.length;
        const disabled = await mcpDisableTool.call(dialog, caller, { serverId: 'local_http' });
        assert.equal(disabled.outcome, 'success');
        assert.equal(peer.requests.length, requestCount);
        const raw = await fs.readFile(file, 'utf8');
        const persistedData: unknown = yaml.parse(raw);
        const expectedDisabledData: unknown = yaml.parse(config(false));
        assert.deepEqual(
          persistedData,
          expectedDisabledData,
          'disable changes only enabled in the supplied configuration data',
        );
        const parsed = parseMcpYaml(raw);
        assert.ok(parsed.ok);
        assert.deepEqual(Object.keys(parsed.config.servers), []);
        assert.deepEqual(parsed.serverIdsInYamlOrder, ['local_http']);
        assert.deepEqual(parsed.validServerIdsInYamlOrder, []);
        assert.deepEqual(parsed.disabledServerIdsInYamlOrder, ['local_http']);
        assert.deepEqual(getToolset('local_http'), []);
        const snapshot = await readMcpToolsetMappingSnapshot();
        assert.ok(snapshot.kind === 'loaded');
        assert.deepEqual(
          snapshot.entries.map((e) => ({
            id: e.serverId,
            status: e.status,
            count: e.loadedToolCount,
          })),
          [{ id: 'local_http', status: 'disabled', count: 0 }],
        );
        assert.deepEqual(snapshot.entries[0]?.manualState, {
          kind: 'present',
          manual: { ...manualData, contentFile: undefined },
        });
        const manual = renderToolsetManual({ toolsetId: 'local_http', language, request: {} });
        assert.equal(manual.foundToolset, true);
        for (const original of [manualData.content, manualData.sections[0]!.content])
          assert.ok(
            manual.content.includes(original),
            'the exact supplied manual data survives disabling',
          );
        const context = {
          language,
          yaml: raw,
          mapping: JSON.stringify(snapshot),
          requests: JSON.stringify(peer.requests),
        };
        record(
          'disable-receipt-' + language,
          'A loaded local MCP tool is disabled and persisted as disabled.',
          disabled.content,
          context,
        );
        record(
          'disabled-description-' + language,
          'The registry retains an empty disabled placeholder after removing the loaded tool.',
          getToolsetMeta('local_http')?.descriptionI18n?.[language] ?? '',
          context,
        );
        record(
          'disabled-manual-' + language,
          'The configured manual remains accessible on a disabled toolset.',
          manual.content,
          context,
        );
        const again = await mcpDisableTool.call(dialog, caller, { serverId: 'local_http' });
        assert.equal(again.outcome, 'success');
        assert.equal(
          await fs.readFile(file, 'utf8'),
          raw,
          'idempotent disable must not churn the file bytes',
        );
        await fs.writeFile(file, config(true));
        assert.equal(
          (await mcpDisableTool.call(dialog, caller, { serverId: 'local_http' })).outcome,
          'success',
        );
        const existingField = parseMcpYaml(await fs.readFile(file, 'utf8'));
        assert.ok(existingField.ok);
        assert.deepEqual(existingField.disabledServerIdsInYamlOrder, ['local_http']);
      }
      await fs.writeFile(file, config('nope'));
      assert.equal((await requestMcpConfigReload('test-invalid-after-disabled')).ok, true);
      assert.equal(getToolset('local_http'), undefined);
      const invalid = await readMcpToolsetMappingSnapshot();
      assert.ok(invalid.kind === 'loaded');
      assert.deepEqual(
        invalid.entries.map((e) => e.status),
        ['declared_invalid'],
      );
      await fs.writeFile(file, config(false));
      peer.setBroken(true);
      const restart = await mcpRestartTool.call(dialog, caller, { serverId: 'local_http' });
      assert.equal(restart.outcome, 'failure');
      const raw = await fs.readFile(file, 'utf8');
      const reenabledData: unknown = yaml.parse(raw);
      const expectedEnabledData: unknown = yaml.parse(config(true));
      assert.deepEqual(reenabledData, expectedEnabledData);
      const reenabled = parseMcpYaml(raw);
      assert.ok(reenabled.ok);
      assert.deepEqual(reenabled.validServerIdsInYamlOrder, ['local_http']);
      assert.deepEqual(reenabled.disabledServerIdsInYamlOrder, []);
      assert.equal(getToolset('local_http'), undefined);
      assert.ok(peer.requests.some((r) => r.url === '/mcp' && r.status === 500));
      record(
        'failed-restart-persisted-enable',
        'Restart enables the disabled server on disk, but its owned HTTP handler fails before a tool can be registered.',
        restart.content,
        { yaml: raw, requests: JSON.stringify(peer.requests) },
      );
    } finally {
      const finalConfig = await fs.readFile(file, 'utf8');
      try {
        await fs.writeFile(file, 'version: 1\nservers: {}\n');
        await requestMcpConfigReload('test-cleanup');
        stopMcpSupervisor();
      } finally {
        await fs.writeFile(file, finalConfig);
        await peer.close();
      }
    }
  });
  await evidence.write();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
