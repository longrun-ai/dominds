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
import { verifyTellaskParsingTool } from './diag';
import { envGetTool, envSetTool, envUnsetTool } from './env';
import { listDirTool, mkDirTool, moveDirTool, moveFileTool, rmDirTool, rmFileTool } from './fs';
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
import { updatePlanTool } from './plan';
import { registerReminderOwner, registerTool, registerToolset, setToolsetMeta } from './registry';
import {
  ripgrepCountTool,
  ripgrepFilesTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
  ripgrepSnippetsTool,
} from './ripgrep';
import { teamMgmtTools } from './team-mgmt';
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

// Diag tools
registerTool(verifyTellaskParsingTool);

// Register well-known toolsets
registerToolset('memory', [addMemoryTool, dropMemoryTool, replaceMemoryTool, clearMemoryTool]);
setToolsetMeta('memory', {
  source: 'dominds',
  descriptionI18n: { en: 'Personal memory tools', zh: '个人记忆工具' },
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
  promptFilesI18n: { en: './prompts/ws_mod.en.md', zh: './prompts/ws_mod.zh.md' },
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
    en: 'Use `apply_patch` (Codex-style patch format) to modify files. Use `readonly_shell` for simple rtws (runtime workspace) inspection via its small allowlist; commands outside the allowlist are rejected. For node/python, only exact version probes are allowed (no scripts). Chains via |/&&/|| are validated segment-by-segment. Use `update_plan` to record/update the task plan (stored as a reminder). You are explicitly authorized to call `readonly_shell` yourself; do not delegate it to a shell specialist. Avoid multi-line script-style commands; single-line is preferred (|, &&, || are ok). Paths must be relative to the rtws (runtime workspace). `apply_patch` enforces Dominds directory allow/deny lists.',
    zh: '使用 `apply_patch`（Codex 风格 patch 格式）修改文件；使用 `readonly_shell` 做少量只读命令行检查，仅允许白名单命令前缀，白名单之外的命令会被拒绝。对 node/python 仅允许版本探针（不允许脚本执行）。通过 |/&&/|| 串联命令时会按子命令逐段校验。使用 `update_plan` 记录/更新任务计划（作为 reminder 存储）。你已被明确授权自行调用 `readonly_shell`，不要把它委派给 shell 专员。不建议多行脚本式命令，优先单行（允许 |、&&、||）。路径必须相对 rtws（运行时工作区）根目录。`apply_patch` 会按成员的目录权限（allow/deny）做访问控制。',
  },
});
registerToolset('team-mgmt', [...teamMgmtTools]);
setToolsetMeta('team-mgmt', {
  source: 'dominds',
  descriptionI18n: { en: 'Team management tools', zh: '团队管理工具' },
  promptFilesI18n: { en: './prompts/team_mgmt.en.md', zh: './prompts/team_mgmt.zh.md' },
});
registerToolset('diag', [verifyTellaskParsingTool]);
setToolsetMeta('diag', {
  source: 'dominds',
  descriptionI18n: { en: 'Diagnostics tools', zh: '诊断工具' },
});

// Register ReminderOwners
registerReminderOwner(shellCmdReminderOwner);
registerReminderOwner(mcpLeaseReminderOwner);
