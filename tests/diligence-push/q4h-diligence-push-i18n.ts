#!/usr/bin/env tsx

import '../../main/tools/builtins';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { UiOnlyMarkdownRecord } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID, MainDialog } from '../../main/dialog';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

async function driveToDiligencePushBudgetExhaustedNotice(options: {
  baseDir: string;
  dialogId: string;
  userLanguageCode: 'zh' | 'en';
}): Promise<string> {
  const { baseDir, dialogId, userLanguageCode } = options;

  await writeFileEnsuringDir(
    path.join(baseDir, '.minds', 'team.yaml'),
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
      '    diligence-push-max: 1',
      '',
    ].join('\n'),
  );

  await writeFileEnsuringDir(
    path.join(baseDir, '.minds', 'llm.yaml'),
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
    path.join(baseDir, 'mock-db', 'default.yaml'),
    ['responses:', '  - message: "hello"', '    role: "user"', '    response: "ok"', ''].join('\n'),
  );

  await writeFileEnsuringDir(path.join(baseDir, 'task.md'), '# Test Task\n');

  const dlgId = new DialogID(dialogId);
  const store = new DiskFileDialogStore(dlgId);
  const dlg = new MainDialog(store, 'task.md', dlgId, 'tester');
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
      sideDialogCount: 0,
      displayState: { kind: 'idle_waiting_user' },
      disableDiligencePush: false,
      diligencePushRemainingBudget: 0,
    },
  }));

  await driveDialogStream(
    dlg,
    {
      content: 'hello',
      msgId: 'm-1',
      grammar: 'markdown',
      userLanguageCode,
      origin: 'user',
    },
    true,
  );

  const courseEvents = await DialogPersistence.loadCourseEvents(
    dlg.id,
    dlg.currentCourse,
    dlg.status,
  );
  const notice = courseEvents.find(
    (event): event is UiOnlyMarkdownRecord => event.type === 'ui_only_markdown_record',
  );
  if (notice) {
    return notice.content;
  }

  throw new Error('Expected diligence_push_budget_exhausted ui_only_markdown_record');
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpBase = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'dominds-diligence-exhaustion-i18n-'),
  );
  process.chdir(tmpBase);

  try {
    const zhBody = await driveToDiligencePushBudgetExhaustedNotice({
      baseDir: tmpBase,
      dialogId: 'dlg-q4h-i18n-zh',
      userLanguageCode: 'zh',
    });
    if (!zhBody.includes('已经鞭策了') || !zhBody.includes('智能体仍不听劝')) {
      throw new Error(
        `Expected zh notice body to contain current diligence exhaustion wording, got:\n${zhBody}`,
      );
    }

    const enBody = await driveToDiligencePushBudgetExhaustedNotice({
      baseDir: tmpBase,
      dialogId: 'dlg-q4h-i18n-en',
      userLanguageCode: 'en',
    });
    if (!enBody.includes('Diligence Push attempts') || !enBody.includes('still not moved')) {
      throw new Error(
        `Expected en notice body to contain current diligence exhaustion wording, got:\n${enBody}`,
      );
    }

    console.log('diligence push exhaustion notice i18n: PASS');
  } finally {
    process.chdir(originalCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`diligence push exhaustion notice i18n: FAIL\n${message}`);
  process.exit(1);
});
