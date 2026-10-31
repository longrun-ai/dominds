import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { withTempRtws } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (root) => {
    const pids: number[] = [];
    for (const phase of ['seed', 'recover', 'verify']) {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          require.resolve('tsx/cli'),
          '--tsconfig',
          path.resolve(__dirname, '../tsconfig.json'),
          path.resolve(__dirname, '../rtws-script-runner.ts'),
          path.resolve(__dirname, '../helpers/reply-recovery-worker.ts'),
          phase,
          ...(process.argv.includes('--semantic') ? ['--semantic'] : []),
        ],
        { cwd: root, env: process.env, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      );
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      const packets = stdout.split('\n').flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            'probe' in value &&
            value.probe === 'reply-recovery-phase'
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
      assert.equal(packets.length, 1);
      const packet = packets[0];
      assert.ok(packet && 'phase' in packet && 'pid' in packet && 'scenarios' in packet);
      assert.equal(packet.phase, phase);
      assert.equal(packet.scenarios, 5);
      assert.ok(typeof packet.pid === 'number');
      assert.notEqual(packet.pid, process.pid);
      assert.equal(pids.includes(packet.pid), false);
      pids.push(packet.pid);
      if (phase === 'recover') {
        assert.ok('requests' in packet);
        assert.equal(packet.requests, 9);
      }
    }
    assert.equal(pids.length, 3);
  });
  console.log('reply recovery across independent writer/recovery/verifier processes: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
