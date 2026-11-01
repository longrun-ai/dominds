import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { loadEnabledAppTeammates } from '../main/apps/teammates';
import { writeAppManifest, writeAppText, writeLocalApp } from './helpers/app-fixture';
import { withTempRtws } from './kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const common = path.join(rtws, 'dominds-apps', 'common_agents');
    const mid = path.join(rtws, 'dominds-apps', 'mid_agents');
    const outer = path.join(rtws, 'dominds-apps', 'outer_agents');
    await writeAppManifest(rtws, 'rtws_root', ['outer_agents']);
    await writeLocalApp(common, 'common_agents', {
      packageName: 'app-common-agents',
      teammatesYamlRelPath: 'team.yaml',
    });
    await writeLocalApp(mid, 'mid_agents', {
      packageName: 'app-mid-agents',
      dependencies: ['common_agents', 'outer_agents'],
    });
    await writeLocalApp(outer, 'outer_agents', {
      packageName: 'app-outer-agents',
      dependencies: ['mid_agents'],
    });
    const defaults = path.join(common, 'team.yaml');
    const middleOverride = path.join(mid, '.apps', 'override', 'common_agents', 'team.yaml');
    const outerOverride = path.join(outer, '.apps', 'override', 'common_agents', 'team.yaml');
    const rtwsOverride = path.join(rtws, '.apps', 'override', 'common_agents', 'team.yaml');
    const values = {
      default: {
        name: 'ScribeFromDefault',
        description: 'given-default-description',
        toolsets: ['ws_read'],
      },
      mid: {
        name: 'ScribeFromMidOverride',
        description: 'given-mid-description',
        toolsets: ['ws_read'],
      },
      outer: {
        name: 'ScribeFromOuterOverride',
        description: 'given-outer-description',
        toolsets: ['personal_memory'],
      },
      rtws: {
        name: 'ScribeFromRtwsOverride',
        description: 'given-rtws-description',
        toolsets: ['ws_mod'],
      },
    };
    for (const [file, data] of [
      [defaults, values.default],
      [middleOverride, values.mid],
      [outerOverride, values.outer],
    ] as const) {
      // JSON is valid YAML; all fields below are opaque supplied member data.
      await writeAppText(file, JSON.stringify({ members: { scribe: data } }));
    }
    const expect = async (value: typeof values.default) =>
      assert.deepEqual(await loadEnabledAppTeammates({ rtwsRootAbs: rtws }), [
        { appId: 'common_agents', members: { scribe: value } },
      ]);
    // The mid/outer cycle must terminate; outside integrator overrides beat inside ones.
    await expect(values.outer);
    await writeAppText(rtwsOverride, JSON.stringify({ members: { scribe: values.rtws } }));
    await expect(values.rtws);
    await fs.rm(rtwsOverride);
    await fs.rm(outerOverride);
    await expect(values.mid);
    await fs.rm(middleOverride);
    await expect(values.default);
  });
  console.log(
    'cyclic package graph terminates; rtws, outer, inner and default member payloads follow precedence: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
