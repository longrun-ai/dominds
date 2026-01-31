import assert from 'node:assert/strict';
import type { ApiRootDialogResponse } from '../../webapp/src/shared/types';
import { bumpDialogsLastModified } from '../../webapp/src/utils/dialog-last-modified';

function makeBaseDialog(overrides: Partial<ApiRootDialogResponse>): ApiRootDialogResponse {
  return {
    rootId: 'r1',
    agentId: 'agent',
    taskDocPath: 'tasks/demo.tsk',
    status: 'running',
    currentCourse: 1,
    createdAt: 't0',
    lastModified: 't0',
    ...overrides,
  };
}

(() => {
  const dialogs: ApiRootDialogResponse[] = [
    makeBaseDialog({ rootId: 'r1', lastModified: 't0' }), // root row (selfId undefined)
    makeBaseDialog({ rootId: 'r1', selfId: 's1', agentId: 'a1', lastModified: 't0' }),
    makeBaseDialog({ rootId: 'r1', selfId: 's2', agentId: 'a2', lastModified: 't0' }),
  ];

  const res = bumpDialogsLastModified(dialogs, { rootId: 'r1', selfId: 's1' }, 't1');
  assert.equal(res.changed, true);
  assert.equal(res.dialogs[0].lastModified, 't1', 'root row should bump for subdialog activity');
  assert.equal(res.dialogs[1].lastModified, 't1', 'target subdialog should bump');
  assert.equal(res.dialogs[2].lastModified, 't0', 'sibling subdialog should not bump');
})();

(() => {
  const dialogs: ApiRootDialogResponse[] = [
    makeBaseDialog({ rootId: 'r1', lastModified: 't0' }), // root row (selfId undefined)
    makeBaseDialog({ rootId: 'r1', selfId: 's1', agentId: 'a1', lastModified: 't0' }),
  ];

  const res = bumpDialogsLastModified(dialogs, { rootId: 'r1', selfId: 'r1' }, 't1');
  assert.equal(res.changed, true);
  assert.equal(res.dialogs[0].lastModified, 't1', 'root row should bump for root activity');
  assert.equal(res.dialogs[1].lastModified, 't0', 'subdialogs should not bump for root activity');
})();

(() => {
  const dialogs: ApiRootDialogResponse[] = [
    makeBaseDialog({ rootId: 'r1', lastModified: 't0' }),
    makeBaseDialog({ rootId: 'r2', agentId: 'b', lastModified: 't0' }),
  ];

  const res = bumpDialogsLastModified(dialogs, { rootId: 'r2', selfId: 'r2' }, 't1');
  assert.equal(res.changed, true);
  assert.equal(res.dialogs[0].lastModified, 't0', 'other roots should not bump');
  assert.equal(res.dialogs[1].lastModified, 't1', 'target root should bump');
})();
