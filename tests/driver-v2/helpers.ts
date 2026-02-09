import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';

import { DialogID, RootDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';
import { formatUnifiedTimestamp } from '../../main/shared/utils/time';
import type {
  CollectedTellaskCall,
  TellaskCallValidation,
  TellaskEventsReceiver,
} from '../../main/tellask';
import { TellaskStreamParser } from '../../main/tellask';
import '../../main/tools/builtins';
import { generateDialogID } from '../../main/utils/id';

export type MockEntry = {
  message: string;
  role: 'user' | 'tool' | 'assistant';
  response: string;
  delayMs?: number;
  chunkDelayMs?: number;
  streamError?: string;
  funcCalls?: ReadonlyArray<{
    id?: string;
    name: string;
    arguments?: unknown;
  }>;
  contextContains?: ReadonlyArray<string>;
};

export async function withTempRtws(fn: (tmpRoot: string) => Promise<void>): Promise<void> {
  if (process.env.DOMINDS_TEST_RTWS_MANAGED !== '1') {
    throw new Error(
      'driver-v2 tests must run via tests/cli.ts so rtws is fixed at process startup cwd',
    );
  }
  const tmpRoot = process.cwd();
  await fn(tmpRoot);
}

export async function writeStandardMinds(
  tmpRoot: string,
  options?: {
    includePangu?: boolean;
    memberToolsets?: ReadonlyArray<string>;
    memberTools?: ReadonlyArray<string>;
  },
): Promise<void> {
  const includePangu = options?.includePangu === true;
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

  const teamLines = [
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
  ];
  if (options?.memberToolsets && options.memberToolsets.length > 0) {
    const quoted = options.memberToolsets.map((v) => JSON.stringify(v)).join(', ');
    teamLines.push(`    toolsets: [${quoted}]`);
  }
  if (options?.memberTools && options.memberTools.length > 0) {
    const quoted = options.memberTools.map((v) => JSON.stringify(v)).join(', ');
    teamLines.push(`    tools: [${quoted}]`);
  }
  if (includePangu) {
    teamLines.push('  pangu:', '    name: Pangu', '    provider: local-mock', '    model: default');
  }
  teamLines.push('');
  await fs.writeFile(path.join(tmpRoot, '.minds', 'team.yaml'), teamLines.join('\n'), 'utf-8');
}

export async function writeMockDb(tmpRoot: string, entries: MockEntry[]): Promise<void> {
  await fs.writeFile(
    path.join(tmpRoot, 'mock-db', 'default.yaml'),
    yaml.stringify({ responses: entries }),
    'utf-8',
  );
}

export function createRootDialog(agentId: string = 'tester'): RootDialog {
  const rootId = generateDialogID();
  const dialogId = new DialogID(rootId);
  const store = new DiskFileDialogStore(dialogId);
  return new RootDialog(store, 'task.md', dialogId, agentId);
}

export async function persistRootDialogMetadata(rootDialog: RootDialog): Promise<void> {
  await DialogPersistence.saveDialogMetadata(rootDialog.id, {
    id: rootDialog.id.selfId,
    agentId: rootDialog.agentId,
    taskDocPath: rootDialog.taskDocPath,
    createdAt: formatUnifiedTimestamp(new Date()),
  });
}

export function lastAssistantSaying(dlg: RootDialog): string | null {
  for (let i = dlg.msgs.length - 1; i >= 0; i--) {
    const msg = dlg.msgs[i];
    if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
      return typeof msg.content === 'string' ? msg.content : null;
    }
  }
  return null;
}

export async function waitFor(
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function waitForAllDialogsUnlocked(
  root: RootDialog,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => !root.getAllDialogs().some((d) => d.isLocked()),
    timeoutMs,
    'all background dialog drives to finish',
  );
}

export function listTellaskResultContents(msgs: ChatMessage[]): string[] {
  return msgs
    .filter((msg): msg is Extract<ChatMessage, { type: 'tellask_result_msg' }> => {
      return msg.type === 'tellask_result_msg';
    })
    .map((msg) => msg.content);
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

export async function parseSingleTellaskCall(text: string): Promise<CollectedTellaskCall> {
  const parser = new TellaskStreamParser(new NoopTellaskReceiver());
  await parser.takeUpstreamChunk(text);
  await parser.finalize();
  const calls = parser.getCollectedCalls();
  assert.equal(calls.length, 1, `expected exactly 1 tellask call, got ${calls.length}`);
  return calls[0]!;
}
