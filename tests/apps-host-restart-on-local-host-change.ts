import assert from 'node:assert/strict';

import {
  getAppsHostClient,
  initAppsRuntime,
  registerEnabledAppsToolProxies,
  shutdownAppsRuntime,
  waitForAppsHostClient,
} from '../main/apps/runtime';
import { writeAppManifest } from './helpers/app-fixture';
import { createAppFactoryGate, runHostScenario, writeHostedApp } from './helpers/app-host-fixture';
import { withTempRtws } from './kernel-driver/helpers';

const toolContext = {
  dialogId: 'dlg_1',
  mainDialogId: 'root_1',
  agentId: 'tester',
  taskDocPath: 'task.md',
  callerId: 'tester',
};
const factory = (version: string) =>
  'return { tools: { probe_tool: async () => ({ output: { content: ' +
  JSON.stringify(version) +
  ', outcome: "success" } }) } };';
runHostScenario(async () => {
  await withTempRtws(async (rtws) => {
    const id = 'probe_app';
    const gate = await createAppFactoryGate();
    try {
      await writeHostedApp(rtws, id, factory('v1'));
      await writeAppManifest(rtws, 'rtws_root', [id]);
      await initAppsRuntime({
        rtwsRootAbs: rtws,
        kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
      });
      const first = await getAppsHostClient().callTool('probe_tool', {}, toolContext);
      assert.deepEqual(first, { output: { content: 'v1', outcome: 'success' } });
      await writeHostedApp(rtws, id, gate.childSource + '\n' + factory('v2'));
      const refresh = registerEnabledAppsToolProxies({ rtwsRootAbs: rtws }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      assert.deepEqual(await gate.entered, {
        kind: 'factory_entered',
        appId: id,
        rtwsRootAbs: rtws,
        kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
      });
      assert.throws(() => getAppsHostClient(), Error);
      const duringRefresh = waitForAppsHostClient();
      gate.release();
      const nextClient = await duringRefresh;
      const during = await nextClient.callTool('probe_tool', {}, toolContext);
      assert.deepEqual(during, { output: { content: 'v2', outcome: 'success' } });
      const outcome = await refresh;
      if (!outcome.ok) throw outcome.error;
      const after = await getAppsHostClient().callTool('probe_tool', {}, toolContext);
      assert.deepEqual(after, { output: { content: 'v2', outcome: 'success' } });
      assert.equal(gate.packets.length, 1);
      console.log(
        JSON.stringify({
          scenario: 'local-host-source-refresh',
          first,
          during,
          after,
          factoryEntries: gate.packets,
        }),
      );
    } finally {
      gate.release();
      await shutdownAppsRuntime();
      await gate.close();
    }
  });
});
