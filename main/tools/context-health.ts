import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { formatContextHealthReminderText } from '../shared/i18n/driver-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type { ContextHealthSnapshot } from '../shared/types/context-health';
import type { LanguageCode } from '../shared/types/language';
import type { Reminder, ReminderOwner, ReminderUpdateResult } from '../tool';

type ContextHealthReminderMeta = Readonly<{
  kind: 'critical_countdown';
  remainingGenTurns: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reminder meta is persisted as JSON and may come from disk; runtime validation is required.
function isContextHealthReminderMeta(value: unknown): value is ContextHealthReminderMeta {
  if (!isRecord(value)) return false;
  if (value['kind'] !== 'critical_countdown') return false;
  const remaining = value['remainingGenTurns'];
  return typeof remaining === 'number' && Number.isFinite(remaining);
}

function clampRemainingGenTurns(n: number): number {
  const floored = Math.floor(n);
  if (floored < 0) return 0;
  if (floored > 5) return 5;
  return floored;
}

function isLastContextHealthFromCurrentGeneration(dlg: Dialog): boolean {
  const active = dlg.activeGenSeqOrUndefined;
  const snapSeq = dlg.getLastContextHealthGenseq();
  return active !== undefined && snapSeq !== undefined && active === snapSeq;
}

function formatContextHealthOwnerHeader(args: {
  language: LanguageCode;
  indexHuman: number;
  snapshot?: ContextHealthSnapshot;
  remainingGenTurns?: number;
}): string {
  const { language, indexHuman, snapshot } = args;
  const remainingGenTurns =
    typeof args.remainingGenTurns === 'number' ? args.remainingGenTurns : undefined;

  if (language === 'zh') {
    const lines: string[] = [
      '📋',
      `【系统托管提醒项 #${indexHuman}：上下文健康 / owner=context_health】`,
      '- 自动更新/自动消失；不要手工 delete_reminder',
    ];

    if (!snapshot) {
      lines.push('- 状态：未知（尚未获取上下文统计）');
      lines.push('- 现在就做：用提醒项收敛关键细节（update_reminder）→ change_mind(progress) → clear_mind');
      return lines.join('\n');
    }

    if (snapshot.kind !== 'available') {
      lines.push('- 状态：未知（token 统计不可用）');
      lines.push('- 现在就做：用提醒项收敛关键细节（update_reminder）→ change_mind(progress) → clear_mind');
      return lines.join('\n');
    }

    switch (snapshot.level) {
      case 'healthy': {
        lines.push('- 状态：🟢 绿（健康）');
        return lines.join('\n');
      }
      case 'caution': {
        lines.push('- 状态：🟡 黄（必须尽快清理）');
        lines.push('- 硬规程：先 update_reminder 收敛工作集 → 再 change_mind(progress) → 然后 clear_mind');
        return lines.join('\n');
      }
      case 'critical': {
        lines.push('- 状态：🔴 红（硬闸门）');
        if (remainingGenTurns !== undefined) {
          lines.push(
            `- 倒数：剩余 ${remainingGenTurns} 次生成机会；到 0 系统将被动开启新一轮/新回合以保持稳定性`,
          );
        }
        lines.push('- 禁止继续推进实现：先 update_reminder 收敛工作集 → 再 change_mind(progress) → 然后 clear_mind');
        return lines.join('\n');
      }
      default: {
        const _exhaustive: never = snapshot.level;
        return _exhaustive;
      }
    }
  }
  }

  const lines: string[] = [
    '📋',
    `【System-managed reminder item #${indexHuman}: context health / owner=context_health】`,
    '- Auto-updating/auto-dropping; do not manually delete_reminder',
  ];

  if (!snapshot) {
    lines.push('- Status: unknown (no context stats yet)');
    lines.push('- Priority: change_mind(progress) → clear_mind');
    return lines.join('\n');
  }

  if (snapshot.kind !== 'available') {
    lines.push('- Status: unknown (token usage unavailable)');
    lines.push('- Priority: change_mind(progress) → clear_mind');
    return lines.join('\n');
  }

  switch (snapshot.level) {
    case 'healthy': {
      lines.push('- Status: 🟢 green (healthy)');
      return lines.join('\n');
    }
    case 'caution': {
      lines.push('- Status: 🟡 yellow (caution)');
      lines.push('- Priority: change_mind(progress) → clear_mind');
      return lines.join('\n');
    }
    case 'critical': {
      lines.push('- Status: 🔴 red (critical)');
      if (remainingGenTurns !== undefined) {
        lines.push(`- Countdown: ${remainingGenTurns} generations left; at 0 auto-start new round`);
      }
      lines.push('- Must: change_mind(progress) → clear_mind');
      return lines.join('\n');
    }
    default: {
      const _exhaustive: never = snapshot.level;
      return _exhaustive;
    }
  }
}

export const contextHealthReminderOwner: ReminderOwner = {
  name: 'context_health',

  async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (reminder.owner !== contextHealthReminderOwner) {
      return { treatment: 'keep' };
    }

    const snapshot: ContextHealthSnapshot | undefined = dlg.getLastContextHealth();
    if (!snapshot) {
      return { treatment: 'keep' };
    }

    if (snapshot.kind !== 'available') {
      return {
        treatment: 'update',
        updatedContent: formatContextHealthReminderText(getWorkLanguage(), {
          kind: 'usage_unknown',
        }),
        updatedMeta: undefined,
      };
    }

    if (snapshot.level === 'healthy') {
      return { treatment: 'drop' };
    }

    if (snapshot.level === 'caution') {
      return {
        treatment: 'update',
        updatedContent: formatContextHealthReminderText(getWorkLanguage(), {
          kind: 'over_optimal',
        }),
        updatedMeta: undefined,
      };
    }

    const meta = isContextHealthReminderMeta(reminder.meta) ? reminder.meta : undefined;
    const initialized = meta !== undefined;

    let remainingGenTurns = meta ? clampRemainingGenTurns(meta.remainingGenTurns) : 5;
    if (initialized && isLastContextHealthFromCurrentGeneration(dlg) && remainingGenTurns > 0) {
      remainingGenTurns -= 1;
    }

    const content = formatContextHealthReminderText(getWorkLanguage(), {
      kind: 'over_critical',
      remainingGenTurns,
    });
    return {
      treatment: 'update',
      updatedContent: content,
      updatedMeta: { kind: 'critical_countdown', remainingGenTurns },
    };
  },

  async renderReminder(dlg: Dialog, reminder: Reminder, index: number): Promise<ChatMessage> {
    const snapshot: ContextHealthSnapshot | undefined = dlg.getLastContextHealth();
    const meta = isContextHealthReminderMeta(reminder.meta) ? reminder.meta : undefined;

    const language = getWorkLanguage();
    const header = formatContextHealthOwnerHeader({
      language,
      indexHuman: index + 1,
      snapshot,
      remainingGenTurns: meta ? clampRemainingGenTurns(meta.remainingGenTurns) : undefined,
    });
    const rendered = `${header}\n---\n${reminder.content}`;

    return {
      type: 'transient_guide_msg',
      role: 'assistant',
      content: rendered,
    };
  },
};
