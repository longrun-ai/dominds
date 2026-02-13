/**
 * Module: tools/builtins
 *
 * Registers built-in tools, toolsets, and reminder owners.
 *
 * Entry points (server/cli) must import this module once to populate registries.
 */
import { applyPatchTool } from './apply-patch';
import {
  addReminderTool,
  changeMindTool,
  clearMindTool,
  deleteReminderTool,
  recallTaskdocTool,
  updateReminderTool,
} from './ctrl';
import { envGetTool, envSetTool, envUnsetTool } from './env';
import { listDirTool, mkDirTool, moveDirTool, moveFileTool, rmDirTool, rmFileTool } from './fs';
import { buildStandardManualSpec } from './manual/spec';
import { mcpLeaseReminderOwner, mcpReleaseTool, mcpRestartTool } from './mcp';
import {
  addMemoryTool,
  addSharedMemoryTool,
  clearMemoryTool,
  clearSharedMemoryTool,
  dropMemoryTool,
  dropSharedMemoryTool,
  replaceMemoryTool,
  replaceSharedMemoryTool,
} from './mem';
import {
  getDaemonOutputTool,
  readonlyShellTool,
  shellCmdReminderOwner,
  shellCmdTool,
  stopDaemonTool,
} from './os';
import { pendingTellaskReminderOwner } from './pending-tellask-reminder';
import { updatePlanTool } from './plan';
import { registerReminderOwner, registerTool, registerToolset, setToolsetMeta } from './registry';
import {
  ripgrepCountTool,
  ripgrepFilesTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
  ripgrepSnippetsTool,
} from './ripgrep';
import { teamMgmtTools } from './team_mgmt';
import {
  applyFileModificationTool,
  createNewFileTool,
  overwriteEntireFileTool,
  prepareFileAppendTool,
  prepareFileBlockReplaceTool,
  prepareFileInsertAfterTool,
  prepareFileInsertBeforeTool,
  prepareFileRangeEditTool,
  readFileTool,
} from './txt';

function promptFilesFor(toolsetId: string): { en: string; zh: string } {
  return {
    en: `./prompts/${toolsetId}/en/index.md`,
    zh: `./prompts/${toolsetId}/zh/index.md`,
  };
}

function manualSpecFor(toolsetId: string) {
  return buildStandardManualSpec({ baseDir: `./prompts/${toolsetId}` });
}

registerTool(listDirTool);
registerTool(rmDirTool);
registerTool(rmFileTool);
registerTool(mkDirTool);
registerTool(moveFileTool);
registerTool(moveDirTool);
registerTool(readFileTool);
registerTool(createNewFileTool);
registerTool(overwriteEntireFileTool);
registerTool(prepareFileRangeEditTool);
registerTool(applyFileModificationTool);
registerTool(prepareFileAppendTool);
registerTool(prepareFileInsertAfterTool);
registerTool(prepareFileInsertBeforeTool);
registerTool(prepareFileBlockReplaceTool);

// Ripgrep tools
registerTool(ripgrepFilesTool);
registerTool(ripgrepSnippetsTool);
registerTool(ripgrepCountTool);
registerTool(ripgrepFixedTool);
registerTool(ripgrepSearchTool);

// OS tools
registerTool(shellCmdTool);
registerTool(readonlyShellTool);
registerTool(stopDaemonTool);
registerTool(getDaemonOutputTool);

// Codex-style compatibility tools
registerTool(applyPatchTool);
registerTool(updatePlanTool);

// Env tools (local testing)
registerTool(envGetTool);
registerTool(envSetTool);
registerTool(envUnsetTool);

// MCP tools (local testing/ops)
registerTool(mcpRestartTool);
registerTool(mcpReleaseTool);

// Memory tools
registerTool(addMemoryTool);
registerTool(dropMemoryTool);
registerTool(replaceMemoryTool);
registerTool(clearMemoryTool);
registerTool(addSharedMemoryTool);
registerTool(dropSharedMemoryTool);
registerTool(replaceSharedMemoryTool);
registerTool(clearSharedMemoryTool);

// Control tools
registerTool(addReminderTool);
registerTool(deleteReminderTool);
registerTool(updateReminderTool);
registerTool(clearMindTool);
registerTool(changeMindTool);
registerTool(recallTaskdocTool);

// Team management tools (scoped to `.minds/**`)
for (const tool of teamMgmtTools) {
  registerTool(tool);
}

// Register well-known toolsets
registerToolset('memory', [addMemoryTool, dropMemoryTool, replaceMemoryTool, clearMemoryTool]);
setToolsetMeta('memory', {
  source: 'dominds',
  descriptionI18n: { en: 'Personal memory tools', zh: '个人记忆工具' },
  promptFilesI18n: promptFilesFor('memory'),
  manualSpec: manualSpecFor('memory'),
});
registerToolset('team_memory', [
  addSharedMemoryTool,
  dropSharedMemoryTool,
  replaceSharedMemoryTool,
  clearSharedMemoryTool,
]);
setToolsetMeta('team_memory', {
  source: 'dominds',
  descriptionI18n: { en: 'Shared team memory tools', zh: '团队共享记忆工具' },
  promptFilesI18n: promptFilesFor('team_memory'),
  manualSpec: manualSpecFor('team_memory'),
});
registerToolset('control', [
  addReminderTool,
  deleteReminderTool,
  updateReminderTool,
  clearMindTool,
  changeMindTool,
  recallTaskdocTool,
]);
setToolsetMeta('control', {
  source: 'dominds',
  descriptionI18n: { en: 'Dialog control tools', zh: '对话控制工具' },
  promptFilesI18n: promptFilesFor('control'),
  manualSpec: manualSpecFor('control'),
});
registerToolset('os', [
  shellCmdTool,
  stopDaemonTool,
  getDaemonOutputTool,
  envGetTool,
  envSetTool,
  envUnsetTool,
]);
setToolsetMeta('os', {
  source: 'dominds',
  descriptionI18n: { en: 'Shell and process tools', zh: '命令行与进程工具' },
  promptFilesI18n: promptFilesFor('os'),
  manualSpec: manualSpecFor('os'),
});
registerToolset('mcp_admin', [
  mcpRestartTool,
  mcpReleaseTool,
  envGetTool,
  envSetTool,
  envUnsetTool,
]);
setToolsetMeta('mcp_admin', {
  source: 'dominds',
  descriptionI18n: { en: 'MCP administration tools', zh: 'MCP 管理工具' },
  promptFilesI18n: promptFilesFor('mcp_admin'),
  manualSpec: manualSpecFor('mcp_admin'),
});
registerToolset('ws_read', [
  listDirTool,
  readFileTool,
  ripgrepFilesTool,
  ripgrepSnippetsTool,
  ripgrepCountTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
]);
setToolsetMeta('ws_read', {
  source: 'dominds',
  descriptionI18n: { en: 'rtws read-only tools', zh: '运行时工作区只读工具' },
  promptFilesI18n: promptFilesFor('ws_read'),
  manualSpec: manualSpecFor('ws_read'),
});
registerToolset('ws_mod', [
  listDirTool,
  rmDirTool,
  rmFileTool,
  mkDirTool,
  moveFileTool,
  moveDirTool,
  readFileTool,
  createNewFileTool,
  overwriteEntireFileTool,
  prepareFileAppendTool,
  prepareFileInsertAfterTool,
  prepareFileInsertBeforeTool,
  prepareFileBlockReplaceTool,
  prepareFileRangeEditTool,
  applyFileModificationTool,
  ripgrepFilesTool,
  ripgrepSnippetsTool,
  ripgrepCountTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
]);
setToolsetMeta('ws_mod', {
  source: 'dominds',
  descriptionI18n: { en: 'rtws read/write tools', zh: '运行时工作区读写工具' },
  promptFilesI18n: promptFilesFor('ws_mod'),
  manualSpec: manualSpecFor('ws_mod'),
});

// Codex-focused toolsets (function tools only; suitable for Codex provider)
registerToolset('codex_style_tools', [applyPatchTool, readonlyShellTool, updatePlanTool]);
setToolsetMeta('codex_style_tools', {
  source: 'dominds',
  descriptionI18n: {
    en: 'Codex-style tools (apply_patch + readonly_shell + update_plan)',
    zh: 'Codex 风格工具（apply_patch + readonly_shell + update_plan）',
  },
  promptI18n: {
    en: 'Use `apply_patch` (Codex-style patch format) to modify files. Use `readonly_shell` for simple rtws (runtime workspace) inspection via its small allowlist; commands outside the allowlist are rejected. For node/python, only exact version probes are allowed (no scripts). Chains via |/&&/|| are validated segment-by-segment. Use `update_plan` to record/update the task plan (stored as a reminder). You are explicitly authorized to call `readonly_shell` yourself; do not delegate it to a shell specialist. Avoid multi-line script-style commands; single-line is preferred (|, &&, || are ok). Paths must be relative to the rtws (runtime workspace). Hard denies: `readonly_shell` refuses rtws-root `.minds/` and `.dialogs/`; `apply_patch` is subject to the same access-control (including hard denies for `*.tsk/`, `.minds/`, and rtws-root `.dialogs/`).',
    zh: '使用 `apply_patch`（Codex 风格 patch 格式）修改文件；使用 `readonly_shell` 做少量只读命令行检查，仅允许白名单命令前缀，白名单之外的命令会被拒绝。对 node/python 仅允许版本探针（不允许脚本执行）。通过 |/&&/|| 串联命令时会按子命令逐段校验。使用 `update_plan` 记录/更新任务计划（作为 reminder 存储）。你已被明确授权自行调用 `readonly_shell`，不要把它委派给 shell 专员。不建议多行脚本式命令，优先单行（允许 |、&&、||）。路径必须相对 rtws（运行时工作区）根目录。硬拒绝点：`readonly_shell` 无条件拒绝访问 rtws root 的 `.minds/` 与 `.dialogs/`；`apply_patch` 也受相同的访问控制约束（包含对 `*.tsk/`、`.minds/`、rtws root `.dialogs/` 的硬拒绝）。',
  },
  promptFilesI18n: promptFilesFor('codex_style_tools'),
  manualSpec: manualSpecFor('codex_style_tools'),
});
registerToolset('team_mgmt', [...teamMgmtTools]);
setToolsetMeta('team_mgmt', {
  source: 'dominds',
  descriptionI18n: { en: 'Team management tools', zh: '团队管理工具' },
  promptFilesI18n: promptFilesFor('team_mgmt'),
  manualSpec: manualSpecFor('team_mgmt'),
});

// Register ReminderOwners
registerReminderOwner(shellCmdReminderOwner);
registerReminderOwner(mcpLeaseReminderOwner);
registerReminderOwner(pendingTellaskReminderOwner);
