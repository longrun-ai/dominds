import assert from 'node:assert/strict';

import { parseMcpYaml, resolveMcpScopedTransforms } from '../main/mcp/config';
import {
  clearMcpPromptResourceCatalog,
  listMcpPrompts,
  listMcpResources,
  listMcpVirtualSkills,
  type McpPromptResourceCatalogClient,
  refreshMcpPromptResourceCatalog,
} from '../main/mcp/resources';
import { buildHttpHeaders } from '../main/mcp/supervisor';
import { applyMcpIdTransforms } from '../main/mcp/tool-names';

import { semanticEvidenceCollector } from './helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-mcp-config-');
function diagnostic(id: string, scenario: string, actualText: string) {
  evidence.record({
    id,
    scenario,
    businessValue:
      'An operator can locate the invalid configuration or missing host input without losing healthy capabilities.',
    context: { scope: 'Pure config/header parsing; no network connection.' },
    reviewQuestions: [
      'Does the actual diagnostic accurately identify the supplied invalid field or missing input and its required type?',
    ],
    actualText,
  });
}

const AUTH_ENV = 'DOMINDS_TEST_MCP_AUTH_TOKEN';
const RAW_ENV = 'DOMINDS_TEST_MCP_RAW_HEADER';

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    const next = updates[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function makeCatalogClient(): McpPromptResourceCatalogClient {
  return {
    async listPrompts() {
      return [{ name: 'prompt_alpha' }];
    },
    async listResources() {
      return [
        {
          uri: 'resource://plain',
          name: 'plain',
          mimeType: 'text/plain',
        },
        {
          uri: 'skill://guide',
          name: 'guide',
          mimeType: 'text/markdown',
        },
      ];
    },
    async listResourceTemplates() {
      return [{ uriTemplate: 'template://item/{id}', name: 'templated' }];
    },
    async readResource(uri: string) {
      assert.equal(uri, 'skill://guide');
      return [
        {
          uri,
          mimeType: 'text/markdown',
          text: [
            '---',
            'name: Guide',
            'description: Guide skill',
            '---',
            '',
            'Use the guide.',
          ].join('\n'),
        },
      ];
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseMcpYaml(`
version: 1
servers:
  http:
    truely-stateless: true
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    headers:
      Authorization:
        prefix: "Bearer "
        env: ${AUTH_ENV}
      X-Raw:
        env: ${RAW_ENV}
      X-Literal: dominds
`);

  assert.ok(parsed.ok);

  const cfg = parsed.config.servers.http;
  assert.ok(cfg && cfg.transport === 'streamable_http');

  assert.deepEqual(cfg.headers.Authorization, {
    kind: 'from_env',
    prefix: 'Bearer ',
    env: AUTH_ENV,
  });
  assert.deepEqual(cfg.headers['X-Raw'], { kind: 'from_env', prefix: '', env: RAW_ENV });
  assert.deepEqual(cfg.headers['X-Literal'], { kind: 'literal', value: 'dominds' });

  withEnv(
    {
      [AUTH_ENV]: 'MENTORTRIAL42',
      [RAW_ENV]: 'raw-token',
    },
    () => {
      assert.deepEqual(buildHttpHeaders(cfg, 'http'), {
        Authorization: 'Bearer MENTORTRIAL42',
        'X-Raw': 'raw-token',
        'X-Literal': 'dominds',
      });
    },
  );

  withEnv({ [AUTH_ENV]: undefined, [RAW_ENV]: 'raw-token' }, () => {
    let failure: unknown;
    try {
      buildHttpHeaders(cfg, 'http');
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    diagnostic(
      'missing-host-env',
      `Authorization uses {prefix: 'Bearer ', env: '${AUTH_ENV}'}, which is unset; X-Raw is set.`,
      failure.message,
    );
  });

  const invalid = parseMcpYaml(`
version: 1
servers:
  http:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    headers:
      Authorization:
        prefix: 42
        env: ${AUTH_ENV}
`);

  assert.ok(invalid.ok);
  assert.equal(invalid.invalidServers.length, 1);
  assert.deepEqual(
    invalid.invalidServers.map((entry) => entry.serverId),
    ['http'],
  );
  assert.deepEqual(Object.keys(invalid.config.servers), []);
  diagnostic(
    'invalid-header-prefix',
    'http.headers.Authorization.prefix is number42 rather than a string.',
    invalid.invalidServers[0]!.errorText,
  );

  const disabled = parseMcpYaml(`
version: 1
servers:
  disabled_http:
    enabled: false
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
`);

  assert.ok(disabled.ok);
  assert.deepEqual(Object.keys(disabled.config.servers), []);
  assert.deepEqual(disabled.serverIdsInYamlOrder, ['disabled_http']);
  assert.deepEqual(disabled.validServerIdsInYamlOrder, []);
  assert.deepEqual(disabled.disabledServerIdsInYamlOrder, ['disabled_http']);

  const badEnabled = parseMcpYaml(`
version: 1
servers:
  bad_enabled:
    enabled: "false"
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
`);
  assert.ok(badEnabled.ok);
  assert.deepEqual(
    badEnabled.invalidServers.map((entry) => entry.serverId),
    ['bad_enabled'],
  );
  assert.deepEqual(Object.keys(badEnabled.config.servers), []);
  diagnostic(
    'invalid-enabled',
    'bad_enabled.enabled is the string "false" rather than a boolean.',
    badEnabled.invalidServers[0]!.errorText,
  );

  const invalidManual = parseMcpYaml(`
version: 1
servers:
  manual_bad:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    manual:
      sections: 42
`);
  assert.ok(invalidManual.ok);
  assert.deepEqual(
    invalidManual.invalidServers,
    [],
    'invalid optional manual declarations must not invalidate the MCP server config',
  );
  assert.equal(invalidManual.config.servers.manual_bad?.manual, undefined);

  const inlineManual = parseMcpYaml(`
version: 1
servers:
  manual_inline:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    manual:
      content: Inline guidance
      sections:
        UseCases: Use when needed
`);
  assert.ok(inlineManual.ok);
  assert.deepEqual(inlineManual.config.servers.manual_inline?.manual, {
    content: 'Inline guidance',
    sections: [{ title: 'UseCases', content: 'Use when needed' }],
  });

  const transforms = parseMcpYaml(`
version: 1
servers:
  scoped:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    transform:
      - prefix: global_
    tools:
      transform:
        - prefix: tool_
    prompts: {}
    resources:
      transform: []
      skills:
        enabled: true
        whitelist:
          - skill://*
        transform:
          - prefix: skill_
`);
  assert.ok(transforms.ok);
  const scopedCfg = transforms.config.servers.scoped;
  assert.ok(scopedCfg);
  assert.deepEqual(scopedCfg.transform, [{ kind: 'prefix_add', add: 'global_' }]);
  assert.deepEqual(scopedCfg.tools.transform, {
    kind: 'override',
    transform: [{ kind: 'prefix_add', add: 'tool_' }],
  });
  assert.deepEqual(scopedCfg.prompts.transform, { kind: 'inherit' });
  assert.deepEqual(scopedCfg.resources.transform, { kind: 'override', transform: [] });
  assert.deepEqual(scopedCfg.resources.skills.transform, {
    kind: 'override',
    transform: [{ kind: 'prefix_add', add: 'skill_' }],
  });
  assert.equal(
    applyMcpIdTransforms(
      'open',
      resolveMcpScopedTransforms(scopedCfg.transform, scopedCfg.tools.transform),
    ),
    'tool_open',
  );
  assert.equal(
    applyMcpIdTransforms(
      'prompt',
      resolveMcpScopedTransforms(scopedCfg.transform, scopedCfg.prompts.transform),
    ),
    'global_prompt',
  );
  assert.equal(
    applyMcpIdTransforms(
      'resource',
      resolveMcpScopedTransforms(scopedCfg.transform, scopedCfg.resources.transform),
    ),
    'resource',
  );
  assert.equal(
    applyMcpIdTransforms(
      'resource_skill',
      resolveMcpScopedTransforms(scopedCfg.transform, scopedCfg.resources.skills.transform),
    ),
    'skill_resource_skill',
  );

  const nestedSkillInheritsResource = parseMcpYaml(`
version: 1
servers:
  nested_skill:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    transform:
      - prefix: global_
    resources:
      transform:
        - prefix: resource_
      skills:
        enabled: true
`);
  assert.ok(nestedSkillInheritsResource.ok);
  const nestedSkillCfg = nestedSkillInheritsResource.config.servers.nested_skill;
  assert.ok(nestedSkillCfg);
  const resourceTransforms = resolveMcpScopedTransforms(
    nestedSkillCfg.transform,
    nestedSkillCfg.resources.transform,
  );
  assert.equal(applyMcpIdTransforms('uri', resourceTransforms), 'resource_uri');
  assert.equal(
    applyMcpIdTransforms(
      'uri',
      resolveMcpScopedTransforms(resourceTransforms, nestedSkillCfg.resources.skills.transform),
    ),
    'resource_uri',
  );

  const invalidNestedTransform = parseMcpYaml(`
version: 1
servers:
  bad_nested:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    prompts:
      transform:
        - suffix: 42
`);
  assert.ok(invalidNestedTransform.ok);
  assert.deepEqual(
    invalidNestedTransform.invalidServers.map((entry) => entry.serverId),
    ['bad_nested'],
  );
  assert.deepEqual(Object.keys(invalidNestedTransform.config.servers), []);
  diagnostic(
    'invalid-nested-transform',
    'bad_nested.prompts.transform[0].suffix is number42 rather than a valid suffix declaration.',
    invalidNestedTransform.invalidServers[0]!.errorText,
  );

  const unknownTransformEntry = parseMcpYaml(`
version: 1
servers:
  bad_transform_entry:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    transform:
      - replace: nope
`);
  assert.ok(unknownTransformEntry.ok);
  assert.deepEqual(
    unknownTransformEntry.invalidServers.map((entry) => entry.serverId),
    ['bad_transform_entry'],
  );
  assert.deepEqual(Object.keys(unknownTransformEntry.config.servers), []);
  diagnostic(
    'unknown-transform',
    'bad_transform_entry.transform[0] contains {replace: nope} and neither prefix nor suffix.',
    unknownTransformEntry.invalidServers[0]!.errorText,
  );

  await refreshMcpPromptResourceCatalog({
    serverId: 'scoped',
    client: makeCatalogClient(),
    transform: scopedCfg.transform,
    prompts: scopedCfg.prompts,
    resources: scopedCfg.resources,
  });
  try {
    assert.deepEqual(
      listMcpPrompts().map((prompt) => prompt.id),
      ['global_prompt_alpha'],
    );
    assert.deepEqual(
      listMcpResources().map((resource) => resource.id),
      ['resource_plain', 'skill_guide', 'template_item_id'].sort(),
    );
    assert.deepEqual(
      listMcpVirtualSkills().map((skill) => skill.id),
      ['skill_skill_guide'],
    );
  } finally {
    clearMcpPromptResourceCatalog();
  }

  await evidence.write();
  console.log('mcp config tests: ok');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
