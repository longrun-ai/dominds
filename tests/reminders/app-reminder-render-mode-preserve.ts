import assert from 'node:assert/strict';

import type { DomindsAppReminderRenderedMessage } from '@longrun-ai/kernel/app-host-contract';
import type {
  DomindsAppHostToolResult,
  DomindsAppReminderApplyResult,
  DomindsAppRunControlResult,
} from '@longrun-ai/kernel/app-json';
import type { AppsHostClient, EnabledAppForHost } from '../../main/apps-host/client';
import { DialogStore, MainDialog } from '../../main/dialog';
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
  let renderCalls = 0;
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
    renderReminder: async (): Promise<DomindsAppReminderRenderedMessage> => {
      renderCalls += 1;
      return { content: 'app rendered reminder content' };
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
        scope: 'dialog',
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

    const reminder = dlg.reminders[0];
    assert.ok(reminder, 'Expected updated reminder to remain present');
    const rendered = await owner.renderReminder(dlg, reminder);
    assert.equal(renderCalls, 1);
    assert.equal(rendered.type, 'environment_msg');
    assert.match(rendered.content, new RegExp(`\\[${reminder.id}\\]`));
    assert.match(
      rendered.content,
      /This state is system-maintained; do not copy, rewrite, or separately maintain it in manual reminders/,
    );
    assert.match(rendered.content, /app rendered reminder content/);
  } finally {
    unregisterAppReminderOwnersForApps({ appIds: [appId] });
  }

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
