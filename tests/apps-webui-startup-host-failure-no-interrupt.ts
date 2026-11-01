import assert from 'node:assert/strict';

import {
  getAppsHostClient,
  shutdownAppsRuntime,
  waitForAppsHostClient,
} from '../main/apps/runtime';
import { stopMcpSupervisor } from '../main/mcp/supervisor';
import { startServer } from '../main/server';
import { getDomindsSelfUpdateStatus } from '../main/server/dominds-self-update';
import { readAppResolution, writeAppManifest } from './helpers/app-fixture';
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
    for (const failure of [true, false]) {
      const id = failure ? 'controlled_broken_host' : 'controlled_pending_host';
      const gate = await createAppFactoryGate();
      let started: Awaited<ReturnType<typeof startServer>> | undefined;
      try {
        await writeHostedApp(
          rtws,
          id,
          gate.childSource +
            (failure
              ? '\nthrow new Error("controlled-factory-failure-data");'
              : '\nreturn { tools: { probe_tool: async () => ({ output: { content: "released-host-data", outcome: "success" } }) } };'),
        );
        await writeAppManifest(rtws, 'rtws_root', [id]);
        const startup = startServer({
          port: 0,
          host: '127.0.0.1',
          mode: 'prod',
          startBackendDriver: false,
          returnAfterListen: !failure,
        }).then((server) => {
          started = server;
          return server;
        });
        let entered: unknown;
        if (failure) {
          entered = await Promise.race([
            gate.entered,
            startup.then(() => {
              throw new Error('Startup never entered the declared failing factory');
            }),
          ]);
          const transition = waitForAppsHostClient().then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          gate.release();
          const result = await transition;
          assert.equal(result.ok, false);
          if (result.ok) throw new Error('The controlled failing factory became ready');
          assert.ok(result.error instanceof Error);
          started = await startup;
          assert.throws(() => getAppsHostClient(), Error);
          await assertWebuiDelivered('http://127.0.0.1:' + started.port);
        } else {
          started = await startup;
          entered = await gate.entered;
          const waiting = waitForAppsHostClient();
          assert.throws(() => getAppsHostClient(), Error);
          // A completed real HTTP response while the factory is held proves the availability boundary.
          await assertWebuiDelivered('http://127.0.0.1:' + started.port);
          assert.throws(() => getAppsHostClient(), Error);
          gate.release();
          const result = await (
            await waiting
          ).callTool(
            'probe_tool',
            {},
            {
              dialogId: 'pending-host-dialog',
              mainDialogId: 'pending-host-root',
              agentId: 'tester',
              taskDocPath: 'task.md',
              callerId: 'tester',
            },
          );
          assert.deepEqual(result, {
            output: { content: 'released-host-data', outcome: 'success' },
          });
        }
        assert.deepEqual(entered, {
          kind: 'factory_entered',
          appId: id,
          rtwsRootAbs: rtws,
          kernel: { scheme: 'http', host: '127.0.0.1', port: started.port },
        });
        const cache = await readAppResolution(rtws);
        assert.deepEqual(
          cache.apps.map((app) => ({ id: app.id, enabled: app.enabled })),
          [{ id, enabled: true }],
        );
        assert.equal(gate.packets.length, 1);
        console.log(
          JSON.stringify({
            scenario: failure ? 'webui-after-real-factory-failure' : 'webui-during-held-factory',
            factoryEntries: gate.packets,
            httpDelivered: true,
            cacheApps: cache.apps.map((app) => app.id),
          }),
        );
      } finally {
        gate.release();
        await started?.httpServer.stop();
        if (started) assert.equal((await getDomindsSelfUpdateStatus()).mode, 'production');
        try {
          await shutdownAppsRuntime();
        } finally {
          stopMcpSupervisor();
          await gate.close();
        }
      }
    }
  });
});
