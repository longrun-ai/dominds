import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { toolSuccess, type ToolCallOutput } from '../tool';

export type ToolActionResult =
  | 'added'
  | 'deleted'
  | 'updated'
  | 'cleared'
  | 'mindCleared'
  | 'mindChanged';

export function formatToolOk(language: LanguageCode): string {
  return language === 'zh' ? '完成' : 'OK';
}

export function formatToolError(language: LanguageCode): string {
  return language === 'zh' ? '错误' : 'Error';
}

export function formatToolActionResult(
  language: LanguageCode,
  action: ToolActionResult,
): ToolCallOutput {
  if (language === 'zh') {
    switch (action) {
      case 'added':
        return toolSuccess('已添加');
      case 'deleted':
        return toolSuccess('已删除');
      case 'updated':
        return toolSuccess('已更新');
      case 'cleared':
        return toolSuccess('已清空');
      case 'mindCleared':
        return toolSuccess('已清理头脑');
      case 'mindChanged':
        return toolSuccess('已更新想法');
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  switch (action) {
    case 'added':
      return toolSuccess('Added');
    case 'deleted':
      return toolSuccess('Deleted');
    case 'updated':
      return toolSuccess('Updated');
    case 'cleared':
      return toolSuccess('Cleared');
    case 'mindCleared':
      return toolSuccess('Mind cleared');
    case 'mindChanged':
      return toolSuccess('Mind changed');
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
