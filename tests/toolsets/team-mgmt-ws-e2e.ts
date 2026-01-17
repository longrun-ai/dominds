import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

import type {
  DialogIdent,
  DialogReadyMessage,
  WebSocketMessage,
} from '../../main/shared/types/wire';

type ToolCallResponseEvt = {
  type: 'tool_call_response_evt';
  headLine: string;
  status: 'completed' | 'failed';
  result: string;
  responderId: string;
  callId: string;
  round: number;
  calling_genseq?: number;
};

function isToolCallResponseEvt(msg: unknown): msg is ToolCallResponseEvt {
  if (typeof msg !== 'object' || msg === null) return false;
  const v = msg as Record<string, unknown>;
  if (v.type !== 'tool_call_response_evt') return false;
  if (typeof v.headLine !== 'string') return false;
  if (v.status !== 'completed' && v.status !== 'failed') return false;
  if (typeof v.result !== 'string') return false;
  if (typeof v.responderId !== 'string') return false;
  if (typeof v.callId !== 'string') return false;
  if (typeof v.round !== 'number') return false;
  return true;
}

function isDialogReadyMessage(msg: unknown): msg is DialogReadyMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const v = msg as Record<string, unknown>;
  if (v.type !== 'dialog_ready') return false;
  const dialog = v.dialog;
  if (typeof dialog !== 'object' || dialog === null) return false;
  const d = dialog as Record<string, unknown>;
  if (typeof d.selfId !== 'string') return false;
  if (typeof d.rootId !== 'string') return false;
  if (typeof v.agentId !== 'string') return false;
  if (typeof v.taskDocPath !== 'string') return false;
  return true;
}

type WsQueue = {
  waitForMessage(timeoutMs: number): Promise<WebSocketMessage>;
};

function makeWsQueue(ws: WebSocket): WsQueue {
  const queue: WebSocketMessage[] = [];
  const waiters: Array<{
    resolve: (msg: WebSocketMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const onMessage = (data: Buffer) => {
    try {
      const parsed: unknown = JSON.parse(data.toString('utf-8'));
      const msg = parsed as WebSocketMessage;
      const w = waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
      queue.push(msg);
    } catch (err: unknown) {
      // Ignore malformed frames for this test (treat as infra issue if it shows up as tool errors).
      void err;
    }
  };

  ws.on('message', onMessage);
  ws.on('error', (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    for (const w of waiters.splice(0, waiters.length)) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  });

  return {
    waitForMessage(timeoutMs: number): Promise<WebSocketMessage> {
      const immediate = queue.shift();
      if (immediate) return Promise.resolve(immediate);

      return new Promise((resolve, reject) => {
        const waiter: {
          resolve: (msg: WebSocketMessage) => void;
          reject: (err: Error) => void;
          timer: NodeJS.Timeout;
        } = {
          resolve,
          reject: (e: Error) => reject(e),
          timer: setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error(`Timed out waiting for ws message (${timeoutMs}ms)`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function waitForToolResponse(
  q: WsQueue,
  predicate: (evt: ToolCallResponseEvt) => boolean,
  timeoutMs: number,
): Promise<ToolCallResponseEvt> {
  const started = Date.now();
  // Drain until we find the expected tool response.
  while (Date.now() - started < timeoutMs) {
    const msg = await q.waitForMessage(timeoutMs);
    if (isToolCallResponseEvt(msg) && predicate(msg)) return msg;
  }
  throw new Error(`Timed out waiting for tool_call_response_evt (${timeoutMs}ms)`);
}

async function createDialog(
  ws: WebSocket,
  q: WsQueue,
  agentId: string,
  taskDocPath: string,
): Promise<DialogIdent> {
  ws.send(JSON.stringify({ type: 'create_dialog', agentId, taskDocPath }));
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const msg = await q.waitForMessage(20_000);
    if (isDialogReadyMessage(msg)) {
      return msg.dialog;
    }
    if (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'error') {
      const m = msg as { message?: unknown };
      throw new Error(
        `create_dialog failed: ${typeof m.message === 'string' ? m.message : 'unknown error'}`,
      );
    }
  }
  throw new Error('Timed out waiting for dialog_ready');
}

async function driveUserMsg(
  ws: WebSocket,
  dialog: DialogIdent,
  content: string,
  msgId: string,
  userLanguageCode: 'en' | 'zh',
): Promise<void> {
  ws.send(
    JSON.stringify({
      type: 'drive_dlg_by_user_msg',
      dialog,
      content,
      msgId,
      userLanguageCode,
    }),
  );
}

async function run(): Promise<void> {
  const ws = new WebSocket('ws://127.0.0.1:5556/ws');
  const q = makeWsQueue(ws);
  const rtwsRoot = path.resolve(__dirname, '..', '..', '..');
  const e2eFile = path.join(rtwsRoot, '.minds', 'team-mgmt-ws-e2e.txt');

  // Welcome
  {
    const welcome = await q.waitForMessage(10_000);
    assert.equal(welcome.type, 'welcome');
  }

  // Dialog A: @fuxi (team-mgmt toolset)
  const dlgFuxi = await createDialog(ws, q, 'fuxi', 'tasks/ux-team-mgmt.tsk');

  // Overwrite file under .minds/
  await driveUserMsg(
    ws,
    dlgFuxi,
    '@team_mgmt_overwrite_file team-mgmt-ws-e2e.txt\nhello-1\n',
    'm1',
    'en',
  );
  {
    const r = await waitForToolResponse(
      q,
      (evt) => evt.headLine.startsWith('@team_mgmt_overwrite_file'),
      30_000,
    );
    assert.equal(r.status, 'completed');
  }
  if (!fs.existsSync(e2eFile)) {
    throw new Error(`Expected file to exist after overwrite: ${e2eFile}`);
  }

  // Read back
  await driveUserMsg(ws, dlgFuxi, '@team_mgmt_read_file team-mgmt-ws-e2e.txt', 'm2', 'en');
  {
    const r = await waitForToolResponse(
      q,
      (evt) => evt.headLine.startsWith('@team_mgmt_read_file'),
      30_000,
    );
    assert.equal(r.status, 'completed');
    assert.ok(r.result.includes('hello-1'));
  }

  // Patch to hello-2
  await driveUserMsg(
    ws,
    dlgFuxi,
    '@team_mgmt_patch_file team-mgmt-ws-e2e.txt\n```diff\n@@ -1,1 +1,1 @@\n-hello-1\n+hello-2\n```\n',
    'm3',
    'en',
  );
  {
    const r = await waitForToolResponse(
      q,
      (evt) => evt.headLine.startsWith('@team_mgmt_patch_file'),
      30_000,
    );
    if (r.status !== 'completed') {
      console.error('team_mgmt_patch_file failed:', r.result);
    }
    assert.equal(r.status, 'completed');
  }

  // Confirm hello-2
  await driveUserMsg(ws, dlgFuxi, '@team_mgmt_read_file team-mgmt-ws-e2e.txt', 'm4', 'en');
  {
    const r = await waitForToolResponse(
      q,
      (evt) => evt.headLine.startsWith('@team_mgmt_read_file'),
      30_000,
    );
    assert.equal(r.status, 'completed');
    assert.ok(r.result.includes('hello-2'));
  }

  // Negative scope: outside .minds/** must fail
  await driveUserMsg(ws, dlgFuxi, '@team_mgmt_read_file ../package.json', 'm5', 'en');
  {
    const r = await waitForToolResponse(
      q,
      (evt) => evt.headLine.startsWith('@team_mgmt_read_file') && evt.status === 'failed',
      30_000,
    );
    assert.equal(r.status, 'failed');
    const lowered = r.result.toLowerCase();
    assert.ok(
      lowered.includes('.minds') && (lowered.includes('within') || lowered.includes('must be')),
    );
  }

  // Cleanup file
  await driveUserMsg(ws, dlgFuxi, '@team_mgmt_rm_file team-mgmt-ws-e2e.txt', 'm6', 'en');
  {
    const r = await waitForToolResponse(
      q,
      (evt) => evt.headLine.startsWith('@team_mgmt_rm_file'),
      30_000,
    );
    assert.equal(r.status, 'completed');
  }

  // Dialog B: @pangu (ws tools but denied .minds/**)
  const dlgPangu = await createDialog(ws, q, 'pangu', 'tasks/ux-team-mgmt.tsk');
  await driveUserMsg(ws, dlgPangu, '@read_file .minds/mcp.yaml', 'm7', 'en');
  {
    const r = await waitForToolResponse(q, (evt) => evt.headLine.startsWith('@read_file'), 30_000);
    assert.equal(r.status, 'failed');
    assert.ok(r.result.includes('Access Denied') || r.result.includes('❌'));
  }

  await driveUserMsg(ws, dlgPangu, '@list_dir .minds', 'm8', 'en');
  {
    const r = await waitForToolResponse(q, (evt) => evt.headLine.startsWith('@list_dir'), 30_000);
    assert.equal(r.status, 'failed');
    assert.ok(r.result.includes('Access Denied') || r.result.includes('❌'));
  }

  ws.close();
  console.log('team-mgmt ws e2e: ok');
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
