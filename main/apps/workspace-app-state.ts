import { materializeAppsResolution } from './enabled-apps';
import type { AppsResolutionFile } from './resolution-file';

export async function refreshAppsDerivedState(params: {
  rtwsRootAbs: string;
}): Promise<AppsResolutionFile> {
  const resolved = await materializeAppsResolution({ rtwsRootAbs: params.rtwsRootAbs });
  return resolved.resolutionFile;
}
