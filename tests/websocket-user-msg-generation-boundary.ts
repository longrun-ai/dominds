import assert from 'node:assert/strict';

import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import { DialogID, MainDialog } from '../main/dialog';
import {
  resetContextHealthRoundState,
  resolveCriticalCountdownRemaining,
} from '../main/llm/kernel-driver/context-health';
import { DiskFileDialogStore } from '../main/persistence';
import {
  resolveUserMessageLanguageCodeForTest,
  shouldQueueUserSupplementAtGenerationBoundary,
  wrapCriticalUserInterjectionPromptAtIngress,
} from '../main/server/websocket-handler';
import { generateDialogID } from '../main/utils/id';

function main(): void {
  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: false,
      inMemoryGenerating: false,
      isLocked: true,
    }),
    false,
    'should not queue when neither persisted nor in-memory generating state is active',
  );

  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: true,
      inMemoryGenerating: false,
      isLocked: true,
    }),
    true,
    'should queue when persisted latest says generating',
  );

  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: false,
      inMemoryGenerating: true,
      isLocked: true,
    }),
    true,
    'should queue during the live generating-start race window before latest.yaml flips',
  );

  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: true,
      inMemoryGenerating: true,
      isLocked: false,
    }),
    false,
    'should not queue once the dialog lock is gone even if stale generating flags remain',
  );

  console.log('websocket-user-msg-generation-boundary: PASS');
}

function mainAsync(): void {
  main();

  const dialogId = new DialogID(generateDialogID());
  const dialog = new MainDialog(new DiskFileDialogStore(dialogId), 'task.md', dialogId, 'tester');
  resetContextHealthRoundState(dialog.id.key());
  const criticalSnapshot: ContextHealthSnapshot = {
    kind: 'available',
    promptTokens: 190_000,
    completionTokens: 100,
    totalTokens: 190_100,
    modelContextLimitTokens: 200_000,
    effectiveOptimalMaxTokens: 180_000,
    effectiveCriticalMaxTokens: 180_000,
    hardUtil: 0.95,
    optimalUtil: 190_000 / 180_000,
    level: 'critical',
  };
  dialog.setLastContextHealth(criticalSnapshot);
  dialog.setLastUserLanguageCode('en');
  assert.equal(
    resolveUserMessageLanguageCodeForTest({
      ws: {} as WebSocket,
      raw: undefined,
      fallbackDialog: dialog,
    }),
    'en',
    'user message language resolution should fall back to the target dialog after it is known',
  );

  const wrapped = wrapCriticalUserInterjectionPromptAtIngress(dialog, {
    content: '用户插话正文',
    msgId: 'critical-ingress-user-msg',
    grammar: 'markdown',
    userLanguageCode: 'zh',
  });
  assert.ok(
    wrapped.content.includes('本轮刚收到的用户消息是真实用户插话'),
    'critical ingress wrapper should prepend the current-turn user interjection guide in the incoming user language',
  );
  assert.ok(wrapped.content.endsWith('\n\n用户插话正文'));
  assert.equal(
    wrapped.msgId,
    'critical-ingress-user-msg',
    'critical ingress wrapping must preserve the original message id',
  );
  assert.ok(
    !wrapped.content.includes('下面紧跟'),
    'critical ingress wrapper should not use positional adjacency wording',
  );

  const wrappedAgain = wrapCriticalUserInterjectionPromptAtIngress(dialog, wrapped);
  assert.equal(wrappedAgain.content, wrapped.content, 'critical ingress wrapping is idempotent');
  assert.equal(
    resolveCriticalCountdownRemaining(dialog.id.key(), criticalSnapshot),
    4,
    'critical ingress wrapping should consume countdown once, not again on an already wrapped prompt',
  );

  console.log('websocket-user-msg-critical-ingress-wrapper: PASS');
}

try {
  mainAsync();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`websocket-user-msg-generation-boundary: FAIL\n${message}`);
  process.exit(1);
}
