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
import { buildBuiltinManualSpec } from './manual/spec';
import { mcpLeaseReminderOwner, mcpReleaseTool, mcpRestartTool } from './mcp';
import {
  addPersonalMemoryTool,
  addSharedMemoryTool,
  clearPersonalMemoryTool,
  clearSharedMemoryTool,
  dropPersonalMemoryTool,
  dropSharedMemoryTool,
  replacePersonalMemoryTool,
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
  if (toolsetId === 'ws_mod') {
    // ws_mod uses flat single-file format, not subdirectory structure.
    return {
      en: 'prompts/ws_mod.en.md',
      zh: 'prompts/ws_mod.zh.md',
    };
  }
  return {
    en: `prompts/${toolsetId}/en/index.md`,
    zh: `prompts/${toolsetId}/zh/index.md`,
  };
}

function manualSpecFor(toolsetId: string) {
  if (toolsetId === 'ws_mod') {
    return buildBuiltinManualSpec({
      toolsetId: 'ws_mod',
      warnOnMissing: false,
      includeSchemaToolsSection: false,
    });
  }
  return buildBuiltinManualSpec({ toolsetId });
}

registerTool(listDirTool);
registerTool(rmDirTool);
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
registerTool(addPersonalMemoryTool);
registerTool(dropPersonalMemoryTool);
registerTool(replacePersonalMemoryTool);
registerTool(clearPersonalMemoryTool);
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
registerToolset('personal_memory', [
  addPersonalMemoryTool,
  dropPersonalMemoryTool,
  replacePersonalMemoryTool,
  clearPersonalMemoryTool,
]);
setToolsetMeta('personal_memory', {
  source: 'dominds',
  descriptionI18n: {
    en: 'Private memory for this agent: keep stable preferences, responsibility-scope paths, and durable facts accurate.',
    zh: '仅当前智能体可见的个人记忆：维护稳定偏好、职责域路径索引与长期事实。',
  },
  promptFilesI18n: promptFilesFor('personal_memory'),
  manualSpec: manualSpecFor('personal_memory'),
});
registerToolset('team_memory', [
  addSharedMemoryTool,
  dropSharedMemoryTool,
  replaceSharedMemoryTool,
  clearSharedMemoryTool,
]);
setToolsetMeta('team_memory', {
  source: 'dominds',
  descriptionI18n: {
    en: 'Shared team memory: record reusable conventions, invariants, and cross-task collaboration rules.',
    zh: '团队共享记忆：沉淀可复用的约定、不变量与跨任务协作规则。',
  },
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
  descriptionI18n: {
    en: 'Dialog control: manage reminders, Taskdoc sections, and course resets via clear_mind/change_mind.',
    zh: '对话控制：维护提醒项、差遣牒分段，并通过 clear_mind/change_mind 管理对话进程。',
  },
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
  descriptionI18n: {
    en: 'Shell and process operations: run commands, manage daemons, inspect output, and adjust local env vars.',
    zh: '命令行与进程操作：执行命令、管理后台进程、查看输出，并调整本地环境变量。',
  },
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
  descriptionI18n: {
    en: 'MCP administration: restart/release MCP servers and manage related local environment configuration.',
    zh: 'MCP 管理：重启/释放 MCP 服务器，并维护相关本地环境配置。',
  },
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
  descriptionI18n: {
    en: 'rtws read-only access: list directories, read files, and search code/content to gather facts safely.',
    zh: '运行时工作区只读访问：列目录、读文件、检索代码与文本，用于安全获取事实。',
  },
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
  descriptionI18n: {
    en: 'rtws read/write access: inspect, create, move, delete, and precisely edit workspace files.',
    zh: '运行时工作区读写访问：检查、创建、移动、删除，并精确编辑工作区文件。',
  },
  promptFilesI18n: promptFilesFor('ws_mod'),
  manualSpec: manualSpecFor('ws_mod'),
});

// Codex-focused toolsets (function tools only; suitable for Codex provider)
if (process.platform !== 'win32') {
  registerToolset('codex_style_tools', [readonlyShellTool, applyPatchTool, updatePlanTool]);
  setToolsetMeta('codex_style_tools', {
    source: 'dominds',
    descriptionI18n: {
      en: 'Codex-style helpers: readonly_shell for lightweight inspection, apply_patch for edits, and update_plan for task tracking.',
      zh: 'Codex 风格辅助：用 readonly_shell 做轻量检查，用 apply_patch 修改文件，用 update_plan 维护计划。',
    },
    promptI18n: {
      en: 'Use `apply_patch` (Codex-style patch format) to modify files. Use `readonly_shell` for simple rtws (runtime workspace) inspection via its small allowlist; commands outside the allowlist are rejected. For node/python, only exact version probes are allowed (no scripts). Chains via |/&&/|| are validated segment-by-segment. Use `update_plan` to record/update the task plan. You are explicitly authorized to call `readonly_shell` yourself; do not delegate it to a shell specialist. Avoid multi-line script-style commands; single-line is preferred (|, &&, || are ok). Paths must be relative to the rtws (runtime workspace). Hard denies: `readonly_shell` refuses rtws-root `.minds/` and `.dialogs/`; `apply_patch` is subject to the same access-control (including hard denies for `*.tsk/`, `.minds/`, and rtws-root `.dialogs/`).',
      zh: '使用 `apply_patch`（Codex 风格 patch 格式）修改文件；使用 `readonly_shell` 做少量只读命令行检查，仅允许白名单命令前缀，白名单之外的命令会被拒绝。对 node/python 仅允许版本探针（不允许脚本执行）。通过 |/&&/|| 串联命令时会按子命令逐段校验。使用 `update_plan` 记录/更新任务计划。你已被明确授权自行调用 `readonly_shell`，不要把它委派给 shell 专员。不建议多行脚本式命令，优先单行（允许 |、&&、||）。路径必须相对 rtws（运行时工作区）根目录。硬拒绝点：`readonly_shell` 无条件拒绝访问 rtws root 的 `.minds/` 与 `.dialogs/`；`apply_patch` 也受相同的访问控制约束（包含对 `*.tsk/`、`.minds/`、rtws root `.dialogs/` 的硬拒绝）。',
    },
    promptFilesI18n: promptFilesFor('codex_style_tools'),
    manualSpec: manualSpecFor('codex_style_tools'),
  });
}
registerToolset('team_mgmt', [...teamMgmtTools]);
setToolsetMeta('team_mgmt', {
  source: 'dominds',
  descriptionI18n: {
    en: 'Team management under `.minds/`: maintain team config, members, manuals, memory, and governed file changes.',
    zh: '`.minds/` 下的团队管理：维护团队配置、成员、手册、记忆与受控文件修改。',
  },
});

// Register ReminderOwners
registerReminderOwner(shellCmdReminderOwner);
registerReminderOwner(mcpLeaseReminderOwner);
registerReminderOwner(pendingTellaskReminderOwner);
