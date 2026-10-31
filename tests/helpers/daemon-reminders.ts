import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import type { JsonObject, JsonValue, Reminder } from '../../main/tool';
import {
  parseCmdRunnerResponseLine,
  type CmdRunnerRequest,
  type CmdRunnerResponse,
} from '../../main/tools/cmd-runner-protocol';
import { shellCmdReminderOwner, shellCmdTool } from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import {
  createMainDialog,
  waitFor,
  withTempRtws,
  writeStandardMinds,
} from '../kernel-driver/helpers';

export function jsonObject(value: JsonValue | undefined): JsonObject {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
}

export function daemonMeta(reminder: Reminder) {
  const meta = jsonObject(reminder.meta);
  assert.equal(meta.kind, 'daemon');
  assert.ok(typeof meta.pid === 'number' && typeof meta.runnerPid === 'number');
  assert.ok(typeof meta.runnerEndpoint === 'string' && typeof meta.daemonCommandLine === 'string');
  assert.ok(typeof meta.initialCommandLine === 'string' && typeof meta.startTime === 'string');
  return {
    ...meta,
    pid: meta.pid,
    runnerPid: meta.runnerPid,
    runnerEndpoint: meta.runnerEndpoint,
    daemonCommandLine: meta.daemonCommandLine,
    initialCommandLine: meta.initialCommandLine,
    startTime: meta.startTime,
  };
}

export async function runnerRequest(endpoint: string, request: CmdRunnerRequest) {
  return await new Promise<CmdRunnerResponse>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (error?: unknown, response?: CmdRunnerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(
      () => finish(new Error('Owned runner did not answer within5 seconds')),
      5_000,
    );
    socket.setEncoding('utf8');
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('Owned runner closed before its response')));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        finish(undefined, parseCmdRunnerResponseLine(buffer.slice(0, end)));
      } catch (error) {
        finish(error);
      }
    });
  });
}

export async function runnerStatus(endpoint: string) {
  const response = await runnerRequest(endpoint, { type: 'get_status' });
  assert.ok(response.ok && response.type === 'status');
  return response;
}

export async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    }
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ESRCH' ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return false;
    throw error;
  }
}

export type DaemonHandle = Awaited<ReturnType<DaemonFixture['start']>>;
type Action = {
  stdout?: string;
  stderr?: string;
  repeat?: boolean;
  stopRepeat?: boolean;
  exitCode?: number;
};
let sequence = 0;
export class DaemonFixture {
  readonly caller = new Team.Member({ id: 'tester', name: 'Tester' });
  readonly handles: { meta: ReturnType<typeof daemonMeta> }[] = [];
  constructor(
    readonly rtws: string,
    readonly root: MainDialog,
  ) {}

  async rootFor(agentId = 'tester') {
    const dialog = await createMainDialog(agentId);
    await dialog.processReminderUpdates();
    return dialog;
  }

  async start() {
    const stem = `daemon-${++sequence}`;
    const script = stem + '.cjs';
    const commandFile = path.join(this.rtws, stem + '-command.json');
    const ackFile = path.join(this.rtws, stem + '-ack.json');
    await fs.writeFile(
      path.join(this.rtws, script),
      `
const fs = require('node:fs');
const command = ${JSON.stringify(commandFile)};
const ack = ${JSON.stringify(ackFile)};
let last = 0;
let producer;
function accept() {
  if (!fs.existsSync(command)) return;
  const data = JSON.parse(fs.readFileSync(command, 'utf8'));
  if (data.seq <= last) return;
  last = data.seq;
  if (data.stopRepeat) { clearInterval(producer); producer = undefined; }
  const emit = () => {
    if (data.stdout) process.stdout.write(data.stdout);
    if (data.stderr) process.stderr.write(data.stderr);
  };
  emit();
  if (data.repeat) producer = setInterval(emit, 10);
  fs.writeFileSync(ack + '.tmp', JSON.stringify({ seq: last, pid: process.pid }));
  fs.renameSync(ack + '.tmp', ack);
  if (data.exitCode !== undefined) process.exit(data.exitCode);
}
fs.watch(${JSON.stringify(this.rtws)}, (_event, file) => {
  if (file === ${JSON.stringify(path.basename(commandFile))}) accept();
});
fs.writeFileSync(ack, JSON.stringify({ seq: last, pid: process.pid }));
accept();
`,
    );
    const before = new Set((await this.root.listVisibleReminders()).map((row) => row.id));
    const receipt = await shellCmdTool.call(this.root, this.caller, {
      command: 'node ' + script,
      timeoutSeconds: 1,
    });
    assert.equal(receipt.outcome, 'success');
    const added = (await this.root.listVisibleReminders()).filter(
      (row) => row.owner?.name === shellCmdReminderOwner.name && !before.has(row.id),
    );
    assert.equal(added.length, 1);
    const reminder = added[0]!;
    const meta = daemonMeta(reminder);
    this.handles.push({ meta });
    const initialStatus = await runnerStatus(meta.runnerEndpoint);
    assert.equal(initialStatus.daemonPid, meta.pid);
    assert.equal(initialStatus.runnerPid, meta.runnerPid);
    assert.equal(initialStatus.isRunning, true);
    let commandSequence = 0;
    return {
      reminder,
      meta,
      receipt,
      sharedPath: path.join(
        this.rtws,
        '.dialogs',
        'reminders',
        'agents',
        this.root.agentId,
        reminder.id + '.json',
      ),
      status: () => runnerStatus(meta.runnerEndpoint),
      async send(action: Action) {
        const seq = ++commandSequence;
        await fs.writeFile(commandFile + '.tmp', JSON.stringify({ ...action, seq }));
        await fs.rename(commandFile + '.tmp', commandFile);
        await waitFor(
          async () => {
            const ack = JSON.parse(await fs.readFile(ackFile, 'utf8'));
            return ack.seq === seq;
          },
          3_000,
          'owned child to acknowledge the declared output/exit action',
        );
      },
      async waitOutput(stream: 'stdout' | 'stderr', payload: string) {
        await waitFor(
          async () => (await runnerStatus(meta.runnerEndpoint))[stream].content.includes(payload),
          3_000,
          'actual runner buffer to receive the given opaque child payload',
        );
      },
    };
  }

  async cleanup() {
    for (const { meta } of this.handles) {
      try {
        const status = await runnerStatus(meta.runnerEndpoint);
        assert.equal(status.daemonPid, meta.pid);
        assert.equal(status.runnerPid, meta.runnerPid);
        assert.equal(status.startTime, meta.startTime);
        const stopped = await runnerRequest(meta.runnerEndpoint, { type: 'stop', entirePg: true });
        assert.ok(stopped.ok);
        assert.equal(stopped.isRunning, false);
      } catch (error) {
        if (await processIsRunning(meta.pid)) throw error;
      }
      await waitFor(
        async () => !(await processIsRunning(meta.pid)),
        3_000,
        'owned daemon process to stop',
      );
    }
  }
}

export async function withDaemonFixture(
  language: LanguageCode,
  action: (fixture: DaemonFixture) => Promise<void>,
) {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { extraMembers: ['other-agent'] });
    setWorkLanguage(language);
    registerReminderOwner(shellCmdReminderOwner);
    const root = await createMainDialog();
    root.setLastUserLanguageCode(language);
    await root.processReminderUpdates();
    const fixture = new DaemonFixture(rtws, root);
    try {
      await action(fixture);
    } finally {
      try {
        await fixture.cleanup();
      } finally {
        unregisterReminderOwner(shellCmdReminderOwner.name);
      }
    }
  });
}

export async function currentDaemon(dialog: MainDialog, id: string) {
  const reminder = (await dialog.listVisibleReminders()).find((row) => row.id === id);
  assert.ok(reminder);
  assert.equal(reminder.owner?.name, shellCmdReminderOwner.name);
  return reminder;
}

export async function stopOwnedRunner(handle: DaemonHandle) {
  const stopped = await runnerRequest(handle.meta.runnerEndpoint, { type: 'stop', entirePg: true });
  assert.ok(stopped.ok && !stopped.isRunning);
  await waitFor(
    async () =>
      !(await processIsRunning(handle.meta.runnerPid)) &&
      !(await processIsRunning(handle.meta.pid)),
    3_000,
    'owned runner and daemon to exit',
  );
}
