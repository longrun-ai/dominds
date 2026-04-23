import assert from 'node:assert/strict';

import type { Dialog } from '../../main/dialog';
import { Team } from '../../main/team';
import { envGetTool, envSetTool, envUnsetTool } from '../../main/tools/env';

const ENV_KEY = 'CHATGPT_WORKSTATION_BEARER_TOKEN';

async function main(): Promise<void> {
  const previous = process.env[ENV_KEY];
  const dlg = {} as Dialog;
  const caller = new Team.Member({ id: 'tester', name: 'Tester' });

  assert.deepEqual(Object.keys(envGetTool.parameters.properties ?? {}), ['key']);

  try {
    process.env[ENV_KEY] = 'old-token-value';

    const getResult = await envGetTool.call(dlg, caller, { key: ENV_KEY });
    assert.equal(getResult.content, 'old-token-value');

    const setResult = await envSetTool.call(dlg, caller, {
      key: ENV_KEY,
      value: 'new-token-value',
    });
    assert.equal(process.env[ENV_KEY], 'new-token-value');
    assert.equal(setResult.content, `ok: ${ENV_KEY}\nprev: old-token-value\nnext: new-token-value`);

    const unsetResult = await envUnsetTool.call(dlg, caller, { key: ENV_KEY });
    assert.equal(process.env[ENV_KEY], undefined);
    assert.equal(unsetResult.content, `ok: ${ENV_KEY}\nprev: new-token-value\nnext: (unset)`);
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }

  console.log('env tools unrestricted key access: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`env tools unrestricted key access: FAIL\n${message}`);
  process.exit(1);
});
