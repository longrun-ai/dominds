import { Dialog } from '../../dialog';
import type { CollectedTellaskCall, TellaskEventsReceiver } from '../../tellask';
import { TellaskStreamParser } from '../../tellask';

export function createSayingEventsReceiver(dlg: Dialog): TellaskEventsReceiver {
  return {
    markdownStart: async () => {
      await dlg.markdownStart();
    },
    markdownChunk: async (chunk: string) => {
      await dlg.markdownChunk(chunk);
    },
    markdownFinish: async () => {
      await dlg.markdownFinish();
    },
    callStart: async () => {},
    callHeadLineChunk: async () => {},
    callHeadLineFinish: async () => {},
    tellaskBodyStart: async () => {},
    tellaskBodyChunk: async () => {},
    tellaskBodyFinish: async () => {},
    callFinish: async (call: CollectedTellaskCall) => {
      if (call.validation.kind !== 'valid') {
        return;
      }
      await dlg.callingStart({
        callId: call.callId,
        mentionList: [`@${call.validation.firstMention}`],
        tellaskContent: call.body,
      });
    },
  };
}

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
): Promise<CollectedTellaskCall[]> {
  if (!content.trim()) return [];

  const receiver = createSayingEventsReceiver(dlg);
  const parser = new TellaskStreamParser(receiver);
  await parser.takeUpstreamChunk(content);
  await parser.finalize();

  return parser.getCollectedCalls();
}
