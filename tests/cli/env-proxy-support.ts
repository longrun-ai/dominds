import assert from 'node:assert/strict';
import { configureEnvProxySupport } from '../../main/cli-runner';
const http = require('node:http') as typeof import('node:http') & {
  setGlobalProxyFromEnv: (env?: NodeJS.ProcessEnv) => void;
};

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const keys = [
    'DOMINDS_USE_ENV_PROXY',
    'NODE_USE_ENV_PROXY',
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'ALL_PROXY',
    'all_proxy',
  ];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const next = overrides[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    run();
  } finally {
    for (const key of keys) {
      const prev = previous.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

function main(): void {
  const original = http.setGlobalProxyFromEnv;
  assert.equal(
    typeof original,
    'function',
    'test requires http.setGlobalProxyFromEnv to exist in the running Node version',
  );

  try {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    http.setGlobalProxyFromEnv = (env?: NodeJS.ProcessEnv): void => {
      capturedEnv = env;
    };

    withEnv(
      {
        DOMINDS_USE_ENV_PROXY: undefined,
        NODE_USE_ENV_PROXY: 'keep-me',
        http_proxy: 'http://proxy.example.com:8080',
        https_proxy: 'http://proxy.example.com:8443',
        no_proxy: 'localhost,127.0.0.1',
      },
      () => {
        configureEnvProxySupport();
        assert.equal(process.env.NODE_USE_ENV_PROXY, 'keep-me');
        assert.ok(capturedEnv);
        assert.equal(capturedEnv?.http_proxy, 'http://proxy.example.com:8080');
        assert.equal(capturedEnv?.https_proxy, 'http://proxy.example.com:8443');
        assert.equal(capturedEnv?.no_proxy, 'localhost,127.0.0.1');
      },
    );

    withEnv(
      {
        DOMINDS_USE_ENV_PROXY: '0',
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: 'http://proxy.example.com:8080',
      },
      () => {
        capturedEnv = undefined;
        configureEnvProxySupport();
        assert.equal(process.env.NODE_USE_ENV_PROXY, '1');
        assert.equal(capturedEnv, undefined);
      },
    );
  } finally {
    http.setGlobalProxyFromEnv = original;
  }

  console.log('env proxy support tests: ok');
}

main();
