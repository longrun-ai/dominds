#!/usr/bin/env tsx

import '../../main/tools/builtins';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { DiligenceBudgetEvent, TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
} from '../../main/bootstrap/global-dialog-event-broadcaster';
import { DialogID, RootDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

async function readNextEventWithTimeout(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent | null> {
  const timer = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  const ev = await Promise.race([ch.read(), timer]);
  if (ev === null) return null;
  if (ev === EndOfStream) return null;
  return ev;
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();

  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dominds-keep-going-'));
  process.chdir(tmpBase);
  try {
    await writeFileEnsuringDir(
      path.join(tmpBase, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: local-mock',
        '  model: default',
        'default_responder: tester',
        'members:',
        '  tester:',
        '    name: Tester',
        '    provider: local-mock',
        '    model: default',
        '    diligence-push-max: 2',
        '',
      ].join('\n'),
    );

    await writeFileEnsuringDir(
      path.join(tmpBase, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  local-mock:',
        '    name: Local Mock',
        '    apiType: mock',
        '    baseUrl: mock-db',
        '    apiKeyEnvVar: MOCK_API_KEY',
        '    models:',
        '      default:',
        '        name: Default',
        '',
      ].join('\n'),
    );

    await writeFileEnsuringDir(
      path.join(tmpBase, 'mock-db', 'default.yaml'),
      ['responses:', '  - message: "hello"', '    role: "user"', '    response: "ok"', ''].join(
        '\n',
      ),
    );

    await writeFileEnsuringDir(
      path.join(tmpBase, 'task.md'),
      ['# Test Task', '', 'This is a test Taskdoc.', ''].join('\n'),
    );

    const dlgId = new DialogID('dlg-keep-going-test');
    const store = new DiskFileDialogStore(dlgId);
    const dlg = new RootDialog(store, 'task.md', dlgId, 'tester');
    // Simulate normal root-dialog initialization done by server create/display handlers.
    const createdAt = formatUnifiedTimestamp(new Date());
    await DialogPersistence.saveDialogMetadata(dlg.id, {
      id: dlg.id.selfId,
      agentId: dlg.agentId,
      taskDocPath: dlg.taskDocPath,
      createdAt,
    });
    await DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: createdAt,
        status: 'active',
        messageCount: 0,
        functionCallCount: 0,
        subdialogCount: 0,
        displayState: { kind: 'idle_waiting_user' },
        disableDiligencePush: false,
        diligencePushRemainingBudget: 0,
      },
    }));
    dlg.diligencePushRemainingBudget = 2;
    globalDialogRegistry.register(dlg);
    installRecordingGlobalDialogEventBroadcaster({
      label: 'tests/diligence-budget-event',
    });

    const ch = dialogEventRegistry.createSubChan(dlgId);

    await driveDialogStream(
      dlg,
      {
        content: 'hello',
        msgId: 'm-1',
        grammar: 'markdown',
        userLanguageCode: 'en',
        origin: 'user',
      },
      true,
    );

    const diligenceEvents: DiligenceBudgetEvent[] = [];
    const deadlineAt = Date.now() + 2500;
    while (Date.now() < deadlineAt) {
      const ev = await readNextEventWithTimeout(ch, 50);
      if (ev === null) {
        continue;
      }
      if (ev.type === 'diligence_budget_evt') {
        diligenceEvents.push(ev);
      }
      if (diligenceEvents.length >= 2) {
        break;
      }
    }

    if (diligenceEvents.length === 0) {
      throw new Error('Expected at least one diligence_budget_evt, got 0');
    }

    const remainingCounts = diligenceEvents.map((ev) => ev.remainingCount);
    if (!remainingCounts.includes(1)) {
      throw new Error(
        `Expected remainingCount to include 1 after first diligence auto-continue, got: ${JSON.stringify(remainingCounts)}`,
      );
    }
    if (!remainingCounts.includes(0)) {
      throw new Error(
        `Expected remainingCount to reach 0 (budget exhausted), got: ${JSON.stringify(remainingCounts)}`,
      );
    }
    if (remainingCounts.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new Error(
        `Expected remainingCount values to be non-negative integers, got: ${JSON.stringify(remainingCounts)}`,
      );
    }

    console.log('keep-going diligence budget event (streaming): PASS');
  } finally {
    clearInstalledGlobalDialogEventBroadcaster();
    process.chdir(originalCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`keep-going diligence budget event (streaming): FAIL\n${message}`);
  process.exit(1);
});
