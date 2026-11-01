import assert from 'node:assert/strict';
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

const evidence = semanticEvidenceCollector(
  'dominds-external-apps-web-dev-session-observer-reminders-',
);
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
        label: 'observer-contract',
        entryUrl: 'https://example.test/initial',
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(created);
    const controllerUpsert = requireSingleUpsertReminder(created);
    const controllerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(controllerUpsert, {
        dialogId: fixture.controllerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    const sessionId = sessionIdFromReminder(controllerReminder);
    assertRecord(controllerReminder.meta);
    assert.equal(controllerReminder.meta['role'], 'controller');

    await rejectWebDevAction(
      async () =>
        await fixture.reminderOwner.apply(controllerUpsert, {
          dialogId: fixture.controllerCtx.dialogId,
          ownedReminders: [{ content: 'corrupt owned reminder', meta: { sessionId } }],
        }),
    );
    await rejectWebDevAction(
      async () =>
        await fixture.reminderOwner.apply(controllerUpsert, {
          dialogId: fixture.controllerCtx.dialogId,
          ownedReminders: [
            controllerReminder,
            { content: 'corrupt trailing reminder', meta: { sessionId: 'pws_other' } },
          ],
        }),
    );
    await rejectWebDevAction(
      async () =>
        await fixture.reminderOwner.apply(controllerUpsert, {
          dialogId: fixture.controllerCtx.dialogId,
          ownedReminders: [controllerReminder, controllerReminder],
        }),
    );
    await rejectWebDevAction(
      async () =>
        await fixture.reminderOwner.updateReminder({
          dialogId: fixture.controllerCtx.dialogId,
          reminder: { content: 'corrupt update reminder', meta: { sessionId } },
        }),
    );
    await rejectWebDevAction(
      async () =>
        await fixture.reminderOwner.renderReminder({
          dialogId: fixture.controllerCtx.dialogId,
          reminder: { content: 'corrupt render reminder', meta: { sessionId } },
          reminderId: 'corrupt-reminder',
          workLanguage: 'en',
        }),
    );

    await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_list(
          { scope: 'same_root_dialog' },
          fixture.controllerCtx,
        ),
    );

    await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_attach(
          {
            sessionId,
            role: 'observer',
            target: {
              rootDialogId: fixture.controllerCtx.mainDialogId,
              agentId: fixture.observerCtx.agentId,
            },
          },
          fixture.controllerCtx,
        ),
    );

    const implicitMainTarget = {
      agentId: fixture.observerCtx.agentId,
      sessionSlug: fixture.observerCtx.sessionSlug,
    };
    const implicitMainAttach = await fixture.host.tools.playwright_session_attach(
      { sessionId, role: 'observer', target: implicitMainTarget },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(implicitMainAttach);
    const implicitMainStatus = await fixture.host.tools.playwright_session_status(
      { sessionId },
      fixture.observerCtx,
    );
    assertSuccessfulResult(implicitMainStatus);
    observe(
      'implicitMainStatus',
      implicitMainStatus.output.content,
      implicitMainStatus.output.outcome,
    );
    const implicitMainDetach = await fixture.host.tools.playwright_session_detach(
      { sessionId, target: implicitMainTarget },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(implicitMainDetach);

    const otherRootList = await fixture.host.tools.playwright_session_list(
      { scope: 'same_main_dialog' },
      {
        ...fixture.observerCtx,
        dialogId: 'dlg_other_root',
        mainDialogId: 'root_other',
      },
    );
    assertSuccessfulResult(otherRootList);
    observe('otherRootList', otherRootList.output.content, otherRootList.output.outcome);
    // The generated opaque session identifier is confidential data, not a prose oracle.
    assert.equal(otherRootList.output.content.includes(sessionId), false);

    const observerStatusBeforeAttach = await fixture.host.tools.playwright_session_status(
      { sessionId },
      fixture.observerCtx,
    );
    assertSuccessfulResult(observerStatusBeforeAttach);
    observe(
      'observerStatusBeforeAttach',
      observerStatusBeforeAttach.output.content,
      observerStatusBeforeAttach.output.outcome,
    );

    const attached = await fixture.host.tools.playwright_session_attach(
      { sessionId, role: 'observer' },
      fixture.observerCtx,
    );
    assertSuccessfulResult(attached);
    observe('attached', attached.output.content, attached.output.outcome);

    const observerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(attached), {
        dialogId: fixture.observerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    assert.equal(sessionIdFromReminder(observerReminder), sessionId);
    assertRecord(observerReminder.meta);
    assert.equal(observerReminder.meta['role'], 'observer');
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
    assertSuccessfulResult(observerStatus);
    observe('observerStatus', observerStatus.output.content, observerStatus.output.outcome);

    const renderedReminder = await fixture.reminderOwner.renderReminder({
      dialogId: fixture.observerCtx.dialogId,
      reminder: observerReminder,
      reminderId: 'observer-reminder',
      workLanguage: 'en',
    });
    observe('renderedReminder', renderedReminder.content);

    const detached = await fixture.host.tools.playwright_session_detach(
      { sessionId },
      fixture.observerCtx,
    );
    assertSuccessfulResult(detached);
    observe('detached', detached.output.content, detached.output.outcome);

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
      if (typeof controllerReminderUpdate.updatedContent !== 'string') {
        throw new Error('Expected updated reminder content to be a string');
      }
      observe('controllerReminderUpdate', controllerReminderUpdate.updatedContent);
    }

    const closed = await fixture.host.tools.playwright_session_close(
      { sessionId },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(closed);
    observe('closed', closed.output.content, closed.output.outcome);

    const closedControllerReminder = await fixture.reminderOwner.updateReminder({
      dialogId: fixture.controllerCtx.dialogId,
      reminder: controllerReminder,
    });
    assert.equal(closedControllerReminder.treatment, 'drop');
    completed = true;
  } finally {
    await fixture.cleanup({ preserve: !completed });
  }
}

runExternalWebDevScenario(async () => {
  await main();
  const identity = webDevComponentIdentity();
  evidence.record({
    id: 'observer-attachment-guidance',
    scenario:
      'A controller session is shared with an observer in the same main dialog, queried from another main dialog, attached/detached and closed.',
    businessValue:
      'Preserve role visibility, usable attachment guidance and accurate reminder updates without leaking a different main dialog session.',
    context: {
      ...{
        initialUrl: 'https://example.test/initial',
        controllerMain: 'root_demo',
        otherMain: 'root_other',
        boundary:
          'Real selected component; controlled Playwright/Electron provider, no real browser/visual QA acceptance.',
      },
      componentRoot: identity.root,
      componentPackageJsonSha256: identity.packageJsonSha256,
    },
    reviewQuestions: [
      'Do actual status/list/attach/detach and reminder texts agree with the caller role and actual metadata/reminder requests at each stage?',
      'Does the other-main-dialog list avoid disclosing the controller session, and do not-attached callers receive usable guidance?',
      'Does reminder rendering describe the current session and role without claiming browser/permission actions this fixture did not execute?',
    ],
    actualText: JSON.stringify(observations, null, 2),
  });
  await evidence.write();
  console.log(
    'Selected external Web Dev machine workflow completed; semantic acceptance is separate.',
  );
});
