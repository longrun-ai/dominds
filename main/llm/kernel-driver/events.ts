import type { ProviderData, ReasoningPayload } from '@longrun-ai/kernel/types/storage';
import { Dialog } from '../../dialog';

export async function emitThinkingEvents(
  dlg: Dialog,
  content: string,
  reasoning?: ReasoningPayload,
  providerData?: ProviderData,
): Promise<void> {
  const hasContent = content.trim().length > 0;
  if (!hasContent && reasoning === undefined && providerData === undefined) return;

  await dlg.thinkingStart();
  if (hasContent) {
    await dlg.thinkingChunk(content);
  }
  await dlg.thinkingFinish(reasoning, providerData);
}

export async function emitSayingEvents(dlg: Dialog, content: string): Promise<void> {
  if (!content.trim()) return;
  await dlg.markdownStart();
  await dlg.markdownChunk(content);
  await dlg.markdownFinish();
}
