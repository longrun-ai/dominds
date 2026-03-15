import type { ReasoningPayload } from '@longrun-ai/kernel/types/storage';
import { Dialog } from '../../dialog';

export async function emitThinkingEvents(
  dlg: Dialog,
  content: string,
  reasoning?: ReasoningPayload,
): Promise<void> {
  if (!content.trim()) return undefined;

  await dlg.thinkingStart();
  await dlg.thinkingChunk(content);
  await dlg.thinkingFinish(reasoning);
}

export async function emitSayingEvents(dlg: Dialog, content: string): Promise<void> {
  if (!content.trim()) return;
  await dlg.markdownStart();
  await dlg.markdownChunk(content);
  await dlg.markdownFinish();
}
