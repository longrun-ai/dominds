import assert from 'node:assert/strict';

import {
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
        label: 'observer-contract',
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

    const observerStatusBeforeAttach = await fixture.host.tools.playwright_session_status(
      { sessionId },
      fixture.observerCtx,
    );
    assertStructuredResult(observerStatusBeforeAttach);
    assert.match(observerStatusBeforeAttach.output, /role=not attached/);
    assert.match(observerStatusBeforeAttach.output, /use playwright_session_attach/);

    const attached = await fixture.host.tools.playwright_session_attach(
      { sessionId, role: 'observer' },
      fixture.observerCtx,
    );
    assertStructuredResult(attached);
    assert.match(attached.output, /ok: session attachment updated\./);
    assert.match(attached.output, /attachment: current dialog attached as observer/);
    assert.match(attached.output, /reminder sync: current=refreshed; other=1 updates\/1 dialogs/);

    const observerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(attached), {
        dialogId: fixture.observerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    assert.ok(Array.isArray(attached.dialogReminderRequests));
    assert.equal(attached.dialogReminderRequests?.length, 1);
    assert.equal(
      attached.dialogReminderRequests?.[0]?.target['dialogId'],
      fixture.controllerCtx.dialogId,
    );

    const observerStatus = await fixture.host.tools.playwright_session_status(
      { sessionId },
      fixture.observerCtx,
    );
    assertStructuredResult(observerStatus);
    assert.match(observerStatus.output, /role=observer/);
    assert.match(observerStatus.output, /attachment: current dialog attached as observer/);

    const renderedReminder = await fixture.reminderOwner.renderReminder({
      dialogId: fixture.observerCtx.dialogId,
      reminder: observerReminder,
      reminderNo: 1,
      workLanguage: 'en',
    });
    assert.match(renderedReminder.content, /role=observer/);
    assert.match(renderedReminder.content, /surface: page https:\/\/example\.test\/initial/);
    assert.match(renderedReminder.content, /coverage snapshot:/);
    assert.match(renderedReminder.content, /decision gate:/);

    const detached = await fixture.host.tools.playwright_session_detach(
      { sessionId },
      fixture.observerCtx,
    );
    assertStructuredResult(detached);
    assert.match(detached.output, /ok: session detached\./);
    assert.match(detached.output, /reminder sync: current=removed; other=1 updates\/1 dialogs/);

    const staleObserverReminder = await fixture.reminderOwner.updateReminder({
      dialogId: fixture.observerCtx.dialogId,
      reminder: observerReminder,
    });
    assert.equal(staleObserverReminder.treatment, 'drop');

    const controllerReminderUpdate = await fixture.reminderOwner.updateReminder({
      dialogId: fixture.controllerCtx.dialogId,
      reminder: controllerReminder,
    });
    assert.equal(controllerReminderUpdate.treatment, 'update');
    if (controllerReminderUpdate.treatment === 'update') {
      assert.match(controllerReminderUpdate.updatedContent, /https:\/\/example\.test\/initial/);
    }

    const closed = await fixture.host.tools.playwright_session_close(
      { sessionId },
      fixture.controllerCtx,
    );
    assertStructuredResult(closed);
    assert.match(closed.output, /ok: session closed\./);

    const closedControllerReminder = await fixture.reminderOwner.updateReminder({
      dialogId: fixture.controllerCtx.dialogId,
      reminder: controllerReminder,
    });
    assert.equal(closedControllerReminder.treatment, 'drop');
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
