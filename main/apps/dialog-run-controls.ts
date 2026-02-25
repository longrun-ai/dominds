import type { I18nText } from '../shared/types/i18n';

export type AppDialogRunControlMeta = Readonly<{
  appId: string;
  descriptionI18n?: I18nText;
}>;

const runControlRegistry = new Map<string, AppDialogRunControlMeta>();

export function clearAppDialogRunControlsRegistry(): void {
  runControlRegistry.clear();
}

export function registerAppDialogRunControl(params: {
  id: string;
  appId: string;
  descriptionI18n?: I18nText;
}): void {
  const id = params.id.trim();
  if (id === '') {
    throw new Error('App dialog run control id cannot be empty');
  }
  if (runControlRegistry.has(id)) {
    const existing = runControlRegistry.get(id);
    throw new Error(
      `Duplicate app dialog run control id '${id}' (existing app='${existing?.appId ?? 'unknown'}', new app='${params.appId}')`,
    );
  }
  runControlRegistry.set(id, {
    appId: params.appId,
    descriptionI18n: params.descriptionI18n,
  });
}

export function getAppDialogRunControlMeta(id: string): AppDialogRunControlMeta | null {
  const found = runControlRegistry.get(id);
  return found ?? null;
}

export function listAppDialogRunControls(): ReadonlyArray<
  Readonly<{ id: string } & AppDialogRunControlMeta>
> {
  return [...runControlRegistry.entries()].map(([id, meta]) => ({ id, ...meta }));
}
