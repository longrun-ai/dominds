import assert from 'node:assert/strict';
import * as path from 'node:path';

import { extractGlobalRtwsChdir } from '../../main/bootstrap/rtws-cli';

function main(): void {
  const absWs = path.join(path.sep, 'abs', 'ws');
  const absFirst = path.join(path.sep, 'abs', 'first');
  const absSecond = path.join(path.sep, 'abs', 'second');

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['webui', '-C', absWs, '--nobrowser'],
    });
    assert.equal(parsed.chdir, absWs);
    assert.deepEqual(parsed.argv, ['webui', '--nobrowser']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['-C', '/abs/ws', 'tui', 'task.tsk'],
    });
    assert.equal(parsed.chdir, '/abs/ws');
    assert.deepEqual(parsed.argv, ['tui', 'task.tsk']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['read', '--cwd=/foo', 'dev'],
    });
    assert.equal(parsed.chdir, '/foo');
    assert.deepEqual(parsed.argv, ['read', 'dev']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['tui', '--', '-C', 'not-an-option'],
    });
    assert.equal(parsed.chdir, undefined);
    assert.deepEqual(parsed.argv, ['tui', '--', '-C', 'not-an-option']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['-C', absFirst, 'webui', '-C', absSecond],
    });
    assert.equal(parsed.chdir, absSecond);
    assert.deepEqual(parsed.argv, ['webui']);
  }

  assert.throws(
    () =>
      extractGlobalRtwsChdir({
        argv: ['webui', '-C', './ws'],
      }),
    /-C requires an absolute directory path: \.\/ws/,
  );

  assert.throws(
    () =>
      extractGlobalRtwsChdir({
        argv: ['read', '--cwd=relative/ws'],
      }),
    /--cwd requires an absolute directory path: relative\/ws/,
  );
}

main();
