import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

import { DialogID, RootDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/driver';
import { DiskFileDialogStore } from '../../main/persistence';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import {
  formatAssignmentFromSupdialog,
  formatTeammateResponseContent,
} from '../../main/shared/utils/inter-dialog-format';
import type {
  CollectedTellaskCall,
  TellaskCallValidation,
  TellaskEventsReceiver,
} from '../../main/tellask';
import { TellaskStreamParser } from '../../main/tellask';
import { generateDialogID } from '../../main/utils/id';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await sleep(10);
  }
}

function lastAssistantSaying(dlg: RootDialog): string | null {
  for (let i = dlg.msgs.length - 1; i >= 0; i--) {
    const msg = dlg.msgs[i];
    if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
      return typeof msg.content === 'string' ? msg.content : null;
    }
  }
  return null;
}

class NoopTellaskReceiver implements TellaskEventsReceiver {
  async markdownStart(): Promise<void> {}
  async markdownChunk(_chunk: string): Promise<void> {}
  async markdownFinish(): Promise<void> {}
  async callStart(_validation: TellaskCallValidation): Promise<void> {}
  async callHeadLineChunk(_chunk: string): Promise<void> {}
  async callHeadLineFinish(): Promise<void> {}
  async tellaskBodyStart(): Promise<void> {}
  async tellaskBodyChunk(_chunk: string): Promise<void> {}
  async tellaskBodyFinish(): Promise<void> {}
  async callFinish(_call: CollectedTellaskCall, _upstreamEndOffset: number): Promise<void> {}
}

async function parseSingleTellaskCall(text: string): Promise<CollectedTellaskCall> {
  const parser = new TellaskStreamParser(new NoopTellaskReceiver());
  await parser.takeUpstreamChunk(text);
  await parser.finalize();
  const calls = parser.getCollectedCalls();
  assert.equal(calls.length, 1, `expected exactly 1 tellask call, got ${calls.length}`);
  return calls[0]!;
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-auto-revive-root-'));

  try {
    process.chdir(tmpRoot);

    await fs.mkdir(path.join(tmpRoot, '.minds'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'mock-db'), { recursive: true });

    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
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
      'utf-8',
    );

    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'team.yaml'),
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
        '  pangu:',
        '    name: Pangu',
        '    provider: local-mock',
        '    model: default',
        '',
      ].join('\n'),
      'utf-8',
    );

    const language = getWorkLanguage();
    const trigger = 'Trigger root subdialog then auto-revive.';

    const rootFirstResponse = [
      'Start.',
      '!?@pangu Please compute 1+1.',
      '!?Return only the number.',
      'separator',
    ].join('\n');

    const parsed = await parseSingleTellaskCall(rootFirstResponse);
    const tellaskHead = parsed.tellaskHead;
    const tellaskBody = parsed.body;

    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      tellaskHead,
      tellaskBody,
      language,
      collectiveTargets: ['pangu'],
    });

    const subdialogResponseText = '2';
    const expectedInjected = formatTeammateResponseContent({
      responderId: 'pangu',
      requesterId: 'tester',
      originalCallHeadLine: tellaskHead,
      responseBody: subdialogResponseText,
      language,
    });

    const rootResumeResponse = 'Ack: got subdialog response.';

    await fs.writeFile(
      path.join(tmpRoot, 'mock-db', 'default.yaml'),
      yaml.stringify({
        responses: [
          {
            role: 'user',
            message: trigger,
            response: rootFirstResponse,
          },
          {
            role: 'user',
            message: expectedSubdialogPrompt,
            response: subdialogResponseText,
          },
          {
            role: 'user',
            message: expectedInjected,
            response: rootResumeResponse,
          },
        ],
      }),
      'utf-8',
    );

    const rootId = generateDialogID();
    const rootDialogId = new DialogID(rootId);
    const store = new DiskFileDialogStore(rootDialogId);
    const dlg = new RootDialog(store, 'task.md', rootDialogId, 'tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'auto-revive-test', grammar: 'markdown' },
      true,
    );

    await waitFor(
      async () => {
        return lastAssistantSaying(dlg) === rootResumeResponse;
      },
      2_000,
      'root dialog to generate after subdialog response',
    );

    // Ensure the resumed generation actually sees the injected subdialog response in context:
    // The mock requires exact last user message matching, so reaching rootResumeResponse implies injection happened.
    const msgs: ChatMessage[] = dlg.msgs;
    assert.ok(msgs.length > 0, 'expected dialog to have messages after auto-revive');

    await waitFor(
      async () => {
        return !dlg.getAllDialogs().some((d) => d.isLocked());
      },
      2_000,
      'all background dialog drives to finish',
    );

    console.log('tellask auto-revive root on subdialog response: PASS');
  } finally {
    process.chdir(oldCwd);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tellask auto-revive root on subdialog response: FAIL\n${message}`);
  process.exit(1);
});
