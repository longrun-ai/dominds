import type { LanguageCode } from './types/language';

export const DEFAULT_DILIGENCE_PUSH_MAX = 3;

export const DILIGENCE_FALLBACK_TEXT: Readonly<Record<LanguageCode, string>> = {
  zh: [
    '除非确实需要人类用户介入，请继续你的工作。',
    '',
    '作为智能体团队成员，你该诉请（`!?@<teammate-callsign>`）队友完成的事儿千万别自己干，你自己的事儿能自己动手推进的就绝不要麻烦人类。',
    '',
    '不该或者不能自主继续工作时，你应该使用 `!?@human` 诉请人类确认相关问题或者指出工作方向。',
  ].join('\n'),
  en: [
    'Unless you truly need the human user to intervene, keep working.',
    '',
    'As an agent team member: if it’s something you should ask a teammate (`!?@<teammate-callsign>`) to do, do not do it yourself; and for things you can advance on your own, do not bother the human.',
    '',
    'When you should not or cannot continue autonomously, use `!?@human` to ask the human to confirm the relevant questions or provide direction.',
  ].join('\n'),
};
