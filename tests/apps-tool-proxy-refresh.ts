import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { registerEnabledAppsToolProxies } from '../main/apps/runtime';
import { loadAgentMinds } from '../main/minds/load';
import { getProblemsSnapshot } from '../main/problems';
import { getTool, getToolset, getToolsetMeta } from '../main/tools/registry';
import { writeAppManifest, writeAppText } from './helpers/app-fixture';
import { runHostScenario, writeHostedApp } from './helpers/app-host-fixture';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-tool-proxy-');
runHostScenario(async () => {
  await withTempRtws(async (rtws) => {
    const toolset = 'controlled_host_tools';
    const names = ['probe_tool', 'controlled_status', 'controlled_eval'];
    const id = 'owned_proxy_package';
    const problemId = 'team/team_yaml_error/members/tester/toolsets/controlled_host_tools/missing';
    await writeStandardMinds(rtws, { memberToolsets: [toolset] });
    await writeAppManifest(rtws, 'rtws_root');
    assert.equal(getToolset(toolset), undefined);
    const first = await loadAgentMinds('tester', undefined, { missingToolsetPolicy: 'warn' });
    assert.ok(first.agentTools.every((tool) => !names.includes(tool.name)));
    const before = getProblemsSnapshot().problems.find((problem) => problem.id === problemId);
    assert.ok(before && !before.resolved);
    evidence.record({
      id: 'before-package-load',
      scenario: 'A member selects a component toolset before the owned local package is declared.',
      businessValue:
        'The agent or operator can diagnose absent capabilities and recover through actual package configuration.',
      context: { toolset, componentDeclared: false, componentFactoryStarted: false },
      reviewQuestions: [
        'Does the actual missing-toolset Problem explain the unavailable capability and relevant recovery checks without granting the missing tools?',
        'Is its guidance consistent with a package not yet loaded in this workspace?',
      ],
      actualText: JSON.stringify(
        { problems: [before], actualVisibleToolIds: first.agentTools.map((tool) => tool.name) },
        null,
        2,
      ),
    });
    const marker = path.join(rtws, 'unexpected-factory-entry');
    const supplied = await writeHostedApp(
      rtws,
      id,
      'await require("node:fs/promises").writeFile(' +
        JSON.stringify(marker) +
        ', "entered"); throw new Error("discovery must not start the factory");',
      names,
    );
    await writeAppManifest(rtws, 'rtws_root', [id]);
    const loaded = await loadAgentMinds('tester', undefined, { missingToolsetPolicy: 'warn' });
    for (const name of names) assert.ok(loaded.agentTools.some((tool) => tool.name === name));
    assert.deepEqual(
      getToolset(toolset)?.map((tool) => tool.name),
      names,
    );
    assert.equal(getToolsetMeta(toolset)?.source, 'app');
    assert.deepEqual(
      getToolsetMeta(toolset)?.descriptionI18n,
      supplied.contributes?.toolsets?.[0].descriptionI18n,
    );
    for (const given of supplied.contributes?.toolsets?.[0].tools ?? []) {
      const actual = getTool(given.name);
      assert.ok(actual);
      assert.equal(actual.description, given.description);
      assert.deepEqual(actual.descriptionI18n, given.descriptionI18n);
      assert.deepEqual(actual.parameters, given.parameters);
    }
    assert.equal(
      getProblemsSnapshot().problems.find((problem) => problem.id === problemId)?.resolved,
      true,
    );
    const granted = loaded.agentTools.map((tool) => tool.name).sort();
    await registerEnabledAppsToolProxies({ rtwsRootAbs: rtws });
    assert.deepEqual(
      (await loadAgentMinds('tester')).agentTools.map((tool) => tool.name).sort(),
      granted,
    );
    await writeAppText(
      path.join(rtws, '.apps', 'configuration.yaml'),
      'schemaVersion: 1\ndisabledApps: [owned_proxy_package]\n',
    );
    const disabled = await loadAgentMinds('tester', undefined, { missingToolsetPolicy: 'warn' });
    assert.equal(getToolset(toolset), undefined);
    assert.equal(getToolsetMeta(toolset), undefined);
    for (const name of names) {
      assert.equal(getTool(name), undefined);
      assert.ok(disabled.agentTools.every((tool) => tool.name !== name));
    }
    const unavailable = getProblemsSnapshot().problems;
    assert.equal(unavailable.find((problem) => problem.id === problemId)?.resolved, false);
    evidence.record({
      id: 'package-disabled',
      scenario:
        'The package previously supplied three visible tools; disabling it withdraws those actual capabilities while the member still selects the toolset.',
      businessValue:
        'Expose the real missing/disabled state and its recovery path without leaving stale executable proxies.',
      context: {
        toolset,
        componentDeclared: true,
        componentEnabled: false,
        componentFactoryStarted: false,
        suppliedTools: names.join(','),
      },
      reviewQuestions: [
        'Do the complete active/resolved Problems distinguish a disabled required package from an available toolset?',
        'Does the guidance agree with the actual visible-tool withdrawal and avoid claiming component runtime health?',
      ],
      actualText: JSON.stringify(
        {
          problems: unavailable,
          actualVisibleToolIds: disabled.agentTools.map((tool) => tool.name),
        },
        null,
        2,
      ),
    });
    await writeAppText(
      path.join(rtws, '.apps', 'configuration.yaml'),
      'schemaVersion: 1\ndisabledApps: []\n',
    );
    const restored = await loadAgentMinds('tester');
    assert.deepEqual(restored.agentTools.map((tool) => tool.name).sort(), granted);
    assert.equal(
      getProblemsSnapshot().problems.find((problem) => problem.id === problemId)?.resolved,
      true,
    );
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    console.log(
      JSON.stringify({
        scenario: 'owned-component-capability-refresh',
        suppliedTools: names,
        beforeIds: first.agentTools.map((tool) => tool.name),
        granted,
        restored: restored.agentTools.map((tool) => tool.name).sort(),
        factoryNeverStarted: true,
      }),
    );
  });
  await evidence.write();
});
