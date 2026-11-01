import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws } from '../kernel-driver/helpers';

type Call = { id: string; name: string; args: Record<string, unknown> };
type Wire = { text?: string; calls?: Call[]; thinking?: boolean; invalidSse?: boolean };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function jsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return record(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}
function completion(model: string, supplied: Wire) {
  const calls = supplied.calls?.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  return {
    id: 'given-wire-completion',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        finish_reason: calls?.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: supplied.text ?? 'given-saying-data:1d37',
          ...(supplied.thinking !== false ? { reasoning_content: 'given-thinking-data:65b2' } : {}),
          ...(calls ? { tool_calls: calls } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}
async function main() {
  const evidence = semanticEvidenceCollector('dominds-live-probe-controls-');
  let recorded = false;
  try {
    await withTempRtws(async (rtws) => {
      // Nested tsx runners bind Unix sockets; keep their owned physical prefix short.
      const artifacts = await fs.mkdtemp(
        path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'lp-'),
      );
      console.log('Owned live-probe control artifacts: ' + artifacts);
      let completed = false;
      let plan: Wire[] = [];
      let requests: Record<string, unknown>[] = [];
      const peerErrors: unknown[] = [];
      const server = http.createServer((request, reply) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('error', (error) => {
          peerErrors.push(error);
          reply.destroy(error);
        });
        request.on('end', () => {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.ok(record(body));
            assert.equal(request.method, 'POST');
            assert.equal(request.url, '/v1/chat/completions');
            assert.equal(request.headers.authorization === 'Bearer given-local-probe-key', true);
            const response = plan[requests.length];
            requests.push(body);
            console.log(JSON.stringify({ control: 'peer-request', index: requests.length, body }));
            assert.ok(response, 'No unspecified request may be hidden by the controlled peer');
            assert.ok(body.model === 'given-primary' || body.model === 'given-secondary');
            if (body.stream === true) {
              reply.setHeader('content-type', 'text/event-stream');
              if (response.invalidSse) {
                reply.end('data: }\n\ndata: [DONE]\n\n');
                return;
              }
              const base = completion(String(body.model), response);
              const message = base.choices[0]!.message;
              const delta = {
                ...message,
                ...(message.tool_calls
                  ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
                  : {}),
              };
              const chunk = {
                id: base.id,
                object: 'chat.completion.chunk',
                created: 1,
                model: body.model,
                choices: [{ index: 0, delta, finish_reason: null }],
              };
              const finish = {
                ...chunk,
                choices: [{ index: 0, delta: {}, finish_reason: base.choices[0]!.finish_reason }],
                usage: base.usage,
              };
              reply.end(
                'data: ' +
                  JSON.stringify(chunk) +
                  '\n\ndata: ' +
                  JSON.stringify(finish) +
                  '\n\ndata: [DONE]\n\n',
              );
            } else {
              reply.setHeader('content-type', 'application/json');
              reply.end(JSON.stringify(completion(String(body.model), response)));
            }
          } catch (error: unknown) {
            peerErrors.push(error);
            reply.writeHead(500, { 'content-type': 'application/json' });
            reply.end('{"error":{"message":"Controlled peer request fixture failed"}}');
          }
        });
      });
      const listening = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await listening;
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const llmYaml = YAML.stringify({
        providers: {
          'given-peer': {
            name: 'Given local peer',
            apiType: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKeyEnvVar: 'DOMINDS_TEST_LIVE_PEER_KEY',
            models: {
              'given-primary': { supports_thinking: true },
              'given-secondary': { supports_thinking: true },
            },
          },
          'given-codex-profile': {
            name: 'Given unavailable managed profile',
            apiType: 'codex',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKeyEnvVar: 'DOMINDS_TEST_PROBE_AUTH_DIR',
            models: { 'given-primary': {} },
          },
        },
      });
      async function invoke(
        file: string,
        args: string[],
        supplied: Wire[],
        expectedExit: number,
        options: { credential?: boolean; readableProfile?: boolean; semanticId?: string } = {},
      ) {
        plan = supplied;
        requests = [];
        const child = spawn(
          process.execPath,
          [
            require.resolve('tsx/cli'),
            path.resolve(__dirname, '../cli.ts'),
            '--',
            '--isolated-rtws',
            'helpers/live-probe-worker.ts',
            JSON.stringify({
              llmYaml,
              credential: options.credential !== false,
              readableProfile: options.readableProfile === true,
            }),
            'provider/' + file,
            ...args,
          ],
          {
            cwd: rtws,
            env: {
              ...process.env,
              TMPDIR: artifacts,
              TEMP: artifacts,
              TMP: artifacts,
              DOMINDS_TEST_RTWS_KEEP_TMP: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });
        const [code, signal] = await once(child, 'close');
        const rows = jsonLines(stdout);
        await fs.writeFile(
          path.join(artifacts, (options.semanticId || file + '-' + expectedExit) + '.json'),
          JSON.stringify(
            { file, args, expectedExit, code, signal, stdout, stderr, requests },
            null,
            2,
          ) + '\n',
        );
        if (options.semanticId) {
          recorded = true;
          evidence.record({
            id: options.semanticId,
            scenario:
              'A real child CLI runs this registered probe with supplied flags and controlled local configuration.',
            businessValue:
              'An operator can select the intended test target and understand why no provider request was made or which explicit input must be corrected.',
            context: {
              file,
              args: JSON.stringify(args),
              expectedExit,
              actualExit: typeof code === 'number' ? code : -1,
              observedLocalRequests: requests.length,
              scope:
                'Native child CLI/preflight and a controlled localhost peer only; no paid vendor, genuine OAuth credentials, network routing, model behavior or semantic quality is established.',
            },
            reviewQuestions: [
              'Does the complete actual guidance accurately explain the supplied options/prerequisites and observed zero-request outcome without claiming a live test passed?',
            ],
            actualText: JSON.stringify({ stdout, stderr }, null, 2),
          });
        }
        if (code !== expectedExit || signal !== null) {
          process.stdout.write(stdout);
          process.stderr.write(stderr);
        }
        assert.equal(signal, null);
        assert.equal(code, expectedExit);
        assert.equal(requests.length, supplied.length);
        assert.deepEqual(peerErrors, []);
        const location = rows.find((row) => row.artifact === 'live-provider-observations');
        let observations: Record<string, unknown> | undefined;
        if (location) {
          assert.equal(typeof location.path, 'string');
          assert.ok(String(location.path).startsWith(artifacts + path.sep));
          const raw: unknown = JSON.parse(await fs.readFile(String(location.path), 'utf8'));
          assert.ok(record(raw));
          observations = raw;
          assert.equal(observations.semanticAcceptance, 'not-assessed');
        }
        return { rows, observations, requests: [...requests] };
      }
      const live = ['--live', '--provider', 'given-peer', '--model', 'given-primary'];
      const call = (name: string, args: Record<string, unknown>, id = 'given-call-id'): Wire => ({
        calls: [{ id, name, args }],
      });
      try {
        for (const [id, args, expected, options] of [
          ['no-live-flag', [], 77, {}],
          ['no-model-selection', ['--live', '--provider', 'given-peer'], 77, {}],
          ['missing-credential', live, 77, { credential: false }],
          [
            'missing-managed-profile',
            ['--live', '--provider', 'given-codex-profile', '--model', 'given-primary'],
            77,
            {},
          ],
          [
            'readable-profile-stream-only',
            ['--live', '--provider', 'given-codex-profile', '--model', 'given-primary'],
            77,
            { readableProfile: true },
          ],
          [
            'unknown-model-no-fallback',
            ['--live', '--provider', 'given-peer', '--model', 'unconfigured-model-data'],
            1,
            {},
          ],
          [
            'unknown-provider',
            ['--live', '--provider', 'unconfigured-provider-data', '--model', 'given-primary'],
            1,
            {},
          ],
          ['unknown-option', ['--unconfigured-option'], 1, {}],
          ['missing-option-value', ['--provider'], 1, {}],
          ['unsupported-extra-model', [...live, '--model', 'given-secondary'], 1, {}],
          ['probe-help', ['--help'], 0, {}],
        ] as const) {
          const file =
            id === 'readable-profile-stream-only' ? 'func-call.ts' : 'openai-streaming.ts';
          const observed = await invoke(file, [...args], [], expected, {
            ...options,
            semanticId: id,
          });
          if (expected === 77) {
            const prerequisite = observed.rows.filter((row) => row.status === 'skipped');
            assert.equal(prerequisite.length, 1);
            assert.equal(prerequisite[0]!.providerRequestAttempted, false);
            const expectedSkipCodes: Record<string, string> = {
              'no-live-flag': 'live_opt_in_required',
              'no-model-selection': 'model_selection_required',
              'missing-credential': 'credential_unavailable',
              'missing-managed-profile': 'managed_auth_file_unavailable',
              'readable-profile-stream-only': 'unsupported_request_mode',
            };
            assert.equal(prerequisite[0]!.code, expectedSkipCodes[id]);
          }
        }
        // CLI help is a successful documentation request, never an executed live transport case.
        const rootChild = spawn(
          process.execPath,
          [
            path.resolve(__dirname, '../run.mjs'),
            '--suite',
            'provider-live',
            '--case',
            'openai-streaming.ts',
            '--help',
          ],
          {
            cwd: rtws,
            env: { ...process.env, TMPDIR: artifacts, TEMP: artifacts, TMP: artifacts },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let rootStdout = '',
          rootStderr = '';
        rootChild.stdout.on('data', (data: Buffer) => {
          rootStdout += data.toString('utf8');
        });
        rootChild.stderr.on('data', (data: Buffer) => {
          rootStderr += data.toString('utf8');
        });
        const [rootCode, rootSignal] = await once(rootChild, 'close');
        assert.equal(rootSignal, null);
        assert.equal(rootCode, 1);
        assert.equal(requests.length, 0);
        const locator = jsonLines(rootStdout).find((row) => row.artifact === 'suite-summary');
        assert.ok(locator && typeof locator.path === 'string');
        const rootSummary: unknown = JSON.parse(await fs.readFile(locator.path, 'utf8'));
        assert.ok(record(rootSummary));
        assert.equal(rootSummary.passed, 0);
        assert.equal(rootSummary.failed, 1);
        assert.ok(Array.isArray(rootSummary.results));
        const admitted = rootSummary.results[0];
        assert.ok(record(admitted));
        assert.equal(admitted.code, 0);
        assert.ok(record(admitted.evidenceFailure));
        assert.equal(admitted.evidenceFailure.code, 'invalid_live_execution_evidence');
        assert.ok(typeof admitted.logPath === 'string');
        recorded = true;
        evidence.record({
          id: 'help-is-not-live-acceptance',
          scenario:
            'The native suite runner is asked to run a registered live entry with --help; its child prints documentation and exits0 without a provider request.',
          businessValue:
            'Help-only and no-op processes must not become passing vendor transport evidence.',
          context: {
            args: JSON.stringify([
              '--suite',
              'provider-live',
              '--case',
              'openai-streaming.ts',
              '--help',
            ]),
            suiteExitCode: 1,
            childExitCode: 0,
            passed: 0,
            failed: 1,
            observedLocalRequests: 0,
            scope:
              'Actual suite runner/child CLI and artifact-admission boundary; no real vendor request or OAuth authentication.',
          },
          reviewQuestions: [
            'Does the complete actual output and execution-evidence diagnostic accurately distinguish help from an executed live test without claiming provider coverage?',
          ],
          actualText: JSON.stringify(
            {
              suiteStdout: rootStdout,
              suiteStderr: rootStderr,
              childLog: await fs.readFile(admitted.logPath, 'utf8'),
              executionDiagnostic: admitted.evidenceFailure,
            },
            null,
            2,
          ),
        });
        for (const file of [
          'anthropic-streaming.ts',
          'openai-streaming.ts',
          'codex-streaming.ts',
        ]) {
          const observed = await invoke(file, live, [{}], 0);
          assert.ok(observed.observations);
        }
        const commands = [
          'ls -la',
          'find . -name "*.ts"',
          'grep -r "shell_cmd" . --include="*.ts"',
          'echo "test" > /tmp/test.txt && tail -f /tmp/test.txt',
        ];
        const payloads = [
          ...commands.map((value) => call('shell_cmd', { command: value })),
          call('stop_daemon', { pid: 12345 }),
        ];
        for (const file of ['func-call.ts', 'stream-func-call.ts']) {
          const observed = await invoke(file, live, payloads, 0);
          assert.ok(observed.observations);
          await invoke(
            file,
            live,
            Array.from({ length: 5 }, () => ({})),
            1,
          ); // A completed request with zero calls is not a passing payload case.
        }
        await invoke(
          'minimax-json-response.ts',
          live,
          [{ text: JSON.stringify({ game: 'given', year: 1, ok: true, traits: [], score: 2 }) }],
          0,
        );
        const both: Wire = {
          calls: [
            { id: 'given-call-a', name: 'tool_a', args: { value: 'A' } },
            { id: 'given-call-b', name: 'tool_b', args: { value: 'B' } },
          ],
        };
        for (const file of ['minimax-m27-multi-tool-probe.ts', 'openai-multi-tool-probe.ts']) {
          await invoke(file, live, [both], 0);
          await invoke(file, live, [{}], 1);
        }
        await invoke('minimax-m27-turn-assembly.ts', live, [{}], 0);
        await invoke(
          'volcengine-coding-plan-live-smoke.ts',
          [...live, '--reasoning-model', 'given-secondary'],
          [{}, call('tool_echo', { value: 'given-primary' }), {}, {}],
          0,
        );
        const alternating = await invoke(
          'volcengine-coding-plan-reasoning-live.ts',
          [...live, '--reasoning-model', 'given-secondary'],
          [{}, call('tool_echo', { value: 'phase1' }), {}],
          0,
        );
        const secondBody = alternating.requests[2]!;
        assert.ok(Array.isArray(secondBody.messages));
        const projected = secondBody.messages.filter(record);
        assert.ok(
          projected.some(
            (message) =>
              message.role === 'assistant' &&
              message.reasoning_content === 'given-thinking-data:65b2',
          ),
        );
        assert.ok(
          projected.some(
            (message) =>
              message.role === 'tool' &&
              message.tool_call_id === 'given-call-id' &&
              message.content === JSON.stringify({ value: 'phase1' }),
          ),
        );
        await invoke('openai-streaming.ts', live, [{ invalidSse: true }], 1);
        const incomplete = await invoke(
          'volcengine-coding-plan-reasoning-live.ts',
          [...live, '--reasoning-model', 'given-secondary'],
          [{ thinking: false }, { ...call('tool_echo', { value: 'phase1' }), thinking: false }],
          1,
        );
        assert.ok(Array.isArray(incomplete.observations?.results));
        const attempt = incomplete.observations.results.find(
          (row: unknown) => record(row) && row.id === 'alternating-thinking-tool-history',
        );
        assert.ok(record(attempt));
        assert.equal(attempt.secondRequestAttempted, false);
        completed = true;
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        if (completed && !process.argv.includes('--semantic'))
          await fs.rm(artifacts, { recursive: true, force: true });
      }
    });
  } finally {
    if (recorded) await evidence.write();
  }
  console.log(
    'Controlled native SDK/child CLI target gating, failure exit, payload fidelity and actual history replay: PASS',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
