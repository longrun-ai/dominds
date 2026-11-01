import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { loadAppsResolutionFile, writeAppsResolutionFile } from '../main/apps/resolution-file';
import { getAppsHostClient, shutdownAppsRuntime } from '../main/apps/runtime';
import { stopMcpSupervisor } from '../main/mcp/supervisor';
import { startServer } from '../main/server';
import { getDomindsSelfUpdateStatus } from '../main/server/dominds-self-update';
import { Team } from '../main/team';
import { writeAppManifest, writeAppText } from './helpers/app-fixture';
import {
  assertWebuiDelivered,
  createAppFactoryGate,
  runHostScenario,
  writeHostedApp,
} from './helpers/app-host-fixture';
import { withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

runHostScenario(async () => {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const id = '@tests/self-heal-package';
    const gate = await createAppFactoryGate();
    let started: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      const base = await writeHostedApp(
        rtws,
        id,
        gate.childSource +
          '\nreturn { tools: { probe_tool: async () => ({ output: { content: "self-heal-data", outcome: "success" } }) } };',
      );
      const supplied = {
        ...base,
        contributes: { ...base.contributes, teammatesYamlRelPath: '.minds/team.yaml' },
      };
      await writeAppText(
        path.join(base.package.rootAbs, 'app-json.json'),
        JSON.stringify(supplied),
      );
      const member = { name: 'Review Worker', toolsets: ['ws_read'] };
      await writeAppText(
        path.join(base.package.rootAbs, '.minds', 'team.yaml'),
        JSON.stringify({ members: { reviewer: member } }),
      );
      await writeAppText(
        path.join(rtws, '.minds', 'team.yaml'),
        JSON.stringify({
          member_defaults: { provider: 'local-mock', model: 'default' },
          default_responder: 'reviewer_from_package',
          members: { reviewer_from_package: { from: id, use: 'reviewer' } },
        }),
      );
      await writeAppManifest(rtws, 'rtws_root', [id]);
      const manifestBytes = await fs.readFile(path.join(rtws, '.minds', 'app.yaml'));
      await writeAppsResolutionFile({ rtwsRootAbs: rtws, file: { schemaVersion: 1, apps: [] } });
      const startup = startServer({
        port: 0,
        host: '127.0.0.1',
        mode: 'prod',
        startBackendDriver: false,
      }).then((server) => {
        started = server;
        return server;
      });
      const entered = await Promise.race([
        gate.entered,
        startup.then(() => {
          throw new Error('Server startup completed without entering the declared local factory');
        }),
      ]);
      assert.ok(typeof entered === 'object' && entered !== null && 'appId' in entered);
      assert.equal(entered.appId, id);
      gate.release();
      started = await startup;
      await assertWebuiDelivered('http://127.0.0.1:' + started.port);
      const result = await getAppsHostClient().callTool(
        'probe_tool',
        {},
        {
          dialogId: 'self-heal-dialog',
          mainDialogId: 'self-heal-root',
          agentId: 'reviewer_from_package',
          taskDocPath: 'task.md',
          callerId: 'tester',
        },
      );
      assert.deepEqual(result, { output: { content: 'self-heal-data', outcome: 'success' } });
      const loaded = await loadAppsResolutionFile({ rtwsRootAbs: rtws });
      assert.equal(loaded.kind, 'ok');
      assert.deepEqual(loaded.file.apps, [
        {
          id,
          enabled: true,
          source: { kind: 'local', pathAbs: base.package.rootAbs },
          assignedPort: null,
          installJson: supplied,
        },
      ]);
      const imported = (await Team.load()).getMember('reviewer_from_package');
      assert.ok(imported);
      assert.equal(imported.name, member.name);
      assert.deepEqual(imported.toolsets, member.toolsets);
      assert.deepEqual(await fs.readFile(path.join(rtws, '.minds', 'app.yaml')), manifestBytes);
      assert.equal(gate.packets.length, 1);
      console.log(
        JSON.stringify({
          scenario: 'empty-cache-startup-recovery',
          factoryEntries: gate.packets,
          resolution: loaded.file,
          probeResult: result,
          httpDelivered: true,
        }),
      );
    } finally {
      gate.release();
      await started?.httpServer.stop();
      if (started) assert.equal((await getDomindsSelfUpdateStatus()).mode, 'production');
      await shutdownAppsRuntime();
      stopMcpSupervisor();
      await gate.close();
    }
  });
});
