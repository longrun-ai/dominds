import { Dialog } from '../../dialog';

export async function emitThinkingEvents(
  dlg: Dialog,
  content: string,
): Promise<string | undefined> {
  if (!content.trim()) return undefined;

  await dlg.thinkingStart();
  await dlg.thinkingChunk(content);
  await dlg.thinkingFinish();

  const signatureMatch = content.match(/<thinking[^>]*>(.*?)<\/thinking>/s);
  return signatureMatch?.[1]?.trim();
}

export async function emitSayingEvents(
  dlg: Dialog,
  content: string,
): Promise<void> {
  if (!content.trim()) return;
  await dlg.markdownStart();
  await dlg.markdownChunk(content);
  await dlg.markdownFinish();
}
