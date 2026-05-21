import type { AnswerToHumanItem, HumanQuestion } from './storage';

export type { AnswerToHumanItem, HumanQuestion } from './storage';

export interface HumanAttentionDialogContext {
  readonly selfId: string;
  readonly rootId: string;
  readonly agentId: string;
  readonly taskDocPath: string;
  readonly questions: HumanQuestion[];
  readonly answers: AnswerToHumanItem[];
}

export interface GlobalAnswerToHumanItem extends AnswerToHumanItem {
  readonly selfId: string;
  readonly rootId: string;
  readonly agentId: string;
  readonly taskDocPath: string;
}
