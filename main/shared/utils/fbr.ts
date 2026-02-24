import type { LanguageCode } from '../types/language';

type FbrPerspectiveInput = Readonly<{
  body: string;
  iteration: number;
  total: number;
  language: LanguageCode;
  isFinalRound?: boolean;
}>;

export function appendDistinctPerspectiveFbrBody(input: FbrPerspectiveInput): string {
  const total = Number.isFinite(input.total) ? Math.max(1, Math.floor(input.total)) : 1;
  const iteration = Number.isFinite(input.iteration) ? Math.max(1, Math.floor(input.iteration)) : 1;
  const isFinalRound = input.isFinalRound ?? iteration >= total;
  if (total <= 1) {
    return input.body;
  }
  if (input.language !== 'zh' && input.language !== 'en') {
    return input.body;
  }

  const directive = (() => {
    if (input.language === 'zh') {
      return [
        iteration === 1
          ? `【第 ${iteration}/${total} 轮 FBR】请开启首轮独立推理角度。`
          : `【第 ${iteration}/${total} 轮 FBR】请切换到与前 ${iteration - 1} 轮不同的推理角度。`,
        isFinalRound
          ? '最后一轮也不能复述前文结论，必须补充新的切入点与新增证据。'
          : '要求：不复述上一轮已结论文本，补充本轮独立切入点与未覆盖证据。',
      ].join('\n');
    }
    return [
      iteration === 1
        ? `[FBR round ${iteration}/${total}] start with a first independent reasoning angle.`
        : `[FBR round ${iteration}/${total}] switch to an angle different from the previous ${iteration - 1} rounds.`,
      isFinalRound
        ? 'The final round must also avoid repeating prior-round conclusions and provide new angles and additional evidence.'
        : 'Requirement: do not repeat prior-round conclusion text; add a distinct independent approach and missing evidence.',
    ].join('\n');
  })();

  if (iteration <= 1) {
    return [input.body, '', directive].join('\n');
  }
  return directive;
}
