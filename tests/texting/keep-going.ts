import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { DialogID, RootDialog } from 'dominds/dialog';
import { DialogFactory } from 'dominds/dialog-factory';
import { driveDialogStream } from 'dominds/llm/driver';
import { DiskFileDialogStore } from 'dominds/persistence';
import { setWorkLanguage } from 'dominds/shared/runtime-language';

const DILIGENCE_ZH = [
  '除非确实需要人类用户介入，请继续你的工作。',
  '',
  '作为智能体团队成员，你能自己动手的事儿就绝不要麻烦人类。',
  '',
  '不该或者不能自主继续工作时，你应该使用 `!!@human` 诉请人类确认相关问题或者指出工作方向。',
].join('\n');

const DILIGENCE_GENERIC = 'GENERIC DILIGENCE: please keep going.';

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

function lastAssistantSayingContent(dialog: RootDialog): string | null {
  const msgs = dialog.msgs.filter((m) => m.type === 'saying_msg' && m.role === 'assistant');
  const last = msgs[msgs.length - 1];
  return last ? last.content : null;
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const rtws = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-keep-going-'));

  try {
    // Minimal rtws for mock provider
    await writeFileEnsuringDir(
      path.join(rtws, '.minds', 'llm.yaml'),
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
      path.join(rtws, '.minds', 'team.yaml'),
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
        '',
      ].join('\n'),
    );
    await writeFileEnsuringDir(
      path.join(rtws, 'mock-db', 'default.yaml'),
      [
        'responses:',
        '  - message: root-trigger',
        '    role: user',
        '    response: |',
        '      !!@add_reminder',
        '      reminder for root',
        '  - message: silent-trigger',
        '    role: user',
        '    response: ""',
        '  - message: |',
        ...DILIGENCE_ZH.split('\n').map((line) => `      ${line}`),
        '    role: user',
        '    response: continued',
        `  - message: ${JSON.stringify(DILIGENCE_GENERIC)}`,
        '    role: user',
        '    response: generic-continued',
        '  - message: sub-trigger',
        '    role: user',
        '    response: |',
        '      !!@add_reminder',
        '      reminder for subdialog',
        '  - message: disabled-trigger',
        '    role: user',
        '    response: |',
        '      !!@add_reminder',
        '      reminder for disabled',
        '',
      ].join('\n'),
    );

    process.chdir(rtws);
    setWorkLanguage('zh');

    // 1) Root dialog: missing diligence file -> fallback triggers auto-continue.
    {
      const rootId = new DialogID('root-keep-going');
      const rootStore = new DiskFileDialogStore(rootId);
      const root = DialogFactory.createRootDialog(rootStore, 'test.tsk/', 'tester', rootId);

      await driveDialogStream(root, { content: 'root-trigger', msgId: 'm1', grammar: 'markdown' });

      const diligenceInjected = root.msgs.some(
        (m) =>
          m.type === 'environment_msg' && m.role === 'user' && m.content.trim() === DILIGENCE_ZH,
      );
      assert.equal(diligenceInjected, true, 'expected diligence auto-prompt for root dialog');
      assert.equal(
        lastAssistantSayingContent(root),
        'continued',
        'expected root dialog to continue after diligence prompt',
      );
    }

    // 1b) Root dialog: empty model output (no tool calls / no visible text) -> still auto-continues.
    {
      const rootId = new DialogID('root-empty-output');
      const rootStore = new DiskFileDialogStore(rootId);
      const root = DialogFactory.createRootDialog(rootStore, 'test.tsk/', 'tester', rootId);

      await driveDialogStream(root, {
        content: 'silent-trigger',
        msgId: 'm1b',
        grammar: 'markdown',
      });

      const diligenceInjected = root.msgs.some(
        (m) =>
          m.type === 'environment_msg' && m.role === 'user' && m.content.trim() === DILIGENCE_ZH,
      );
      assert.equal(diligenceInjected, true, 'expected diligence auto-prompt for empty output');
      assert.equal(
        lastAssistantSayingContent(root),
        'continued',
        'expected root dialog to continue after diligence prompt (empty output case)',
      );
    }

    // 2) Subdialog: auto-continue must NOT apply.
    {
      const rootId = new DialogID('root-for-subdialog');
      const rootStore = new DiskFileDialogStore(rootId);
      const root = DialogFactory.createRootDialog(rootStore, 'test.tsk/', 'tester', rootId);

      const sub = await root.createSubDialog('tester', '@tester', '', {
        originMemberId: 'tester',
        callerDialogId: root.id.selfId,
        callId: 'call-sub',
      });

      await driveDialogStream(sub, { content: 'sub-trigger', msgId: 'm2', grammar: 'markdown' });

      const diligenceInjected = sub.msgs.some(
        (m) =>
          m.type === 'environment_msg' && m.role === 'user' && m.content.trim() === DILIGENCE_ZH,
      );
      assert.equal(diligenceInjected, false, 'expected no diligence auto-prompt for subdialogs');
    }

    // 2b) Root dialog: supports `.minds/diligence.md` (no lang id).
    {
      await writeFileEnsuringDir(path.join(rtws, '.minds', 'diligence.md'), DILIGENCE_GENERIC);

      const rootId = new DialogID('root-generic-diligence');
      const rootStore = new DiskFileDialogStore(rootId);
      const root = DialogFactory.createRootDialog(rootStore, 'test.tsk/', 'tester', rootId);

      await driveDialogStream(root, {
        content: 'root-trigger',
        msgId: 'm2b',
        grammar: 'markdown',
      });

      const diligenceInjected = root.msgs.some(
        (m) =>
          m.type === 'environment_msg' &&
          m.role === 'user' &&
          m.content.trim() === DILIGENCE_GENERIC,
      );
      assert.equal(
        diligenceInjected,
        true,
        'expected generic diligence auto-prompt for root dialog',
      );
      assert.equal(
        lastAssistantSayingContent(root),
        'generic-continued',
        'expected root dialog to continue after generic diligence prompt',
      );
    }

    // 3) Root dialog: empty diligence file disables auto-continue.
    {
      await writeFileEnsuringDir(path.join(rtws, '.minds', 'diligence.zh.md'), '');

      const rootId = new DialogID('root-disabled');
      const rootStore = new DiskFileDialogStore(rootId);
      const root = DialogFactory.createRootDialog(rootStore, 'test.tsk/', 'tester', rootId);

      await driveDialogStream(root, {
        content: 'disabled-trigger',
        msgId: 'm3',
        grammar: 'markdown',
      });

      const diligenceInjected = root.msgs.some((m) => {
        if (!(m.type === 'environment_msg' && m.role === 'user')) return false;
        const trimmed = m.content.trim();
        return trimmed === DILIGENCE_ZH || trimmed === DILIGENCE_GENERIC;
      });
      assert.equal(
        diligenceInjected,
        false,
        'expected no diligence auto-prompt when rtws diligence file is empty',
      );
    }

    // Ensure latest write-back timers flush before changing cwd.
    await new Promise((resolve) => setTimeout(resolve, 600));

    console.log('✓ keep-going (diligence auto-continue) tests passed');
  } finally {
    process.chdir(originalCwd);
    try {
      await fs.rm(rtws, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
