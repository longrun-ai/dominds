import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import assert from 'node:assert/strict';
import type { MainDialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { formatReminderItemGuide } from '../../main/runtime/driver-messages';
import { mutateSharedReminders } from '../../main/shared-reminders';
import { materializeReminder, type JsonValue, type ToolCallOutput } from '../../main/tool';
import { addReminderTool, updateReminderTool } from '../../main/tools/ctrl';
import { reminderCaller, withManualReminderDialog } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { sharedReminderFile } from '../helpers/shared-reminders';

const CAUTION_SNAPSHOT: ContextHealthSnapshot = {
  kind: 'available',
  promptTokens: 105_000,
  completionTokens: 120,
  modelContextWindowText: '128k',
  modelContextLimitTokens: 128_000,
  effectiveOptimalMaxTokens: 100_000,
  effectiveCriticalMaxTokens: 120_000,
  hardUtil: 0.82,
  optimalUtil: 1.05,
  level: 'caution',
};

const CRITICAL_SNAPSHOT: ContextHealthSnapshot = {
  kind: 'available',
  promptTokens: 123_000,
  completionTokens: 140,
  modelContextWindowText: '128k',
  modelContextLimitTokens: 128_000,
  effectiveOptimalMaxTokens: 100_000,
  effectiveCriticalMaxTokens: 120_000,
  hardUtil: 0.96,
  optimalUtil: 1.23,
  level: 'critical',
};

const HEALTHY_SNAPSHOT: ContextHealthSnapshot = {
  kind: 'available',
  promptTokens: 24_000,
  completionTokens: 90,
  modelContextWindowText: '128k',
  modelContextLimitTokens: 128_000,
  effectiveOptimalMaxTokens: 100_000,
  effectiveCriticalMaxTokens: 120_000,
  hardUtil: 0.19,
  optimalUtil: 0.24,
  level: 'healthy',
};

const evidence = semanticEvidenceCollector('dominds-continuation-tags-');
async function add(root: MainDialog, body: string, scope: 'task' | 'dialog' = 'task') {
  const before = new Set((await root.listVisibleReminders()).map((row) => row.id));
  const receipt = await addReminderTool.call(root, reminderCaller, {
    content: body,
    ...(scope === 'dialog' ? { scope } : {}),
  });
  assert.equal(receipt.outcome, 'success');
  const fresh = (await root.listVisibleReminders()).filter((row) => !before.has(row.id));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.scope, scope);
  return { id: fresh[0]!.id, receipt };
}
async function capture(args: {
  id: string;
  language: 'zh' | 'en';
  root: MainDialog;
  reminderId: string;
  body: string;
  meta: JsonValue | undefined;
  scope: 'task' | 'dialog';
  receipt: ToolCallOutput;
  givenHealth: ContextHealthSnapshot;
}) {
  const reminder = (await args.root.listVisibleReminders()).find(
    (row) => row.id === args.reminderId,
  );
  assert.ok(reminder);
  assert.equal(reminder.content, args.body);
  assert.equal(reminder.scope, args.scope);
  assert.equal(reminder.renderMode, 'markdown');
  assert.deepEqual(reminder.meta, args.meta);
  await args.root.processReminderUpdates();
  if (args.scope === 'task') {
    assert.equal(
      args.root.reminders.some((row) => row.id === args.reminderId),
      false,
    );
    const stored = await sharedReminderFile(process.cwd(), args.reminderId);
    assert.ok(stored);
    assert.equal(stored.data.content, args.body);
    assert.equal(stored.data.scope, 'task');
    assert.deepEqual(stored.data.meta, args.meta);
  } else {
    const stored = await DialogPersistence.loadReminderState(args.root.id, args.root.status);
    const disk = stored.find((row) => row.id === args.reminderId);
    assert.ok(disk);
    assert.equal(disk.content, args.body);
    assert.equal(disk.scope, 'dialog');
    assert.deepEqual(disk.meta, args.meta);
  }
  evidence.record({
    id: args.language + '-' + args.id,
    scenario:
      'A real reminder tool responds to the explicitly supplied context-health snapshot; its stable ID, given body, scope and continuation metadata are preserved through public visibility and physical storage.',
    businessValue:
      'Keep easy-to-lose work available for continuation while allowing healthy-context editing to turn bridge notes back into ordinary task/private data without losing other metadata.',
    context: {
      language: args.language,
      givenHealth: JSON.stringify(args.givenHealth),
      givenBody: args.body,
      storedMeta: JSON.stringify(args.meta ?? null),
      scope: args.scope,
      scopeLimit:
        'Actual tool/formatter/store with declared snapshot input. This checks tagging and data preservation, not actual pressure classification, a course transition, provider behavior or restart recovery.',
    },
    reviewQuestions: [
      'Do the actual receipt and guide accurately describe this continuation or ordinary note, without treating given reference data as a newly assigned command or claiming an unperformed context transition?',
    ],
    actualText: JSON.stringify(
      {
        receipt: args.receipt,
        guide: formatReminderItemGuide(args.language, reminder.id, reminder.content, {
          meta: reminder.meta,
          scope: reminder.scope,
        }),
      },
      null,
      2,
    ),
  });
}
async function main() {
  for (const language of ['zh', 'en'] as const) {
    await withManualReminderDialog(language, async (root) => {
      root.setLastContextHealth(CAUTION_SNAPSHOT);
      const firstBody = 'Carry this across the course boundary.';
      const first = await add(root, firstBody);
      await capture({
        id: 'caution-default-task',
        language,
        root,
        reminderId: first.id,
        body: firstBody,
        meta: {
          kind: 'continuation_package',
          createdBy: 'context_health',
          contextHealthLevel: 'caution',
        },
        scope: 'task',
        receipt: first.receipt,
        givenHealth: CAUTION_SNAPSHOT,
      });
      root.setLastContextHealth(CRITICAL_SNAPSHOT);
      const criticalBody = 'Carry this across the course boundary, then reconcile immediately.';
      const critical = await updateReminderTool.call(root, reminderCaller, {
        reminder_id: first.id,
        content: criticalBody,
      });
      assert.equal(critical.outcome, 'success');
      await capture({
        id: 'critical-update',
        language,
        root,
        reminderId: first.id,
        body: criticalBody,
        meta: {
          kind: 'continuation_package',
          createdBy: 'context_health',
          contextHealthLevel: 'critical',
        },
        scope: 'task',
        receipt: critical,
        givenHealth: CRITICAL_SNAPSHOT,
      });
      const checkpoint = { sequence: 7, remaining: ['A', 'B'] };
      await mutateSharedReminders(
        { kind: 'task', agentId: root.agentId, taskDocPath: root.taskDocPath },
        (reminders) => {
          const index = reminders.findIndex((row) => row.id === first.id);
          assert.ok(index >= 0);
          const reminder = reminders[index]!;
          assert.ok(
            reminder.meta && typeof reminder.meta === 'object' && !Array.isArray(reminder.meta),
          );
          reminders[index] = materializeReminder({
            ...reminder,
            meta: { ...reminder.meta, checkpoint },
          });
        },
      );
      root.setLastContextHealth(HEALTHY_SNAPSHOT);
      const healthyBody = 'Plain reminder content.';
      const healthy = await add(root, healthyBody);
      await capture({
        id: 'healthy-new',
        language,
        root,
        reminderId: healthy.id,
        body: healthyBody,
        meta: undefined,
        scope: 'task',
        receipt: healthy.receipt,
        givenHealth: HEALTHY_SNAPSHOT,
      });
      const ordinaryBody = 'Now ordinary work data, with the original checkpoint retained.';
      const ordinary = await updateReminderTool.call(root, reminderCaller, {
        reminder_id: first.id,
        content: ordinaryBody,
      });
      assert.equal(ordinary.outcome, 'success');
      await capture({
        id: 'healthy-preserves-other-meta',
        language,
        root,
        reminderId: first.id,
        body: ordinaryBody,
        meta: { checkpoint },
        scope: 'task',
        receipt: ordinary,
        givenHealth: HEALTHY_SNAPSHOT,
      });
      root.setLastContextHealth(CAUTION_SNAPSHOT);
      const bridge = await add(root, 'Bridge note that should later become a normal reminder.');
      assert.deepEqual(
        (await root.listVisibleReminders()).find((row) => row.id === bridge.id)?.meta,
        {
          kind: 'continuation_package',
          createdBy: 'context_health',
          contextHealthLevel: 'caution',
        },
      );
      root.setLastContextHealth(HEALTHY_SNAPSHOT);
      const recoveredBody = 'Now rewritten under healthy context.';
      const recovered = await updateReminderTool.call(root, reminderCaller, {
        reminder_id: bridge.id,
        content: recoveredBody,
      });
      assert.equal(recovered.outcome, 'success');
      await capture({
        id: 'recovered-clears-marker',
        language,
        root,
        reminderId: bridge.id,
        body: recoveredBody,
        meta: null,
        scope: 'task',
        receipt: recovered,
        givenHealth: HEALTHY_SNAPSHOT,
      });
      root.setLastContextHealth(CAUTION_SNAPSHOT);
      const privateBody = 'Private continuation pointers for this dialog only.';
      const privateNote = await add(root, privateBody, 'dialog');
      await capture({
        id: 'explicit-private-bridge',
        language,
        root,
        reminderId: privateNote.id,
        body: privateBody,
        meta: {
          kind: 'continuation_package',
          createdBy: 'context_health',
          contextHealthLevel: 'caution',
        },
        scope: 'dialog',
        receipt: privateNote.receipt,
        givenHealth: CAUTION_SNAPSHOT,
      });
    });
  }
  await evidence.write();
  console.log('Context-state continuation tagging, visibility and storage: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Continuation tag case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
