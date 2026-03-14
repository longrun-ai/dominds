import type { HumanQuestion } from './storage';

export type { HumanQuestion } from './storage';

export interface Q4HDialogContext {
  readonly selfId: string;
  readonly rootId: string;
  readonly agentId: string;
  readonly taskDocPath: string;
  readonly questions: HumanQuestion[];
}
