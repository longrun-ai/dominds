import type { DomindsAppInstallJsonV1 } from './app-json';
import { loadInstalledAppsFile, type InstalledAppEntry } from './installed-file';

export type EnabledAppSnapshotEntry = Readonly<{
  id: string;
  runtimePort: number | null;
  installJson: DomindsAppInstallJsonV1;
  source: InstalledAppEntry['source'];
}>;

export type EnabledAppsSnapshot = Readonly<{
  enabledApps: ReadonlyArray<EnabledAppSnapshotEntry>;
}>;

export async function loadEnabledAppsSnapshot(params: {
  rtwsRootAbs: string;
}): Promise<EnabledAppsSnapshot> {
  const loaded = await loadInstalledAppsFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loaded.kind === 'error') {
    throw new Error(
      `Failed to load installed apps file: ${loaded.errorText} (${loaded.filePathAbs})`,
    );
  }
  const enabledApps: EnabledAppSnapshotEntry[] = loaded.file.apps
    .filter((a) => a.enabled)
    .map((a) => ({
      id: a.id,
      runtimePort: a.runtime.port,
      installJson: a.installJson,
      source: a.source,
    }));
  return { enabledApps };
}
