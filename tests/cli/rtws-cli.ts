import assert from 'node:assert/strict';
import * as path from 'node:path';

import { extractGlobalRtwsChdir } from '../../main/shared/rtws-cli';

function main(): void {
  const baseCwd = path.join(path.sep, 'base', 'cwd');

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['webui', '-C', './ws', '--nobrowser'],
      baseCwd,
    });
    assert.equal(parsed.chdir, path.resolve(baseCwd, './ws'));
    assert.deepEqual(parsed.argv, ['webui', '--nobrowser']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['-C', '/abs/ws', 'tui', 'task.md'],
      baseCwd,
    });
    assert.equal(parsed.chdir, '/abs/ws');
    assert.deepEqual(parsed.argv, ['tui', 'task.md']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['read', '--cwd=/foo', 'dev'],
      baseCwd,
    });
    assert.equal(parsed.chdir, '/foo');
    assert.deepEqual(parsed.argv, ['read', 'dev']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['tui', '--', '-C', 'not-an-option'],
      baseCwd,
    });
    assert.equal(parsed.chdir, undefined);
    assert.deepEqual(parsed.argv, ['tui', '--', '-C', 'not-an-option']);
  }

  {
    const parsed = extractGlobalRtwsChdir({
      argv: ['-C', './first', 'webui', '-C', './second'],
      baseCwd,
    });
    assert.equal(parsed.chdir, path.resolve(baseCwd, './second'));
    assert.deepEqual(parsed.argv, ['webui']);
  }
}

main();
