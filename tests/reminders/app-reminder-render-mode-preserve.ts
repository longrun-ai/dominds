import assert from 'node:assert/strict';

import type {
  DomindsAppHostToolResult,
  DomindsAppReminderApplyResult,
  DomindsAppRunControlResult,
} from '@longrun-ai/kernel/app-json';
import type { AppsHostClient, EnabledAppForHost } from '../../main/apps-host/client';
import { DialogStore, MainDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { materializeReminder } from '../../main/tool';
import {
  applyAppReminderRequests,
  buildAppReminderOwnerRegistryName,
  ensureAppReminderOwnersRegistered,
  unregisterAppReminderOwnersForApps,
} from '../../main/tools/app-reminders';
import { getReminderOwner } from '../../main/tools/registry';

function createDialog(agentId: string): MainDialog {
  return new MainDialog(
    new DialogStore(),
    'app-reminder-render-mode-preserve.tsk',
    undefined,
    agentId,
  );
}

function buildFakeApp(appId: string, ownerRef: string): EnabledAppForHost {
  return {
    appId,
    runtimePort: null,
    hostSourceVersion: null,
    installJson: {
      appId,
      package: {
        name: appId,
        version: '0.0.0-test',
        rootAbs: '/tmp',
      },
      host: {
        kind: 'node_module',
        moduleRelPath: 'index.js',
        exportName: 'default',
      },
      contributes: {
        reminderOwners: [{ ref: ownerRef }],
      },
    },
  };
}

async function main(): Promise<void> {
  const appId = '@tests/render-mode-preserve';
  const ownerRef = 'observer';
  const registryName = buildAppReminderOwnerRegistryName(appId, ownerRef);

  let applyCalls = 0;
  const fakeClient: AppsHostClient = {
    callTool: async (): Promise<DomindsAppHostToolResult> => {
      throw new Error('callTool should not be used in this test');
    },
    listDynamicToolsets: async (): Promise<readonly string[]> => [],
    applyRunControl: async (): Promise<DomindsAppRunControlResult> => {
      throw new Error('applyRunControl should not be used in this test');
    },
    applyReminder: async (): Promise<DomindsAppReminderApplyResult> => {
      applyCalls += 1;
      return {
        treatment: 'update',
        ownedIndex: 0,
        reminder: {
          content: 'updated by app',
          meta: { foo: 'baz' },
          echoback: true,
        },
      };
    },
    updateReminder: async () => {
      throw new Error('updateReminder should not be used in this test');
    },
    renderReminder: async (): Promise<ChatMessage> => {
      throw new Error('renderReminder should not be used in this test');
    },
    shutdown: async (): Promise<void> => {},
  };

  ensureAppReminderOwnersRegistered({
    enabledApps: [buildFakeApp(appId, ownerRef)],
    resolveHostClient: async () => fakeClient,
  });

  try {
    const owner = getReminderOwner(registryName);
    assert.ok(owner, 'Expected app reminder owner to be registered');

    const dlg = createDialog('tester');
    dlg.reminders.push(
      materializeReminder({
        content: 'existing plain reminder',
        owner,
        meta: {
          kind: 'app_reminder_owner',
          appId,
          ownerRef,
          manager: { tool: ownerRef },
          foo: 'bar',
        },
        renderMode: 'plain',
      }),
    );

    await applyAppReminderRequests(dlg, {
      appId,
      reminderRequests: [{ kind: 'upsert', ownerRef, content: 'ignored request payload' }],
      resolveHostClient: async () => fakeClient,
    });

    assert.equal(applyCalls, 1);
    assert.equal(dlg.reminders.length, 1);
    assert.equal(dlg.reminders[0]?.content, 'updated by app');
    assert.equal(dlg.reminders[0]?.renderMode, 'plain');
  } finally {
    unregisterAppReminderOwnersForApps({ appIds: [appId] });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
