import type { Dialog } from '../dialog';
import { formatToolActionResult } from '../shared/i18n/tool-result-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import type { Team } from '../team';
import type { FuncTool, ToolArguments } from '../tool';

type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatStatusLabel(language: 'en' | 'zh', status: PlanItemStatus): string {
  if (language === 'zh') {
    switch (status) {
      case 'pending':
        return '待办';
      case 'in_progress':
        return '进行中';
      case 'completed':
        return '已完成';
      default: {
        const _exhaustive: never = status;
        return _exhaustive;
      }
    }
  }

  return status;
}

function renderPlanReminderContent(
  language: 'en' | 'zh',
  args: {
    explanation?: string;
    plan: Array<{ step: string; status: PlanItemStatus }>;
  },
): string {
  const lines: string[] = [];
  lines.push(language === 'zh' ? '计划（update_plan）' : 'Plan (update_plan)');

  if (args.explanation && args.explanation.trim().length > 0) {
    lines.push('');
    lines.push(
      language === 'zh'
        ? `说明：${args.explanation.trim()}`
        : `Explanation: ${args.explanation.trim()}`,
    );
  }

  lines.push('');
  for (let i = 0; i < args.plan.length; i += 1) {
    const item = args.plan[i];
    const label = formatStatusLabel(language, item.status);
    lines.push(`${i + 1}) [${label}] ${item.step}`);
  }

  return lines.join('\n');
}

export const updatePlanTool: FuncTool = {
  type: 'func',
  name: 'update_plan',
  description:
    'Updates the task plan by recording it into reminders. Provide an optional explanation and a list of plan items, each with a step and status. At most one step can be in_progress at a time.',
  descriptionI18n: {
    en: 'Updates the task plan by recording it into reminders. Provide an optional explanation and a list of plan items, each with a step and status. At most one step can be in_progress at a time.',
    zh: '更新任务计划（写入 reminders）。可选 explanation + plan 列表（每项包含 step + status）。同一时间最多允许一个 in_progress。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['plan'],
    properties: {
      explanation: { type: 'string', description: 'Optional explanation.' },
      plan: {
        type: 'array',
        description: 'The list of steps',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['step', 'status'],
          properties: {
            step: { type: 'string', description: 'Step description.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'One of: pending, in_progress, completed',
            },
          },
        },
      },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const planValue: unknown = args['plan'];
    const explanationValue: unknown = args['explanation'];

    if (!Array.isArray(planValue)) {
      return language === 'zh'
        ? '错误：参数格式不对。用法：update_plan({ plan: Array<{ step: string, status: "pending"|"in_progress"|"completed" }>, explanation?: string })'
        : 'Error: Invalid args. Use: update_plan({ plan: Array<{ step: string, status: "pending"|"in_progress"|"completed" }>, explanation?: string })';
    }

    const explanation = typeof explanationValue === 'string' ? explanationValue : undefined;

    const plan: Array<{ step: string; status: PlanItemStatus }> = [];
    let inProgressCount = 0;

    for (const itemValue of planValue) {
      if (!isRecord(itemValue)) {
        return language === 'zh'
          ? '错误：plan 中每一项都必须是对象（包含 step 与 status）。'
          : 'Error: Each plan item must be an object with step and status.';
      }
      const stepValue = itemValue['step'];
      const statusValue = itemValue['status'];
      const step = typeof stepValue === 'string' ? stepValue.trim() : '';
      const statusRaw = typeof statusValue === 'string' ? statusValue : '';
      if (step.length === 0) {
        return language === 'zh'
          ? '错误：plan 中每一项都需要非空 step。'
          : 'Error: Each plan item requires a non-empty step.';
      }

      let status: PlanItemStatus;
      switch (statusRaw) {
        case 'pending':
        case 'in_progress':
        case 'completed':
          status = statusRaw;
          break;
        default:
          return language === 'zh'
            ? '错误：plan[].status 必须是 "pending" | "in_progress" | "completed"。'
            : 'Error: plan[].status must be one of "pending" | "in_progress" | "completed".';
      }

      if (status === 'in_progress') {
        inProgressCount += 1;
        if (inProgressCount > 1) {
          return language === 'zh'
            ? '错误：同一时间最多只能有一个 in_progress。'
            : 'Error: At most one step can be in_progress at a time.';
        }
      }

      plan.push({ step, status });
    }

    const reminderContent = renderPlanReminderContent(language, { explanation, plan });
    const now = formatUnifiedTimestamp(new Date());
    const reminderMeta = {
      kind: 'plan',
      schemaVersion: 1,
      updatedAt: now,
      source: 'update_plan',
      managedByTool: 'update_plan',
      edit: {
        updateExample: 'update_plan({ "plan": [ { "step": "...", "status": "in_progress" } ] })',
      },
    };

    let existingIndex: number | undefined;
    for (let i = 0; i < dlg.reminders.length; i += 1) {
      const meta = dlg.reminders[i]?.meta;
      if (!isRecord(meta)) continue;
      if (meta['kind'] === 'plan') {
        existingIndex = i;
        break;
      }
    }

    if (existingIndex === undefined) {
      // Insert at the top so Plan stays prominent in reminder list UI.
      dlg.addReminder(reminderContent, undefined, reminderMeta, 0);
    } else {
      dlg.updateReminder(existingIndex, reminderContent, reminderMeta);
    }

    return formatToolActionResult(language, 'updated');
  },
};
