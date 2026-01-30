import type { LanguageCode } from '../types/language';

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

export function formatToolActionResult(language: LanguageCode, action: ToolActionResult): string {
  if (language === 'zh') {
    switch (action) {
      case 'added':
        return '已添加';
      case 'deleted':
        return '已删除';
      case 'updated':
        return '已更新';
      case 'cleared':
        return '已清空';
      case 'mindCleared':
        return '已清理头脑';
      case 'mindChanged':
        return '已更新思路';
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  switch (action) {
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'updated':
      return 'Updated';
    case 'cleared':
      return 'Cleared';
    case 'mindCleared':
      return 'Mind cleared';
    case 'mindChanged':
      return 'Mind changed';
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
