/**
 * Module: tools/mcp
 *
 * Local MCP supervisor control tools for testing and operations.
 */

import type { Dialog } from '../dialog';
import { createLogger } from '../log';
import {
  isMcpToolsetLeasedToDialog,
  releaseMcpToolsetLeaseForDialog,
  requestMcpServerRestart,
} from '../mcp/supervisor';
import { formatSystemNoticePrefix } from '../runtime/driver-messages';
import { getWorkLanguage } from '../runtime/work-language';
import { Team } from '../team';
import type {
  FuncTool,
  JsonSchema,
  Reminder,
  ReminderOwner,
  ReminderUpdateResult,
  ToolArguments,
  ToolCallOutput,
} from '../tool';
import { toolFailure, toolSuccess } from '../tool';
import { notifyToolAvailabilityRuntimeLeaseChanged } from '../tool-availability-updates';

const log = createLogger('tools/mcp');

type McpRestartArgs = Readonly<{
  serverId: string;
}>;

type McpReleaseArgs = Readonly<{
  serverId: string;
}>;

type McpLeaseReminderMeta = Readonly<{
  kind: 'mcp_lease';
  serverId: string;
}>;

function parseMcpRestartArgs(args: ToolArguments): McpRestartArgs {
  const serverId = args.serverId;
  if (typeof serverId !== 'string' || !serverId.trim()) {
    throw new Error(`mcp_restart.serverId must be a non-empty string`);
  }
  return { serverId };
}

function parseMcpReleaseArgs(args: ToolArguments): McpReleaseArgs {
  const serverId = args.serverId;
  if (typeof serverId !== 'string' || !serverId.trim()) {
    throw new Error(`mcp_release.serverId must be a non-empty string`);
  }
  return { serverId };
}

function isMcpLeaseReminderMeta(value: unknown): value is McpLeaseReminderMeta {
  if (!isRecord(value) || Array.isArray(value)) return false;
  if (value.kind !== 'mcp_lease') return false;
  return typeof value.serverId === 'string' && value.serverId.trim().length > 0;
}

const mcpRestartSchema: JsonSchema = {
  type: 'object',
  properties: {
    serverId: {
      type: 'string',
      description:
        "MCP server id from `.minds/mcp.yaml` (e.g., 'sdk_stdio'). Restarts this server only.",
    },
  },
  required: ['serverId'],
  additionalProperties: false,
};

const mcpReleaseSchema: JsonSchema = {
  type: 'object',
  properties: {
    serverId: {
      type: 'string',
      description:
        "MCP server id from `.minds/mcp.yaml` (e.g., 'playwright'). Releases this dialog's current leased MCP runtime instance/process for that server.",
    },
  },
  required: ['serverId'],
  additionalProperties: false,
};

export const mcpRestartTool: FuncTool = {
  type: 'func',
  name: 'mcp_restart',
  description:
    'Restart a configured MCP server using the current `.minds/mcp.yaml` config (best-effort).',
  descriptionI18n: {
    en: 'Restart a configured MCP server using the current `.minds/mcp.yaml` config (best-effort).',
    zh: '使用当前的 `.minds/mcp.yaml` 配置重启指定的 MCP 服务器（尽力而为）。',
  },
  parameters: mcpRestartSchema,
  argsValidation: 'dominds',
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> => {
    const parsed = parseMcpRestartArgs(args);

    const res = await requestMcpServerRestart(parsed.serverId);

    if (res.ok) {
      log.debug('mcp_restart', undefined, {
        caller: caller.id,
        serverId: parsed.serverId,
        ok: true,
      });
    } else {
      log.warn('mcp_restart failed', undefined, {
        caller: caller.id,
        serverId: parsed.serverId,
        ok: false,
        errorText: res.errorText,
      });
      return toolFailure(`error: ${res.errorText}`);
    }

    return toolSuccess(`ok: restarted ${parsed.serverId}`);
  },
};

export const mcpReleaseTool: FuncTool = {
  type: 'func',
  name: 'mcp_release',
  description:
    "Release this dialog's current leased MCP runtime instance for a server (stops the underlying process/connection).",
  descriptionI18n: {
    en: "Release this dialog's current leased MCP runtime instance for a server (stops the underlying process/connection).",
    zh: '释放当前对话为某个 server 持有的 MCP 运行时实例（停止底层进程/连接）。',
  },
  parameters: mcpReleaseSchema,
  argsValidation: 'dominds',
  call: async (dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> => {
    const parsed = parseMcpReleaseArgs(args);
    const dialogKey = dlg.id.key();

    const res = releaseMcpToolsetLeaseForDialog(parsed.serverId, dialogKey);

    if (res.ok) {
      log.debug('mcp_release', undefined, {
        caller: caller.id,
        serverId: parsed.serverId,
        ok: true,
        released: res.released,
      });
    } else {
      log.warn('mcp_release failed', undefined, {
        caller: caller.id,
        serverId: parsed.serverId,
        ok: false,
        errorText: res.errorText,
      });
      return toolFailure(`error: ${res.errorText}`);
    }

    if (!res.released) {
      return toolSuccess(
        `ok: no active lease for ${parsed.serverId} (or server is truely-stateless)`,
      );
    }
    notifyToolAvailabilityRuntimeLeaseChanged(`mcp_release:${parsed.serverId}:${dialogKey}`);
    return toolSuccess(`ok: released ${parsed.serverId} for dialog ${dialogKey}`);
  },
};

export const mcpLeaseReminderOwner: ReminderOwner = {
  name: 'mcpLease',
  async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (reminder.owner !== mcpLeaseReminderOwner) return { treatment: 'keep' };
    if (!isMcpLeaseReminderMeta(reminder.meta)) return { treatment: 'keep' };

    const dialogKey = dlg.id.key();
    const leased = isMcpToolsetLeasedToDialog(reminder.meta.serverId, dialogKey);
    if (!leased) {
      return { treatment: 'drop' };
    }
    return { treatment: 'keep' };
  },

  async renderReminder(dlg: Dialog, reminder: Reminder) {
    const workLanguage = getWorkLanguage();
    const prefix = formatSystemNoticePrefix(workLanguage);
    if (reminder.owner !== mcpLeaseReminderOwner || !isMcpLeaseReminderMeta(reminder.meta)) {
      return {
        type: 'environment_msg',
        role: 'user',
        content:
          workLanguage === 'zh'
            ? `${prefix} MCP 工具集租约提醒 [${reminder.id}]\n你正在查看系统维护的 MCP 租约状态，不要把它当成你自己写的工作便签。\n\n${reminder.content}`
            : `${prefix} MCP toolset lease reminder [${reminder.id}]\nYou are looking at system-maintained MCP lease state. Do not treat it as a self-authored work note.\n\n${reminder.content}`,
      };
    }

    const serverId = reminder.meta.serverId;
    return {
      type: 'environment_msg',
      role: 'user',
      content:
        workLanguage === 'zh'
          ? [
              `${prefix} MCP 工具集租约 [${reminder.id}]: \`${serverId}\``,
              '',
              `你当前看到的是系统维护的 MCP 租约状态。该 MCP server 被视为非“真正无状态”；当前对话持有一个 MCP 运行时实例（HTTP 连接或 stdio 进程）。`,
              '',
              `当你确认近期不再需要这个运行时实例时，请释放它，以停止/回收底层 MCP 进程或连接：`,
              `- \`mcp_release({\"serverId\":\"${serverId}\"})\``,
              '',
              `这只影响当前对话持有的运行时实例，不决定该 server 的全局工具注册/可见性。`,
            ].join('\n')
          : [
              `${prefix} MCP toolset lease [${reminder.id}]: \`${serverId}\``,
              '',
              `You are looking at system-maintained MCP lease state. This MCP server is treated as non-stateless, and the current dialog holds one MCP runtime instance for it (an HTTP connection or stdio process).`,
              '',
              `When you are confident you will not need this runtime instance soon, release it to stop the underlying MCP process/connection:`,
              `- \`mcp_release({\"serverId\":\"${serverId}\"})\``,
              '',
              `This only affects the runtime instance held by the current dialog; it does not determine global tool registration/visibility for that server.`,
            ].join('\n'),
    };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
