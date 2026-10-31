import type { HumanQuestion } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import { DialogPersistence } from '../../main/persistence';
import { syncPendingTellaskReminderState } from '../../main/tools/pending-tellask-reminder';
import { reminderData } from '../helpers/manual-reminders';
import {
  capturePending,
  pendingHistory,
  pendingMeta,
  pendingReminder,
  withPendingReminderRoot,
} from '../helpers/pending-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-pending-zero-');
async function main() {
  for (const language of ['zh', 'en'] as const) {
    await withPendingReminderRoot(language, async (root) => {
      const first = await pendingHistory(root, {
        label: language + '-one',
        createdAt: '2026-04-16 10:01:00',
        lastModified: '2026-04-16 10:03:00',
      });
      await DialogPersistence.saveActiveCalleeDispatches(
        root.id,
        [first.record],
        undefined,
        root.status,
      );
      assert.equal(await syncPendingTellaskReminderState(root), true);
      await root.processReminderUpdates();
      const id = pendingReminder(root).id;
      assert.equal(pendingMeta(pendingReminder(root)).pendingCount, 1);
      await capturePending({
        id: 'one-pending',
        language,
        scenario:
          'One declared sessioned child assignment is actually persisted and projected as the current dialog pending work.',
        root,
        givenData: JSON.stringify(first.record),
        evidence,
      });
      await DialogPersistence.saveActiveCalleeDispatches(root.id, [], undefined, root.status);
      assert.equal(await syncPendingTellaskReminderState(root), true);
      await root.processReminderUpdates();
      assert.equal(pendingReminder(root).id, id);
      const zero = pendingMeta(pendingReminder(root));
      assert.equal(zero.pendingCount, 0);
      assert.equal(typeof zero.updatedAt, 'string');
      await capturePending({
        id: 'zero-no-extra-wait',
        language,
        scenario:
          'The current dialog active-call file is now empty, while its zero-state status window remains. This dialog has no registered human wait; the component does not observe all other roots or external wait conditions.',
        root,
        givenData: JSON.stringify({
          currentPending: 0,
          registeredHumanWait: false,
          otherRootWork: 'not observed by this component',
        }),
        evidence,
      });
      // Hydrate the actual stored fields before testing a later owner reconciliation;
      // this is a persisted-reminder fixture, not a process restart claim.
      root.reminders.splice(
        0,
        root.reminders.length,
        ...(await DialogPersistence.loadReminderState(root.id, root.status)),
      );
      const before = {
        version: root.remindersVer,
        updatedAt: root.updatedAt,
        memory: reminderData(root.reminders),
        disk: reminderData(await DialogPersistence.loadReminderState(root.id, root.status)),
      };
      assert.equal(await syncPendingTellaskReminderState(root), false);
      await root.processReminderUpdates();
      assert.deepEqual(
        {
          version: root.remindersVer,
          updatedAt: root.updatedAt,
          memory: reminderData(root.reminders),
          disk: reminderData(await DialogPersistence.loadReminderState(root.id, root.status)),
        },
        before,
      );
      const other = await createMainDialog();
      other.setLastUserLanguageCode(language);
      const independent = await pendingHistory(other, {
        label: language + '-independent',
        createdAt: '2026-04-16 10:01:00',
        lastModified: '2026-04-16 10:05:00',
      });
      await DialogPersistence.saveActiveCalleeDispatches(
        other.id,
        [independent.record],
        undefined,
        other.status,
      );
      const question: HumanQuestion = {
        id: 'question-' + language,
        tellaskContent: 'Choose which of the two supplied outcomes to prioritize.',
        askedAt: formatUnifiedTimestamp(new Date()),
        callId: 'human-wait-' + language,
        callSiteRef: { course: root.currentCourse, messageIndex: 0 },
      };
      await root.updateQuestions4Human([question]);
      assert.equal(await root.hasPendingQ4H(), true);
      assert.equal(await root.canDrive(), false);
      assert.equal(await other.hasActiveCalleeDispatches(), true);
      assert.equal(await root.hasActiveCalleeDispatches(), false);
      const questions = await DialogPersistence.loadQuestions4HumanState(root.id, root.status);
      assert.deepEqual(questions, [question]);
      assert.equal(await syncPendingTellaskReminderState(root), false);
      await root.processReminderUpdates();
      assert.deepEqual(
        await DialogPersistence.loadQuestions4HumanState(root.id, root.status),
        questions,
      );
      assert.equal(await root.canDrive(), false);
      assert.equal(await other.hasActiveCalleeDispatches(), true);
      await capturePending({
        id: 'zero-with-human-and-other-work',
        language,
        scenario:
          'This dialog has zero pending tellasks but a real persisted human-question/user-wait state blocks automatic drive. An independent root has a persisted pending call. The status component reads only this dialog tellasks.',
        root,
        givenData: JSON.stringify({
          currentPending: 0,
          humanQuestion: question,
          canDrive: false,
          otherRootPending: [independent.record],
        }),
        evidence,
      });
    });
  }
  await evidence.write();
  console.log(
    'Zero-state reminder persistence/version stability with independent wait state: PASS',
  );
}
const watchdog = setTimeout(() => {
  throw new Error('Pending zero-state case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
