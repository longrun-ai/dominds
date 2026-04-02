import type { LanguageCode } from '@longrun-ai/kernel/types/language';

type TellaskKindName =
  | 'tellaskBack'
  | 'tellask'
  | 'tellaskSessionless'
  | 'freshBootsReasoning'
  | 'replyTellaskBack'
  | 'replyTellask'
  | 'replyTellaskSessionless';

function normalizeTellaskKindName(
  name: TellaskKindName,
): Exclude<TellaskKindName, `reply${string}`> {
  switch (name) {
    case 'replyTellaskBack':
      return 'tellaskBack';
    case 'replyTellask':
      return 'tellask';
    case 'replyTellaskSessionless':
      return 'tellaskSessionless';
    case 'tellaskBack':
    case 'tellask':
    case 'tellaskSessionless':
    case 'freshBootsReasoning':
      return name;
  }
}

export function getTellaskKindLabel(args: {
  language: LanguageCode;
  name: TellaskKindName;
  bracketed?: boolean;
}): string {
  const normalized = normalizeTellaskKindName(args.name);
  const bare =
    args.language === 'zh'
      ? (() => {
          switch (normalized) {
            case 'tellaskBack':
              return '回问诉请';
            case 'tellask':
              return '长线诉请';
            case 'tellaskSessionless':
              return '一次性诉请';
            case 'freshBootsReasoning':
              return '扪心自问（FBR）';
          }
        })()
      : (() => {
          switch (normalized) {
            case 'tellaskBack':
              return 'TellaskBack';
            case 'tellask':
              return 'Tellask Session';
            case 'tellaskSessionless':
              return 'Fresh Tellask';
            case 'freshBootsReasoning':
              return 'Fresh Boots Reasoning (FBR)';
          }
        })();
  return args.bracketed === true ? `【${bare}】` : bare;
}
