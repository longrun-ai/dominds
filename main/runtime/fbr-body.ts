import type { LanguageCode } from '@longrun-ai/kernel/types/language';

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
          ? `【第 ${iteration}/${total} 轮 FBR 发散】请开启首轮独立推理角度。`
          : `【第 ${iteration}/${total} 轮 FBR 发散】请切换到与前 ${iteration - 1} 轮不同的推理角度。`,
        '这一阶段要对反直觉、离谱、少数派、最后可能被淘汰的想法保持开放，把它们先当作待检验候选，而不是急着压成共识。',
        isFinalRound
          ? '最后一轮发散也不能复述前文结论；必须继续补充新的切入点、额外证据或新的解释路径。'
          : '要求：不复述前几轮已结论文本；补充本轮独立切入点、未覆盖证据或新的解释路径。',
        '此时不要急于收敛或下最终结论。',
      ].join('\n');
    }
    return [
      iteration === 1
        ? `[FBR divergence round ${iteration}/${total}] start with a first independent reasoning angle.`
        : `[FBR divergence round ${iteration}/${total}] switch to an angle different from the previous ${iteration - 1} rounds.`,
      'In this phase, stay open to counterintuitive, wild, minority, or eventually-discarded ideas; treat them as candidates to test instead of forcing early consensus.',
      isFinalRound
        ? 'The final divergence round must still avoid repeating prior-round conclusions and add new angles, extra evidence, or alternative explanations.'
        : 'Requirement: do not repeat prior-round conclusion text; add a distinct approach, missing evidence, or a genuinely new explanatory path.',
      'Do not converge or produce a final conclusion yet.',
    ].join('\n');
  })();

  if (iteration <= 1) {
    return [input.body, '', directive].join('\n');
  }
  return directive;
}
