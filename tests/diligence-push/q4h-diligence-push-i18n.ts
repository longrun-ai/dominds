#!/usr/bin/env tsx

import 'dominds/tools/builtins';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DialogID, RootDialog } from 'dominds/dialog';
import { setQ4HBroadcaster } from 'dominds/evt-registry';
import { driveDialogStream } from 'dominds/llm/kernel-driver';
import { DiskFileDialogStore } from 'dominds/persistence';
import type { TypedDialogEvent } from 'dominds/shared/types/dialog';

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

async function driveToDiligencePushBudgetExhaustedQ4H(options: {
  baseDir: string;
  dialogId: string;
  userLanguageCode: 'zh' | 'en';
  received: TypedDialogEvent[];
}): Promise<string> {
  const { baseDir, dialogId, userLanguageCode, received } = options;

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
  const dlg = new RootDialog(store, 'task.md', dlgId, 'tester');

  await driveDialogStream(dlg, {
    content: 'hello',
    msgId: 'm-1',
    grammar: 'markdown',
    userLanguageCode,
  });

  const deadlineAt = Date.now() + 5000;
  while (Date.now() < deadlineAt) {
    const ev = received.find((entry) => {
      return (
        entry.type === 'new_q4h_asked' &&
        entry.dialog.rootId === dlgId.rootId &&
        entry.dialog.selfId === dlgId.selfId
      );
    });
    if (ev && ev.type === 'new_q4h_asked') {
      return ev.question.tellaskContent;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for diligence_push_budget_exhausted new_q4h_asked');
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dominds-q4h-i18n-'));
  process.chdir(tmpBase);
  const received: TypedDialogEvent[] = [];
  setQ4HBroadcaster((evt) => {
    received.push(evt);
  });

  try {
    const zhBody = await driveToDiligencePushBudgetExhaustedQ4H({
      baseDir: tmpBase,
      dialogId: 'dlg-q4h-i18n-zh',
      userLanguageCode: 'zh',
      received,
    });
    if (!zhBody.includes('已经鞭策了') || !zhBody.includes('智能体仍不听劝')) {
      throw new Error(
        `Expected zh Q4H body to contain current diligence exhaustion wording, got:\n${zhBody}`,
      );
    }

    const enBody = await driveToDiligencePushBudgetExhaustedQ4H({
      baseDir: tmpBase,
      dialogId: 'dlg-q4h-i18n-en',
      userLanguageCode: 'en',
      received,
    });
    if (!enBody.includes('Diligence Push attempts') || !enBody.includes('still not moved')) {
      throw new Error(
        `Expected en Q4H body to contain current diligence exhaustion wording, got:\n${enBody}`,
      );
    }

    console.log('q4h diligence push i18n: PASS');
  } finally {
    setQ4HBroadcaster(null);
    process.chdir(originalCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`q4h diligence push i18n: FAIL\n${message}`);
  process.exit(1);
});
