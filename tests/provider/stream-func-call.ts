#!/usr/bin/env node

/**
 * Streaming function call test script for Codex (streaming-only generator).
 *
 * Usage:
 *   pnpm tsx --tsconfig tests/tsconfig.json tests/provider/stream-func-call.ts
 *   pnpm tsx --tsconfig tests/tsconfig.json tests/provider/stream-func-call.ts --provider codex --model gpt-5.2-codex
 */

import type { Dialog } from 'dominds/dialog';
import { ChatMessage, LlmConfig, type ProviderConfig } from 'dominds/llm/client';
import type { LlmGenerator, LlmStreamReceiver } from 'dominds/llm/gen';
import { getLlmGenerator } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';
import type { FuncTool, ToolArguments } from 'dominds/tool';

type Scenario =
  | {
      kind: 'shell_cmd';
      name: string;
      description: string;
      prompt: string;
      expectedCommand: string;
      mustInclude: string[];
    }
  | {
      kind: 'stop_daemon';
      name: string;
      description: string;
      prompt: string;
      expectedPid: number;
    };

type ParsedArgs =
  | {
      kind: 'shell_cmd';
      command: string;
      keys: string[];
    }
  | {
      kind: 'stop_daemon';
      pid: number;
      keys: string[];
    };

type FuncCallCapture = {
  callId: string;
  name: string;
  argumentsJson: string;
};

type TestOutcome =
  | {
      status: 'passed';
      scenario: string;
      functionCall: FuncCallCapture;
      parsedArgs: ParsedArgs;
      unexpectedArgs: string[];
    }
  | {
      status: 'failed';
      scenario: string;
      error: string;
      functionCall: FuncCallCapture | null;
      parsedArgs: ParsedArgs | null;
      unexpectedArgs: string[];
    };

type TesterState =
  | { status: 'uninitialized' }
  | {
      status: 'ready';
      providerConfig: ProviderConfig;
      generator: LlmGenerator;
      agent: Team.Member;
    };

type CliParseResult =
  | { status: 'ok'; provider: string; model: string }
  | { status: 'error'; message: string };

const scenarios: Scenario[] = [
  {
    kind: 'shell_cmd',
    name: 'Scenario 1: ls command',
    description: 'Test basic ls command execution',
    prompt:
      'Use your shell command tool to list all files in the current directory with details (run `ls -la`).',
    expectedCommand: 'ls -la',
    mustInclude: ['ls', '-la'],
  },
  {
    kind: 'shell_cmd',
    name: 'Scenario 2: find command',
    description: 'Test find command execution',
    prompt:
      'Use your shell command tool to search for TypeScript files in the current directory (run `find . -name "*.ts"`).',
    expectedCommand: 'find . -name "*.ts"',
    mustInclude: ['find', '.ts'],
  },
  {
    kind: 'shell_cmd',
    name: 'Scenario 3: grep command',
    description: 'Test content search with grep',
    prompt:
      'Use your shell command tool to search for "shell_cmd" in TypeScript files (run `grep -r "shell_cmd" . --include="*.ts"`).',
    expectedCommand: 'grep -r "shell_cmd" . --include="*.ts"',
    mustInclude: ['grep', 'shell_cmd', '.ts'],
  },
  {
    kind: 'shell_cmd',
    name: 'Scenario 4: daemon creation',
    description: 'Test daemon process creation',
    prompt:
      'Create a test file and start a daemon process by running `echo "test" > /tmp/test.txt && tail -f /tmp/test.txt`',
    expectedCommand: 'echo "test" > /tmp/test.txt && tail -f /tmp/test.txt',
    mustInclude: ['tail', '-f', '/tmp/'],
  },
  {
    kind: 'stop_daemon',
    name: 'Scenario 5: stop daemon',
    description: 'Test daemon termination',
    prompt: 'Use your daemon-stop tool to terminate the process with PID 12345',
    expectedPid: 12345,
  },
];

class StreamingFunctionCallTester {
  private readonly provider: string;
  private readonly model: string;
  private state: TesterState = { status: 'uninitialized' };

  constructor(provider: string, model: string) {
    this.provider = provider;
    this.model = model;
  }

  async initialize(): Promise<void> {
    console.log(`Initializing function call streaming test for ${this.provider}:${this.model}`);

    const llmConfig = await LlmConfig.load();
    const providerConfig = llmConfig.getProvider(this.provider);
    if (!providerConfig) {
      throw new Error(`Provider '${this.provider}' not found in configuration`);
    }

    if (!Object.prototype.hasOwnProperty.call(providerConfig.models, this.model)) {
      const modelNames = Object.keys(providerConfig.models);
      throw new Error(
        `Model '${this.model}' not found for provider '${this.provider}'. Available: ${modelNames.join(', ')}`,
      );
    }

    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) {
      console.warn(
        `Warning: API key environment variable '${providerConfig.apiKeyEnvVar}' is not set.`,
      );
      console.warn(
        'Running in diagnostic mode - function calls will be detected but not executed.',
      );
    }

    const generator = getLlmGenerator(providerConfig.apiType);
    if (!generator) {
      throw new Error(`Generator for '${providerConfig.apiType}' not found`);
    }

    const agent = new Team.Member({
      id: 'cmdr',
      name: 'Commander',
      model: this.model,
    });

    this.state = { status: 'ready', providerConfig, generator, agent };
    console.log(`Initialized ${this.provider}:${this.model} with @cmdr agent`);
  }

  private getSystemPrompt(): string {
    return `You are @cmdr, the Commander agent responsible for shell command execution.

Your capabilities:
- Execute shell commands using the shell_cmd function
- Manage daemon processes with stop_daemon function
- Provide detailed output with proper error handling

When given instructions:
1. Use shell_cmd function for command execution
2. Use stop_daemon function to terminate processes
3. Provide clear, informative responses
4. Handle errors gracefully

Remember: You are operating in workspace ${process.cwd()}`;
  }

  private getFunctionTools(): FuncTool[] {
    const shellCmdTool: FuncTool = {
      type: 'func',
      name: 'shell_cmd',
      description: 'Execute shell commands',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      call: async (_dlg: Dialog, _caller: Team.Member, _args: ToolArguments): Promise<string> => {
        return 'shell_cmd execution skipped in streaming test';
      },
    };

    const stopDaemonTool: FuncTool = {
      type: 'func',
      name: 'stop_daemon',
      description: 'Stop a daemon process',
      parameters: {
        type: 'object',
        properties: {
          pid: {
            type: 'number',
            description: 'Process ID of the daemon to stop',
          },
        },
        required: ['pid'],
        additionalProperties: false,
      },
      call: async (_dlg: Dialog, _caller: Team.Member, _args: ToolArguments): Promise<string> => {
        return 'stop_daemon execution skipped in streaming test';
      },
    };

    return [shellCmdTool, stopDaemonTool];
  }

  async testScenario(scenario: Scenario, genseq: number): Promise<TestOutcome> {
    if (this.state.status !== 'ready') {
      return {
        status: 'failed',
        scenario: scenario.name,
        error: 'Tester is not initialized',
        functionCall: null,
        parsedArgs: null,
        unexpectedArgs: [],
      };
    }

    console.log(`\nTesting scenario: ${scenario.name}`);
    console.log(`Prompt: ${scenario.prompt}`);

    const context: ChatMessage[] = [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq,
        msgId: `stream-func-call-${genseq}`,
        content: scenario.prompt,
        grammar: 'texting',
      },
    ];

    const functionCalls: FuncCallCapture[] = [];
    const receiver: LlmStreamReceiver = {
      thinkingStart: async () => {},
      thinkingChunk: async () => {},
      thinkingFinish: async () => {},
      sayingStart: async () => {},
      sayingChunk: async () => {},
      sayingFinish: async () => {},
      funcCall: async (callId: string, name: string, args: string) => {
        functionCalls.push({ callId, name, argumentsJson: args });
      },
    };

    try {
      await this.state.generator.genToReceiver(
        this.state.providerConfig,
        this.state.agent,
        this.getSystemPrompt(),
        this.getFunctionTools(),
        context,
        receiver,
        genseq,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        scenario: scenario.name,
        error: message,
        functionCall: null,
        parsedArgs: null,
        unexpectedArgs: [],
      };
    }

    if (functionCalls.length === 0) {
      return {
        status: 'failed',
        scenario: scenario.name,
        error: 'No function call was made',
        functionCall: null,
        parsedArgs: null,
        unexpectedArgs: [],
      };
    }

    if (functionCalls.length > 1) {
      console.warn(`Warning: multiple function calls detected (${functionCalls.length})`);
    }

    const functionCall = functionCalls[0];
    const expectedFunctionName = scenario.kind === 'shell_cmd' ? 'shell_cmd' : 'stop_daemon';
    if (functionCall.name !== expectedFunctionName) {
      return {
        status: 'failed',
        scenario: scenario.name,
        error: `Expected function '${expectedFunctionName}', got '${functionCall.name}'`,
        functionCall,
        parsedArgs: null,
        unexpectedArgs: [],
      };
    }

    // LLM outputs are untrusted; runtime validation is required before using fields.
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(functionCall.argumentsJson);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        scenario: scenario.name,
        error: `Function arguments are not valid JSON: ${message}`,
        functionCall,
        parsedArgs: null,
        unexpectedArgs: [],
      };
    }

    if (
      typeof parsedUnknown !== 'object' ||
      parsedUnknown === null ||
      Array.isArray(parsedUnknown)
    ) {
      return {
        status: 'failed',
        scenario: scenario.name,
        error: 'Function arguments must be a JSON object',
        functionCall,
        parsedArgs: null,
        unexpectedArgs: [],
      };
    }

    const argsRecord = parsedUnknown as Record<string, unknown>;
    const argKeys = Object.keys(argsRecord);

    switch (scenario.kind) {
      case 'shell_cmd': {
        if (!('command' in argsRecord)) {
          return {
            status: 'failed',
            scenario: scenario.name,
            error: 'Missing required argument: command',
            functionCall,
            parsedArgs: null,
            unexpectedArgs: [],
          };
        }

        const commandValue = argsRecord.command;
        if (typeof commandValue !== 'string') {
          return {
            status: 'failed',
            scenario: scenario.name,
            error: 'Command argument must be a string',
            functionCall,
            parsedArgs: null,
            unexpectedArgs: [],
          };
        }

        for (const requiredToken of scenario.mustInclude) {
          if (!commandValue.includes(requiredToken)) {
            return {
              status: 'failed',
              scenario: scenario.name,
              error: `Command must include '${requiredToken}'`,
              functionCall,
              parsedArgs: null,
              unexpectedArgs: [],
            };
          }
        }

        if (commandValue !== scenario.expectedCommand) {
          return {
            status: 'failed',
            scenario: scenario.name,
            error: `Command mismatch: expected '${scenario.expectedCommand}', got '${commandValue}'`,
            functionCall,
            parsedArgs: { kind: 'shell_cmd', command: commandValue, keys: argKeys },
            unexpectedArgs: [],
          };
        }

        const unexpectedArgs = argKeys.filter((key) => key !== 'command');
        return {
          status: 'passed',
          scenario: scenario.name,
          functionCall,
          parsedArgs: { kind: 'shell_cmd', command: commandValue, keys: argKeys },
          unexpectedArgs,
        };
      }
      case 'stop_daemon': {
        if (!('pid' in argsRecord)) {
          return {
            status: 'failed',
            scenario: scenario.name,
            error: 'Missing required argument: pid',
            functionCall,
            parsedArgs: null,
            unexpectedArgs: [],
          };
        }

        const pidValue = argsRecord.pid;
        if (typeof pidValue !== 'number' || !Number.isFinite(pidValue)) {
          return {
            status: 'failed',
            scenario: scenario.name,
            error: 'PID argument must be a finite number',
            functionCall,
            parsedArgs: null,
            unexpectedArgs: [],
          };
        }

        if (pidValue <= 0) {
          return {
            status: 'failed',
            scenario: scenario.name,
            error: 'PID must be a positive number',
            functionCall,
            parsedArgs: null,
            unexpectedArgs: [],
          };
        }

        if (pidValue !== scenario.expectedPid) {
          return {
            status: 'failed',
            scenario: scenario.name,
            error: `PID mismatch: expected ${scenario.expectedPid}, got ${pidValue}`,
            functionCall,
            parsedArgs: { kind: 'stop_daemon', pid: pidValue, keys: argKeys },
            unexpectedArgs: [],
          };
        }

        const unexpectedArgs = argKeys.filter((key) => key !== 'pid');
        return {
          status: 'passed',
          scenario: scenario.name,
          functionCall,
          parsedArgs: { kind: 'stop_daemon', pid: pidValue, keys: argKeys },
          unexpectedArgs,
        };
      }
      default: {
        const _exhaustive: never = scenario;
        return {
          status: 'failed',
          scenario: 'unknown',
          error: `Unhandled scenario: ${String(_exhaustive)}`,
          functionCall: null,
          parsedArgs: null,
          unexpectedArgs: [],
        };
      }
    }
  }

  async runAllTests(): Promise<void> {
    if (this.state.status !== 'ready') {
      throw new Error('Tester is not initialized');
    }

    console.log(`Running streaming function call tests for ${this.provider}:${this.model}`);
    console.log(`Workspace: ${process.cwd()}`);

    let passedTests = 0;
    const totalTests = scenarios.length;
    const results: TestOutcome[] = [];

    for (let i = 0; i < scenarios.length; i += 1) {
      const scenario = scenarios[i];
      const result = await this.testScenario(scenario, i + 1);
      results.push(result);
      if (result.status === 'passed') {
        passedTests += 1;
      }
      console.log(`Progress: ${passedTests}/${totalTests} tests passed`);
    }

    console.log('\nFinal Results:');
    console.log(`Passed: ${passedTests}/${totalTests}`);
    console.log(`Failed: ${totalTests - passedTests}/${totalTests}`);

    console.log('\nDetailed Results:');
    results.forEach((result, index) => {
      const statusLabel = result.status === 'passed' ? 'PASS' : 'FAIL';
      console.log(`  ${index + 1}. ${statusLabel} ${result.scenario}`);
      switch (result.status) {
        case 'passed':
          console.log(`     Function: ${result.functionCall.name}`);
          console.log(`     Arguments: ${result.functionCall.argumentsJson}`);
          if (result.unexpectedArgs.length > 0) {
            console.log(`     Warning: unexpected args: ${result.unexpectedArgs.join(', ')}`);
          }
          return;
        case 'failed':
          if (result.functionCall) {
            console.log(`     Function: ${result.functionCall.name}`);
            console.log(`     Arguments: ${result.functionCall.argumentsJson}`);
          }
          console.log(`     Error: ${result.error}`);
          if (result.unexpectedArgs.length > 0) {
            console.log(`     Warning: unexpected args: ${result.unexpectedArgs.join(', ')}`);
          }
          return;
        default: {
          const _exhaustive: never = result;
          throw new Error(`Unhandled test outcome: ${String(_exhaustive)}`);
        }
      }
    });

    if (passedTests === totalTests) {
      console.log('\nAll tests passed. Streaming function calls look correct.');
    } else {
      console.log('\nSome tests failed. Check the errors above for details.');
    }
  }
}

function parseArgs(args: string[]): CliParseResult {
  let provider = 'codex';
  let model = 'gpt-5.2-codex';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--provider') {
      if (i + 1 >= args.length) {
        return { status: 'error', message: 'Missing value for --provider' };
      }
      provider = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--model') {
      if (i + 1 >= args.length) {
        return { status: 'error', message: 'Missing value for --model' };
      }
      model = args[i + 1];
      i += 1;
      continue;
    }
    return { status: 'error', message: `Unknown argument: ${arg}` };
  }

  return { status: 'ok', provider, model };
}

async function main(): Promise<void> {
  const parseResult = parseArgs(process.argv.slice(2));
  const usage =
    'Usage: pnpm tsx --tsconfig tests/tsconfig.json tests/provider/stream-func-call.ts [--provider <provider>] [--model <model>]';

  switch (parseResult.status) {
    case 'error':
      console.error(parseResult.message);
      console.error(usage);
      process.exit(1);
    case 'ok': {
      const tester = new StreamingFunctionCallTester(parseResult.provider, parseResult.model);
      await tester.initialize();
      await tester.runAllTests();
      return;
    }
    default: {
      const _exhaustive: never = parseResult;
      throw new Error(`Unhandled parse result: ${String(_exhaustive)}`);
    }
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
