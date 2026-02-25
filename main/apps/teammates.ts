import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { loadEnabledAppsSnapshot } from './enabled-apps';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type AppTeammatesSnippet = Readonly<{
  appId: string;
  members: Record<string, unknown>;
}>;

export async function loadEnabledAppTeammates(params: {
  rtwsRootAbs: string;
}): Promise<ReadonlyArray<AppTeammatesSnippet>> {
  const snap = await loadEnabledAppsSnapshot({ rtwsRootAbs: params.rtwsRootAbs });
  const out: AppTeammatesSnippet[] = [];
  for (const app of snap.enabledApps) {
    const rel = app.installJson.contributes?.teammatesYamlRelPath;
    if (!rel) continue;
    const filePathAbs = path.resolve(app.installJson.package.rootAbs, rel);
    const raw = await fs.readFile(filePathAbs, 'utf-8');
    const parsed = YAML.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Invalid app teammates yaml: expected object (${app.id} at ${filePathAbs})`);
    }
    const keys = Object.keys(parsed);
    for (const k of keys) {
      if (k !== 'members') {
        throw new Error(
          `Invalid app teammates yaml: unknown top-level key '${k}' (only 'members' allowed) (${app.id} at ${filePathAbs})`,
        );
      }
    }
    const membersRaw = parsed['members'];
    if (membersRaw === undefined) {
      out.push({ appId: app.id, members: {} });
      continue;
    }
    if (!isRecord(membersRaw)) {
      throw new Error(
        `Invalid app teammates yaml: members must be an object (${app.id} at ${filePathAbs})`,
      );
    }
    out.push({ appId: app.id, members: membersRaw });
  }
  return out;
}
