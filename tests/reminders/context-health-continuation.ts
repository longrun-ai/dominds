import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { addReminderTool, updateReminderTool } from '../../main/tools/ctrl';

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

function createDialog(): RootDialog {
  return new RootDialog(
    {} as unknown as DialogStore,
    'context-health-continuation.tsk',
    undefined,
    'tester',
  );
}

async function main(): Promise<void> {
  setWorkLanguage('en');

  const cautionDialog = createDialog();
  cautionDialog.setLastContextHealth(CAUTION_SNAPSHOT);
  await addReminderTool.call(cautionDialog, {} as Team.Member, {
    content: 'Carry this across the course boundary.',
  });
  assert.deepEqual(cautionDialog.reminders[0]?.meta, {
    kind: 'continuation_package',
    createdBy: 'context_health',
    contextHealthLevel: 'caution',
  });

  cautionDialog.setLastContextHealth(CRITICAL_SNAPSHOT);
  const cautionReminderId = cautionDialog.reminders[0]?.id;
  assert.equal(typeof cautionReminderId, 'string');
  await updateReminderTool.call(cautionDialog, {} as Team.Member, {
    reminder_id: cautionReminderId,
    content: 'Carry this across the course boundary, then reconcile immediately.',
  });
  assert.deepEqual(cautionDialog.reminders[0]?.meta, {
    kind: 'continuation_package',
    createdBy: 'context_health',
    contextHealthLevel: 'critical',
  });

  const healthyDialog = createDialog();
  healthyDialog.setLastContextHealth(HEALTHY_SNAPSHOT);
  await addReminderTool.call(healthyDialog, {} as Team.Member, {
    content: 'Plain reminder content.',
  });
  assert.equal(
    healthyDialog.reminders[0]?.meta,
    undefined,
    'healthy context should not auto-tag reminders as continuation packages',
  );

  const recoveredDialog = createDialog();
  recoveredDialog.setLastContextHealth(CAUTION_SNAPSHOT);
  await addReminderTool.call(recoveredDialog, {} as Team.Member, {
    content: 'Bridge note that should later become a normal reminder.',
  });
  assert.deepEqual(recoveredDialog.reminders[0]?.meta, {
    kind: 'continuation_package',
    createdBy: 'context_health',
    contextHealthLevel: 'caution',
  });
  recoveredDialog.setLastContextHealth(HEALTHY_SNAPSHOT);
  const recoveredReminderId = recoveredDialog.reminders[0]?.id;
  assert.equal(typeof recoveredReminderId, 'string');
  await updateReminderTool.call(recoveredDialog, {} as Team.Member, {
    reminder_id: recoveredReminderId,
    content: 'Now rewritten under healthy context.',
  });
  assert.equal(
    recoveredDialog.reminders[0]?.meta,
    null,
    'healthy update should clear continuation-package marker from ordinary reminders',
  );

  console.log('✓ context-health continuation reminder tagging test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
