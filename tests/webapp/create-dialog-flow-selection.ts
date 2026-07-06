import assert from 'node:assert/strict';

import {
  resolveCreateDialogAgentSelection,
  resolveCreateDialogPresetAgentTarget,
} from '../../webapp/src/components/create-dialog-flow';

const visibleMembers = [{ id: 'fuxi' }, { id: 'nwa' }] as const;
const shadowMembers = [{ id: 'shadow-coder' }, { id: 'shadow-reviewer' }] as const;

assert.deepEqual(
  resolveCreateDialogAgentSelection({
    visibleMembers,
    shadowMembers,
    defaultResponder: 'fuxi',
    presetAgentId: 'nwa',
  }),
  {
    initialPickShadow: false,
    selectedVisibleAgentId: 'nwa',
    selectedShadowAgentId: 'shadow-coder',
  },
  'visible preset should select the visible teammate and keep shadow members collapsed',
);

assert.deepEqual(
  resolveCreateDialogAgentSelection({
    visibleMembers,
    shadowMembers,
    defaultResponder: 'fuxi',
    presetAgentId: 'shadow-reviewer',
  }),
  {
    initialPickShadow: true,
    selectedVisibleAgentId: null,
    selectedShadowAgentId: 'shadow-reviewer',
  },
  'shadow preset should select the shadow sentinel and the matching shadow teammate',
);

assert.deepEqual(
  resolveCreateDialogAgentSelection({
    visibleMembers,
    shadowMembers,
    defaultResponder: 'shadow-coder',
  }),
  {
    initialPickShadow: true,
    selectedVisibleAgentId: null,
    selectedShadowAgentId: 'shadow-coder',
  },
  'shadow default responder should select the shadow sentinel and teammate',
);

assert.deepEqual(
  resolveCreateDialogAgentSelection({
    visibleMembers,
    shadowMembers,
    defaultResponder: 'fuxi',
    presetAgentId: 'missing',
  }),
  {
    initialPickShadow: false,
    selectedVisibleAgentId: 'fuxi',
    selectedShadowAgentId: 'shadow-coder',
  },
  'unknown preset should fall back to the configured default responder',
);

assert.deepEqual(
  resolveCreateDialogAgentSelection({
    visibleMembers: [],
    shadowMembers,
    defaultResponder: null,
  }),
  {
    initialPickShadow: true,
    selectedVisibleAgentId: null,
    selectedShadowAgentId: 'shadow-coder',
  },
  'shadow-only teams should open on the shadow selector and first shadow teammate',
);

assert.deepEqual(
  resolveCreateDialogAgentSelection({
    visibleMembers,
    shadowMembers,
    defaultResponder: null,
    presetAgentId: 'missing',
  }),
  {
    initialPickShadow: false,
    selectedVisibleAgentId: 'fuxi',
    selectedShadowAgentId: 'shadow-coder',
  },
  'visible teams with no valid responder should explicitly select the first visible teammate',
);

assert.deepEqual(
  resolveCreateDialogPresetAgentTarget({
    visibleAgentIds: ['fuxi', 'nwa'],
    shadowAgentIds: ['shadow-coder'],
    presetAgentId: 'nwa',
  }),
  { kind: 'visible', agentId: 'nwa' },
  'preset target should resolve visible members for already-open modals',
);

assert.deepEqual(
  resolveCreateDialogPresetAgentTarget({
    visibleAgentIds: ['fuxi', 'nwa'],
    shadowAgentIds: ['shadow-coder'],
    presetAgentId: ' shadow-coder ',
  }),
  { kind: 'shadow', agentId: 'shadow-coder' },
  'preset target should trim and resolve shadow members for already-open modals',
);

assert.deepEqual(
  resolveCreateDialogPresetAgentTarget({
    visibleAgentIds: ['fuxi', 'nwa'],
    shadowAgentIds: ['shadow-coder'],
    presetAgentId: 'missing',
  }),
  { kind: 'none' },
  'preset target should ignore unknown members for already-open modals',
);

console.log('webapp create dialog flow selection: PASS');
