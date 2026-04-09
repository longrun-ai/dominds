import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertRecord,
  assertStructuredResult,
  createWebDevFixture,
  requireReminderStateAdded,
  requireSingleUpsertReminder,
  sessionIdFromReminder,
} from './helpers/web-dev-session-fixture';

async function main(): Promise<void> {
  const fixture = await createWebDevFixture();
  try {
    const created = await fixture.host.tools.playwright_session_new(
      {
        kind: 'web',
        label: 'qa-contract',
        entryUrl: 'https://example.test/initial',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(created);
    const controllerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(created), {
        dialogId: fixture.controllerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    const sessionId = sessionIdFromReminder(controllerReminder);

    const inventoryStatus = await fixture.host.tools.playwright_session_inventory_status(
      { sessionId },
      fixture.controllerCtx,
    );
    assertStructuredResult(inventoryStatus);
    assert.match(
      inventoryStatus.output.content,
      /coverage snapshot: inventory=0 functional=0\/0 visual=0\/0 pendingFunctional=none pendingVisual=none/,
    );
    assert.match(
      inventoryStatus.output.content,
      /decision gate: status=not_started functional=pending visual=pending viewport=pending exploratory=pending cleanup=not_run/,
    );

    const screenshot = await fixture.host.tools.playwright_session_screenshot(
      { sessionId, label: 'qa-proof', imageType: 'png' },
      fixture.controllerCtx,
    );
    assertStructuredResult(screenshot);

    const createdInventory = await fixture.host.tools.playwright_session_inventory_upsert(
      {
        sessionId,
        item: {
          id: 'critical_flow',
          kind: 'feature',
          label: 'Primary browser flow',
          functional: 'covered',
          visual: 'pending',
          artifact: 'qa-proof.png',
          notes: 'Functional pass on desktop runtime.',
        },
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(createdInventory);
    assert.match(createdInventory.output.content, /ok: session QA inventory item created\./);
    assert.match(
      createdInventory.output.content,
      /coverage snapshot: inventory=1 functional=1\/1 visual=0\/1 pendingFunctional=none pendingVisual=critical_flow/,
    );

    await assert.rejects(
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
      /ready signoff requires visual coverage to be complete \(0\/1\)/,
    );

    const inProgress = await fixture.host.tools.playwright_session_signoff_record(
      {
        sessionId,
        status: 'in_progress',
        summary: 'Functional pass completed; visual QA still pending.',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(inProgress);
    assert.match(inProgress.output.content, /ok: session QA signoff recorded\./);
    assert.match(
      inProgress.output.content,
      /decision gate detail: status=in_progress functional=pending visual=pending viewport=pending exploratory=pending cleanup=not_run/,
    );

    const updatedInventory = await fixture.host.tools.playwright_session_inventory_upsert(
      {
        sessionId,
        item: {
          id: 'critical_flow',
          kind: 'feature',
          label: 'Primary browser flow',
          functional: 'covered',
          visual: 'covered',
          artifact: 'qa-proof.png',
          notes: 'Visual pass completed.',
        },
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(updatedInventory);
    assert.match(updatedInventory.output.content, /ok: session QA inventory item updated\./);
    assert.match(
      updatedInventory.output.content,
      /coverage snapshot: inventory=1 functional=1\/1 visual=1\/1 pendingFunctional=none pendingVisual=none/,
    );

    const signoffReady = await fixture.host.tools.playwright_session_signoff_record(
      {
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
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(signoffReady);
    assert.match(signoffReady.output.content, /ok: session QA signoff recorded\./);
    assert.match(
      signoffReady.output.content,
      /decision gate detail: status=ready functional=pass visual=pass viewport=pass exploratory=pass cleanup=kept_alive/,
    );

    const signoffStatus = await fixture.host.tools.playwright_session_signoff_status(
      { sessionId },
      fixture.controllerCtx,
    );
    assertStructuredResult(signoffStatus);
    assert.match(signoffStatus.output.content, /ok: session QA signoff retrieved\./);
    assert.match(signoffStatus.output.content, /- pending visual items: none/);

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
    assert.equal(inventoryItem['visual'], 'covered');
    assert.equal(inventoryItem['artifact'], 'qa-proof.png');
    assert.equal(signoff['status'], 'ready');
    assert.equal(signoff['cleanupStatus'], 'kept_alive');
  } finally {
    await fixture.cleanup();
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
