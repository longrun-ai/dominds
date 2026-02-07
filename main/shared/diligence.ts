import type { LanguageCode } from './types/language';

export const DEFAULT_DILIGENCE_PUSH_MAX = 3;

export const DILIGENCE_FALLBACK_TEXT: Readonly<Record<LanguageCode, string>> = {
  zh: [
    '先做一个检查：差遣牒里的目标定义是否已经足够清晰？',
    '如果不清晰，`!?@human` 诉请人类补齐目标。',
    '',
    '如果目标已清晰，再判断：你是否已经完成全部目标？',
    '如果已完成，`!?@human` 诉请人类验收。',
    '',
    '如果尚未完成，优先立即确定并执行下一步最优行动（工具调用或诉请队友）。',
    '仅当下一步不清晰/难以决策时，才发起一次 `!?@self` 扪心自问（FBR）；收齐该次回贴后，立即把结论落地执行，不要只汇报决定。',
    '',
    '当你确信自己不该或者不能自主继续工作时，立即 `!?@human` 诉请人类确认问题或指出方向。',
    '',
    '注意：',
    '- 做 FBR 时，自诉请正文要包含当前状况的完整事实性总结（不要重复差遣牒已有内容）。',
    '- `!?@self` 发起后先等回贴再综合；综合后必须马上执行已确定行动（工具调用/诉请队友）。',
    '- 队友回复“将要/可以做 XXX”时，先判是否值得推进：可做可不做就忽略；值得继续就纠正/鼓励并立即诉请其继续。',
  ].join('\n'),
  en: [
    'Quick discipline check:',
    'Is the goal in the Taskdoc clear enough?',
    'If not, use `!?@human` to ask for a clearer target.',
    '',
    'If the goal is clear, ask: are all goals already complete?',
    'If yes, use `!?@human` to request acceptance.',
    '',
    'If not complete, pick and execute the best next action now (tool call or teammate tellask).',
    'Use `!?@self` FBR only when the next move is unclear or hard to decide. After feedback from that FBR run returns, turn the conclusion into an action immediately; do not stop at reporting a decision.',
    '',
    'When you should not or cannot proceed autonomously, use `!?@human` to ask for direction.',
    '',
    'Notes:',
    '- In FBR, include a full factual summary of the current state in the tellask body (do not duplicate what is already in the Taskdoc).',
    '- After `!?@self`, wait for feedback before finalizing. Once finalized, execute immediately (tool call / teammate tellask).',
    '- If a teammate says they “can/will do X”, triage it: ignore optional low-value work; if it matters, correct/encourage and immediately tellask them to continue.',
  ].join('\n'),
};
