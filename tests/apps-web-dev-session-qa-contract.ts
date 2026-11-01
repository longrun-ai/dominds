import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  rejectWebDevAction,
  runExternalWebDevScenario,
  webDevComponentIdentity,
} from './helpers/external-web-dev';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

import {
  assertRecord,
  assertSuccessfulResult,
  createWebDevFixture,
  requireReminderStateAdded,
  requireSingleUpsertReminder,
  sessionIdFromReminder,
} from './helpers/web-dev-session-fixture';

const evidence = semanticEvidenceCollector('dominds-external-apps-web-dev-session-qa-contract-');
const observations: Array<{ stage: string; text: string; outcome?: string }> = [];
function observe(stage: string, text: string, outcome?: string): void {
  observations.push({ stage, text, ...(outcome ? { outcome } : {}) });
}

async function main(): Promise<void> {
  const fixture = await createWebDevFixture();
  let completed = false;
  try {
    const created = await fixture.host.tools.playwright_session_new(
      {
        kind: 'web',
        label: 'qa-contract',
        entryUrl: 'https://example.test/initial',
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(created);
    const controllerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(created), {
        dialogId: fixture.controllerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    const sessionId = sessionIdFromReminder(controllerReminder);
    const sessionFile = path.join(fixture.sessionsCacheDirAbs, sessionId + '.json');

    const inventoryStatus = await fixture.host.tools.playwright_session_inventory_status(
      { sessionId },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(inventoryStatus);
    observe('inventoryStatus', inventoryStatus.output.content, inventoryStatus.output.outcome);
    const initialSession: unknown = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assertRecord(initialSession);
    assertRecord(initialSession['qa']);
    assert.deepEqual(initialSession['qa']['inventory'], []);
    assertRecord(initialSession['qa']['signoff']);
    assert.equal(initialSession['qa']['signoff']['status'], 'not_started');

    const screenshot = await fixture.host.tools.playwright_session_screenshot(
      { sessionId, label: 'qa-proof', imageType: 'png' },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(screenshot);

    const pendingItem = {
      id: 'critical_flow',
      kind: 'feature',
      label: 'Primary browser flow',
      functional: 'covered',
      visual: 'pending',
      artifact: 'qa-proof.png',
      notes: 'Functional pass on desktop runtime.',
    };
    const createdInventory = await fixture.host.tools.playwright_session_inventory_upsert(
      {
        sessionId,
        item: pendingItem,
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(createdInventory);
    observe('createdInventory', createdInventory.output.content, createdInventory.output.outcome);

    const beforeRefusedReady: unknown = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assertRecord(beforeRefusedReady);
    assertRecord(beforeRefusedReady['qa']);
    const pendingInventory = beforeRefusedReady['qa']['inventory'];
    assert.ok(Array.isArray(pendingInventory));
    assert.equal(pendingInventory.length, 1);
    const storedPendingItem: unknown = pendingInventory[0];
    assertRecord(storedPendingItem);
    for (const [key, value] of Object.entries(pendingItem))
      assert.deepEqual(storedPendingItem[key], value);
    const refusedReady = await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_signoff_record(
          {
            sessionId,
            status: 'ready',
            functional: true,
            visual: true,
            viewport: true,
            exploratory: true,
            cleanupStatus: 'kept_alive',
            summary: 'Attempted signoff before visual coverage was complete.',
          },
          fixture.controllerCtx,
        ),
    );

    observe('refusedReady', refusedReady.message);
    const afterRefusedReady: unknown = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assertRecord(afterRefusedReady);
    assert.deepEqual(afterRefusedReady['qa'], beforeRefusedReady['qa']);

    const inProgress = await fixture.host.tools.playwright_session_signoff_record(
      {
        sessionId,
        status: 'in_progress',
        summary: 'Functional pass completed; visual QA still pending.',
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(inProgress);
    observe('inProgress', inProgress.output.content, inProgress.output.outcome);
    const progressSession: unknown = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assertRecord(progressSession);
    assertRecord(progressSession['qa']);
    assertRecord(progressSession['qa']['signoff']);
    assert.equal(progressSession['qa']['signoff']['status'], 'in_progress');

    const coveredItem = {
      id: 'critical_flow',
      kind: 'feature',
      label: 'Primary browser flow',
      functional: 'covered',
      visual: 'covered',
      artifact: 'qa-proof.png',
      notes: 'Visual pass completed.',
    };
    const updatedInventory = await fixture.host.tools.playwright_session_inventory_upsert(
      {
        sessionId,
        item: coveredItem,
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(updatedInventory);
    observe('updatedInventory', updatedInventory.output.content, updatedInventory.output.outcome);

    const readyRecord = {
      sessionId,
      status: 'ready',
      functional: true,
      visual: true,
      viewport: true,
      exploratory: true,
      cleanupStatus: 'kept_alive',
      summary: 'Primary browser flow verified.',
      negativeChecks: ['No unexpected console errors during smoke.'],
      exclusions: ['Mobile-specific QA remains out of scope.'],
    };
    const signoffReady = await fixture.host.tools.playwright_session_signoff_record(
      readyRecord,
      fixture.controllerCtx,
    );
    assertSuccessfulResult(signoffReady);
    observe('signoffReady', signoffReady.output.content, signoffReady.output.outcome);

    const signoffStatus = await fixture.host.tools.playwright_session_signoff_status(
      { sessionId },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(signoffStatus);
    observe('signoffStatus', signoffStatus.output.content, signoffStatus.output.outcome);

    const persistedSession = JSON.parse(
      await fs.readFile(path.join(fixture.sessionsCacheDirAbs, `${sessionId}.json`), 'utf-8'),
    ) as unknown;
    assertRecord(persistedSession);
    assertRecord(persistedSession['qa']);
    const qa = persistedSession['qa'];
    assertRecord(qa);
    assert.ok(Array.isArray(qa['inventory']));
    assertRecord(qa['signoff']);
    const inventoryItem = qa['inventory'][0] as unknown;
    assertRecord(inventoryItem);
    const signoff = qa['signoff'];
    assertRecord(signoff);
    assert.equal(qa['inventory'].length, 1);
    // These are supplied record fields and opaque text payloads, not generated meanings.
    for (const [key, value] of Object.entries(coveredItem))
      assert.deepEqual(inventoryItem[key], value);
    for (const [key, value] of Object.entries(readyRecord)) {
      if (key !== 'sessionId') assert.deepEqual(signoff[key], value);
    }
    completed = true;
  } finally {
    await fixture.cleanup({ preserve: !completed });
  }
}

runExternalWebDevScenario(async () => {
  await main();
  const identity = webDevComponentIdentity();
  evidence.record({
    id: 'qa-record-guidance',
    scenario:
      'A session records one QA inventory item, refuses ready signoff while visual coverage is pending, updates the record and retrieves final signoff.',
    businessValue:
      'Accurately manage supplied QA records and their decision gate without mistaking recorded claims or controlled screenshot bytes for real visual/functional QA.',
    context: {
      ...{
        inventoryId: 'critical_flow',
        visualInitially: 'pending',
        visualFinally: 'covered',
        actualBrowserExecuted: false,
        boundary:
          'Real selected component; controlled Playwright/Electron provider, no real browser/visual QA acceptance.',
      },
      componentRoot: identity.root,
      componentPackageJsonSha256: identity.packageJsonSha256,
    },
    reviewQuestions: [
      'Does actual coverage/gate guidance agree with the stored pending versus covered inventory and refused premature ready transition?',
      'Do successful recording/query receipts preserve the supplied summaries, negative checks and exclusions without implying real browser or visual QA happened?',
    ],
    actualText: JSON.stringify(observations, null, 2),
  });
  await evidence.write();
  console.log(
    'Selected external Web Dev machine workflow completed; semantic acceptance is separate.',
  );
});
