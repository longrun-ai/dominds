import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { setGlobalDialogEventBroadcaster } from '../evt-registry';
import { createLogger } from '../log';

const log = createLogger('global-dialog-event-broadcaster');

export type GlobalDialogEventRecorder = Readonly<{
  label: string;
  snapshot: () => readonly TypedDialogEvent[];
  clear: () => void;
}>;

type InstalledBroadcasterState =
  | Readonly<{ kind: 'uninitialized' }>
  | Readonly<{
      kind: 'custom';
      label: string;
      publish: (evt: TypedDialogEvent) => void;
    }>
  | Readonly<{
      kind: 'recording';
      label: string;
      events: TypedDialogEvent[];
      publish?: (evt: TypedDialogEvent) => void;
    }>;

let installedBroadcasterState: InstalledBroadcasterState = { kind: 'uninitialized' };

function buildRecorder(label: string, events: TypedDialogEvent[]): GlobalDialogEventRecorder {
  return {
    label,
    snapshot: () => [...events],
    clear: () => {
      events.length = 0;
    },
  };
}

export function installGlobalDialogEventBroadcaster(args: {
  label: string;
  publish: (evt: TypedDialogEvent) => void;
}): void {
  installedBroadcasterState = {
    kind: 'custom',
    label: args.label,
    publish: args.publish,
  };
  setGlobalDialogEventBroadcaster(args.publish);
  log.debug('Installed global dialog event broadcaster', undefined, {
    label: args.label,
    kind: 'custom',
  });
}

export function installRecordingGlobalDialogEventBroadcaster(args?: {
  label?: string;
  publish?: (evt: TypedDialogEvent) => void;
}): GlobalDialogEventRecorder {
  const label = args?.label?.trim() || 'recording-broadcaster';
  const events: TypedDialogEvent[] = [];
  const publish = (evt: TypedDialogEvent): void => {
    events.push(evt);
    args?.publish?.(evt);
  };
  installedBroadcasterState = {
    kind: 'recording',
    label,
    events,
    publish: args?.publish,
  };
  setGlobalDialogEventBroadcaster(publish);
  log.debug('Installed recording global dialog event broadcaster', undefined, {
    label,
    kind: 'recording',
  });
  return buildRecorder(label, events);
}

export function clearInstalledGlobalDialogEventBroadcaster(): void {
  const previousKind = installedBroadcasterState.kind;
  installedBroadcasterState = { kind: 'uninitialized' };
  setGlobalDialogEventBroadcaster(null);
  log.debug('Cleared global dialog event broadcaster', undefined, {
    previousKind,
  });
}

export function assertGlobalDialogEventBroadcasterInstalled(where: string): void {
  if (installedBroadcasterState.kind !== 'uninitialized') {
    return;
  }
  throw new Error(
    `Global dialog event broadcaster runtime missing: ${where} must install the broadcaster during runtime bootstrap before dialog logic runs`,
  );
}

export function getRecordingGlobalDialogEventRecorder(): GlobalDialogEventRecorder | null {
  if (installedBroadcasterState.kind !== 'recording') {
    return null;
  }
  return buildRecorder(installedBroadcasterState.label, installedBroadcasterState.events);
}

export function requireRecordingGlobalDialogEventRecorder(
  where: string,
): GlobalDialogEventRecorder {
  const recorder = getRecordingGlobalDialogEventRecorder();
  if (recorder) {
    return recorder;
  }
  const currentKind = installedBroadcasterState.kind;
  throw new Error(
    `Global dialog event recorder missing: ${where} requires a recording broadcaster, but runtime installed '${currentKind}'`,
  );
}
