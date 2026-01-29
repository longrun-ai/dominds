#!/usr/bin/env tsx

import 'dominds/tools/builtins';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DialogID, RootDialog } from 'dominds/dialog';
import { dialogEventRegistry } from 'dominds/evt-registry';
import { driveDialogStream } from 'dominds/llm/driver';
import { DiskFileDialogStore } from 'dominds/persistence';
import { EndOfStream } from 'dominds/shared/evt';
import type { TypedDialogEvent } from 'dominds/shared/types/dialog';

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

async function readNextEventWithTimeout(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent | null> {
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const ev = await Promise.race([ch.read(), timer]);
  if (ev === null) return null;
  if (ev === EndOfStream) return null;
  return ev;
}

async function driveToKeepGoingBudgetExhaustedQ4H(options: {
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
      '      - default',
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

  const ch = dialogEventRegistry.createSubChan(dlgId);

  await driveDialogStream(dlg, {
    content: 'hello',
    msgId: 'm-1',
    grammar: 'markdown',
    userLanguageCode,
  });

  const deadlineAt = Date.now() + 5000;
  while (Date.now() < deadlineAt) {
    const ev = await readNextEventWithTimeout(ch, 50);
    if (!ev) continue;
    if (ev.type !== 'new_q4h_asked') continue;
    if (ev.question.kind !== 'keep_going_budget_exhausted') continue;
    return ev.question.bodyContent;
  }

  throw new Error('Timed out waiting for keep_going_budget_exhausted new_q4h_asked');
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dominds-q4h-i18n-'));
  process.chdir(tmpBase);

  try {
    const zhBody = await driveToKeepGoingBudgetExhaustedQ4H({
      baseDir: tmpBase,
      dialogId: 'dlg-q4h-i18n-zh',
      userLanguageCode: 'zh',
    });
    if (!zhBody.includes('鞭策过')) {
      throw new Error(`Expected zh Q4H body to contain 鞭策过, got:\n${zhBody}`);
    }
    if (!zhBody.includes('`continue`') || !zhBody.includes('`stop`')) {
      throw new Error(`Expected zh Q4H body to include \`continue\` and \`stop\`, got:\n${zhBody}`);
    }

    const enBody = await driveToKeepGoingBudgetExhaustedQ4H({
      baseDir: tmpBase,
      dialogId: 'dlg-q4h-i18n-en',
      userLanguageCode: 'en',
    });
    if (!enBody.includes('Keep-going budget exhausted')) {
      throw new Error(
        `Expected en Q4H body to contain Keep-going budget exhausted, got:\n${enBody}`,
      );
    }
    if (!enBody.includes('`continue`') || !enBody.includes('`stop`')) {
      throw new Error(`Expected en Q4H body to include \`continue\` and \`stop\`, got:\n${enBody}`);
    }

    console.log('q4h keep-going i18n: PASS');
  } finally {
    process.chdir(originalCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`q4h keep-going i18n: FAIL\n${message}`);
  process.exit(1);
});
