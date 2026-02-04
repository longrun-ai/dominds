#!/usr/bin/env node

/**
 * Function Call Test Script for @operator Agent
 *
 * Tests LLM function calling capability with comprehensive argument validation
 * using shell command tools with scenarios from docs/e2e-story-test/basics/cmds.md
 *
 * Features:
 * - Uses non-streaming mode for function call verification
 * - Verifies required arguments are passed correctly from LLM
 * - Validates argument types and reasonable values
 * - Checks exact argument matching against expected values
 * - Provides detailed failure analysis and debugging information
 *
 * Usage: pnpm -C tests run func-call -- --provider <provider> --model <model>
 *
 * Examples:
 *   pnpm -C tests run func-call -- --provider iflow.cn --model kimi-k2-0905
 *   pnpm -C tests run func-call -- --provider minimaxi.com-coding-plan --model MiniMax-M2
 *   pnpm -C tests run func-call -- --provider bigmodel --model glm-4.6
 *
 * Validation includes:
 * - Required argument presence checks
 * - JSON parsing verification
 * - Custom business logic validation (command patterns, PID validation, etc.)
 * - Exact value matching against expected arguments
 */

import type { Dialog } from 'dominds/dialog';
import { ChatMessage, FuncCallMsg, LlmConfig, type ProviderConfig } from 'dominds/llm/client';
import type { LlmGenerator } from 'dominds/llm/gen';
import { generatorsRegistry } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';
import type { FuncTool, JsonObject, ToolArguments } from 'dominds/tool';

type ArgValidationResult = { valid: boolean; error?: string };

interface TestScenario {
  name: string;
  description: string;
  prompt: string;
  expectedFunctionCall: string;
  expectedArgs?: JsonObject;
  argValidation?: (args: JsonObject) => ArgValidationResult;
}

type ParsedArgsResult = { ok: true; value: JsonObject } | { ok: false; error: string };

function isJsonObject(value: unknown): value is JsonObject {
  // LLM function args are untrusted JSON; validate shape before using properties.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): ParsedArgsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, error: 'Function arguments must be a JSON object' };
  }
  return { ok: true, value: parsed };
}

function summarizeMessage(msg: ChatMessage): {
  type: ChatMessage['type'];
  role: ChatMessage['role'];
  name?: string;
} {
  switch (msg.type) {
    case 'func_call_msg':
    case 'func_result_msg':
      return { type: msg.type, role: msg.role, name: msg.name };
    default:
      return { type: msg.type, role: msg.role };
  }
}

class FunctionCallTester {
  private provider: string;
  private model: string;
  private llmConfig: LlmConfig | null = null;
  private providerConfig: ProviderConfig | null = null;
  private generator: LlmGenerator | null = null;
  private agent: Team.Member | null = null;

  constructor(provider: string, model: string) {
    this.provider = provider;
    this.model = model;
  }

  private getInitializedState(): {
    providerConfig: ProviderConfig;
    generator: LlmGenerator;
    agent: Team.Member;
  } {
    if (!this.providerConfig || !this.generator || !this.agent) {
      throw new Error('FunctionCallTester is not initialized');
    }
    return {
      providerConfig: this.providerConfig,
      generator: this.generator,
      agent: this.agent,
    };
  }

  async initialize(): Promise<void> {
    console.log(`🔧 Initializing function call test for ${this.provider}:${this.model}`);

    // Load LLM configuration
    const llmConfig = await LlmConfig.load();
    this.llmConfig = llmConfig;
    const providerConfig = llmConfig.getProvider(this.provider);

    if (!providerConfig) {
      throw new Error(`Provider '${this.provider}' not found in configuration`);
    }
    this.providerConfig = providerConfig;

    // Check if API key is available
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) {
      console.warn(
        `⚠️  Warning: API key environment variable '${providerConfig.apiKeyEnvVar}' is not set`,
      );
      console.warn(
        `   Running in diagnostic mode - function calls will be detected but not executed`,
      );
    }

    // Get the appropriate generator
    const generator = generatorsRegistry.get(providerConfig.apiType);
    if (!generator) {
      throw new Error(`Generator for '${providerConfig.apiType}' not found`);
    }
    this.generator = generator;

    // Create @operator agent with shell command tools
    this.agent = new Team.Member({
      id: 'operator',
      name: 'Operator',
      model: this.model,
    });

    console.log(`✅ Initialized ${this.provider}:${this.model} with @operator agent`);
  }

  private getSystemPrompt(): string {
    return `You are @operator, an agent responsible for shell command execution.

Your capabilities:
- Execute shell commands using the shell_cmd function
- Manage daemon processes with stop_daemon function
- Provide detailed output with proper error handling

When given instructions:
1. Use shell_cmd function for command execution
2. Use stop_daemon function to terminate processes
3. Provide clear, informative responses
4. Handle errors gracefully

Remember: You are operating in rtws (runtime workspace) ${process.cwd()}`;
  }

  private getFunctionTools(): FuncTool[] {
    // Return tool schemas for function calling (execution is not needed for this test).
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
        return 'shell_cmd execution skipped in test';
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
        return 'stop_daemon execution skipped in test';
      },
    };

    return [shellCmdTool, stopDaemonTool];
  }

  async testFunctionCall(
    scenario: TestScenario,
  ): Promise<{ success: boolean; functionCall?: FuncCallMsg; error?: string }> {
    console.log(`\n🧪 Testing scenario: ${scenario.name}`);
    console.log(`📝 Prompt: ${scenario.prompt}`);

    try {
      const genseq = 1;
      const context: ChatMessage[] = [
        {
          type: 'prompting_msg',
          role: 'user',
          genseq,
          msgId: `func-call-${scenario.name}`,
          content: scenario.prompt,
          grammar: 'tellask',
        },
      ];

      const functionTools = this.getFunctionTools();
      const systemPrompt = this.getSystemPrompt();
      const { providerConfig, generator, agent } = this.getInitializedState();

      console.log(`🎯 Expected function call: ${scenario.expectedFunctionCall}`);
      if (scenario.expectedArgs) {
        console.log(`📋 Expected arguments:`, JSON.stringify(scenario.expectedArgs, null, 2));
      }

      let functionCall: FuncCallMsg | null = null;

      console.log(`🔄 Starting LLM non-streaming processing...`);

      // Use non-streaming mode for function call verification
      const messages = await generator.genMoreMessages(
        providerConfig,
        agent,
        systemPrompt,
        functionTools,
        context,
        genseq,
      );

      console.log(`📊 Non-streaming processing complete: ${messages.length} messages returned`);

      // Find the first function call in the returned messages
      const maybeFunctionCall = messages.find(
        (msg): msg is FuncCallMsg => msg.type === 'func_call_msg',
      );
      functionCall = maybeFunctionCall ?? null;

      if (functionCall) {
        console.log(`📞 Function call detected: ${functionCall.name}`);
        console.log(`📋 Function: ${functionCall.name}`);
        console.log(`📋 Arguments: ${functionCall.arguments}`);
      } else {
        console.log(`❌ No function call found in returned messages`);
        console.log(
          `📝 Returned messages:`,
          messages.map((m) => summarizeMessage(m)),
        );
        return { success: false, error: 'No function call was made' };
      }

      // Step 1: Validate function name
      const functionNameValid = functionCall.name === scenario.expectedFunctionCall;
      if (!functionNameValid) {
        console.log(
          `❌ Function name validation failed: expected ${scenario.expectedFunctionCall}, got ${functionCall.name}`,
        );
        return {
          success: false,
          error: `Unexpected function call: expected ${scenario.expectedFunctionCall}, got ${functionCall.name}`,
          functionCall,
        };
      }

      // Step 2: Parse and validate arguments
      let parsedArgs: JsonObject = {};
      if (functionCall.arguments) {
        const parsedResult = parseJsonObject(functionCall.arguments);
        if (!parsedResult.ok) {
          console.log(`❌ Failed to parse function arguments as JSON:`, functionCall.arguments);
          return {
            success: false,
            error: `Function arguments are not valid JSON: ${parsedResult.error}`,
            functionCall,
          };
        }
        parsedArgs = parsedResult.value;
      }
      console.log(`📋 Parsed arguments:`, JSON.stringify(parsedArgs, null, 2));

      // Step 3: Validate required arguments
      const requiredArgs = scenario.expectedArgs ? Object.keys(scenario.expectedArgs) : [];
      const missingArgs: string[] = [];
      const unexpectedArgs: string[] = [];

      for (const requiredArg of requiredArgs) {
        if (!(requiredArg in parsedArgs)) {
          missingArgs.push(requiredArg);
        }
      }

      for (const parsedArg of Object.keys(parsedArgs)) {
        if (!requiredArgs.includes(parsedArg)) {
          unexpectedArgs.push(parsedArg);
        }
      }

      // Step 4: Apply custom validation if provided
      let customValidationPassed = true;
      let customValidationError = '';

      if (scenario.argValidation) {
        const validationResult = scenario.argValidation(parsedArgs);
        customValidationPassed = validationResult.valid;
        customValidationError = validationResult.error || '';
      }

      // Step 5: Check for exact match with expected arguments
      let exactMatch = true;
      const argumentDifferences: string[] = [];

      if (scenario.expectedArgs) {
        for (const [key, expectedValue] of Object.entries(scenario.expectedArgs)) {
          if (!(key in parsedArgs)) {
            exactMatch = false;
            argumentDifferences.push(`Missing argument: ${key}`);
          } else if (parsedArgs[key] !== expectedValue) {
            exactMatch = false;
            argumentDifferences.push(
              `Argument ${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(parsedArgs[key])}`,
            );
          }
        }
      }

      // Determine overall test result
      const allValidationsPassed =
        functionNameValid && missingArgs.length === 0 && customValidationPassed && exactMatch;

      if (allValidationsPassed) {
        console.log(
          `✅ Test passed: ${scenario.name} (function call detected: ${functionCall.name})`,
        );
        console.log(`   ✅ Function name validation passed`);
        console.log(`   ✅ Required arguments present: ${requiredArgs.join(', ') || 'none'}`);
        console.log(`   ✅ Argument validation passed`);
        console.log(`   ✅ Exact argument match`);
        return { success: true, functionCall };
      } else {
        console.log(`❌ Test failed: ${scenario.name}`);
        if (!functionNameValid) {
          console.log(
            `   ❌ Function name: expected ${scenario.expectedFunctionCall}, got ${functionCall.name}`,
          );
        }
        if (missingArgs.length > 0) {
          console.log(`   ❌ Missing required arguments: ${missingArgs.join(', ')}`);
        }
        if (unexpectedArgs.length > 0) {
          console.log(`   ⚠️  Unexpected arguments: ${unexpectedArgs.join(', ')}`);
        }
        if (!customValidationPassed) {
          console.log(`   ❌ Custom argument validation failed: ${customValidationError}`);
        }
        if (!exactMatch) {
          console.log(`   ❌ Argument differences:`);
          argumentDifferences.forEach((diff) => console.log(`      - ${diff}`));
        }

        const errorMessages = [];
        if (!functionNameValid) errorMessages.push(`Function name mismatch`);
        if (missingArgs.length > 0)
          errorMessages.push(`Missing arguments: ${missingArgs.join(', ')}`);
        if (!customValidationPassed)
          errorMessages.push(`Custom validation failed: ${customValidationError}`);
        if (!exactMatch)
          errorMessages.push(`Argument differences: ${argumentDifferences.join('; ')}`);

        return {
          success: false,
          error: errorMessages.join('; '),
          functionCall,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`💥 Test error: ${message}`);
      return { success: false, error: message };
    }
  }

  async runAllTests(): Promise<void> {
    console.log(`🚀 Starting function call tests for ${this.provider}:${this.model}`);
    console.log(`📁 rtws: ${process.cwd()}`);

    const scenarios: TestScenario[] = [
      {
        name: 'Scenario 1: ls command',
        description: 'Test basic ls command execution',
        prompt:
          'Use your shell command tool to list all files in the current directory with details (run `ls -la`).',
        expectedFunctionCall: 'shell_cmd',
        expectedArgs: { command: 'ls -la' },
        argValidation: (args) => {
          const commandValue = args.command;
          if (typeof commandValue !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!commandValue.includes('ls')) {
            return { valid: false, error: 'Command should contain ls' };
          }
          if (!commandValue.includes('-la')) {
            return { valid: false, error: 'Command should include -la flag for detailed listing' };
          }
          return { valid: true };
        },
      },
      {
        name: 'Scenario 2: find command',
        description: 'Test find command execution',
        prompt:
          'Use your shell command tool to search for TypeScript files in the current directory (run `find . -name "*.ts"`).',
        expectedFunctionCall: 'shell_cmd',
        expectedArgs: { command: 'find . -name "*.ts"' },
        argValidation: (args) => {
          const commandValue = args.command;
          if (typeof commandValue !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!commandValue.includes('find')) {
            return { valid: false, error: 'Command should contain find' };
          }
          if (!commandValue.includes('.ts')) {
            return { valid: false, error: 'Command should search for .ts files' };
          }
          return { valid: true };
        },
      },
      {
        name: 'Scenario 3: grep command',
        description: 'Test content search with grep',
        prompt:
          'Use your shell command tool to search for "shell_cmd" in TypeScript files (run `grep -r "shell_cmd" . --include="*.ts"`).',
        expectedFunctionCall: 'shell_cmd',
        expectedArgs: { command: 'grep -r "shell_cmd" . --include="*.ts"' },
        argValidation: (args) => {
          const commandValue = args.command;
          if (typeof commandValue !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!commandValue.includes('grep')) {
            return { valid: false, error: 'Command should contain grep' };
          }
          if (!commandValue.includes('shell_cmd')) {
            return { valid: false, error: 'Command should search for "shell_cmd"' };
          }
          if (!commandValue.includes('.ts')) {
            return { valid: false, error: 'Command should include TypeScript files' };
          }
          return { valid: true };
        },
      },
      {
        name: 'Scenario 4: daemon creation',
        description: 'Test daemon process creation',
        prompt:
          'Create a test file and start a daemon process by running `echo "test" > /tmp/test.txt && tail -f /tmp/test.txt`',
        expectedFunctionCall: 'shell_cmd',
        expectedArgs: { command: 'echo "test" > /tmp/test.txt && tail -f /tmp/test.txt' },
        argValidation: (args) => {
          const commandValue = args.command;
          if (typeof commandValue !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!commandValue.includes('tail') || !commandValue.includes('-f')) {
            return { valid: false, error: 'Command should include tail -f for daemon process' };
          }
          if (!commandValue.includes('/tmp/')) {
            return { valid: false, error: 'Command should use /tmp/ path for daemon' };
          }
          return { valid: true };
        },
      },
      {
        name: 'Scenario 5: stop daemon',
        description: 'Test daemon termination',
        prompt: 'Use your daemon-stop tool to terminate the process with PID 12345',
        expectedFunctionCall: 'stop_daemon',
        expectedArgs: { pid: 12345 },
        argValidation: (args) => {
          const pidValue = args.pid;
          if (typeof pidValue !== 'number') {
            return { valid: false, error: 'PID argument must be a number' };
          }
          if (pidValue <= 0) {
            return { valid: false, error: 'PID must be a positive number' };
          }
          return { valid: true };
        },
      },
    ];

    let passedTests = 0;
    let totalTests = scenarios.length;
    let functionNameFailures = 0;
    let argumentValidationFailures = 0;
    let missingArgumentFailures = 0;
    let jsonParsingFailures = 0;

    const detailedResults: Array<{
      scenario: string;
      success: boolean;
      error?: string;
      functionName?: string;
      parsedArgs?: JsonObject | null;
    }> = [];

    for (const scenario of scenarios) {
      const testResult = await this.testFunctionCall(scenario);

      // Track specific failure types
      if (!testResult.success) {
        if (testResult.error?.includes('Function name mismatch')) {
          functionNameFailures++;
        } else if (
          testResult.error?.includes('Missing arguments') ||
          testResult.error?.includes('Custom validation failed') ||
          testResult.error?.includes('Argument differences')
        ) {
          argumentValidationFailures++;
        } else if (testResult.error?.includes('not valid JSON')) {
          jsonParsingFailures++;
        }

        // Count missing arguments specifically
        if (testResult.error?.includes('Missing required arguments')) {
          missingArgumentFailures++;
        }
      } else {
        passedTests++;
      }

      // Store detailed results for reporting
      const parsedArgsResult = testResult.functionCall?.arguments
        ? parseJsonObject(testResult.functionCall.arguments)
        : null;

      detailedResults.push({
        scenario: scenario.name,
        success: testResult.success,
        error: testResult.error,
        functionName: testResult.functionCall?.name,
        parsedArgs: parsedArgsResult && parsedArgsResult.ok ? parsedArgsResult.value : null,
      });

      console.log(`📊 Progress: ${passedTests}/${totalTests} tests passed`);
    }

    console.log(`\n📈 Final Results:`);
    console.log(`✅ Passed: ${passedTests}/${totalTests}`);
    console.log(`❌ Failed: ${totalTests - passedTests}/${totalTests}`);
    console.log(`📊 Success Rate: ${Math.round((passedTests / totalTests) * 100)}%`);

    if (totalTests - passedTests > 0) {
      console.log(`\n🔍 Failure Analysis:`);
      console.log(`   🔴 Function name mismatches: ${functionNameFailures}`);
      console.log(`   🔴 Argument validation failures: ${argumentValidationFailures}`);
      console.log(`   🔴 JSON parsing failures: ${jsonParsingFailures}`);
      console.log(`   🔴 Missing required arguments: ${missingArgumentFailures}`);
    }

    console.log(`\n📋 Detailed Test Results:`);
    detailedResults.forEach((result, index) => {
      const status = result.success ? '✅' : '❌';
      console.log(`   ${index + 1}. ${status} ${result.scenario}`);
      if (result.functionName) {
        console.log(`      Function: ${result.functionName}`);
      }
      if (result.parsedArgs) {
        console.log(`      Arguments: ${JSON.stringify(result.parsedArgs)}`);
      }
      if (result.error && !result.success) {
        console.log(`      Error: ${result.error}`);
      }
    });

    if (passedTests === totalTests) {
      console.log(`\n🎉 All tests passed! Function calling infrastructure is working correctly.`);
      console.log(`💡 Note: Function calls are detected and arguments are validated properly.`);
      console.log(`🛡️  Validation includes:`);
      console.log(`   - Required arguments presence check`);
      console.log(`   - Argument type validation`);
      console.log(`   - Custom business logic validation`);
      console.log(`   - Exact argument value matching`);
    } else {
      console.log(`\n⚠️  Some tests failed. Issues detected:`);
      if (functionNameFailures > 0) {
        console.log(`   - LLM called wrong functions (${functionNameFailures} cases)`);
      }
      if (argumentValidationFailures > 0) {
        console.log(`   - Function arguments were invalid (${argumentValidationFailures} cases)`);
      }
      if (jsonParsingFailures > 0) {
        console.log(`   - Function arguments not valid JSON (${jsonParsingFailures} cases)`);
      }
      console.log(`🔧 Check the detailed output above for specific issues and required fixes.`);
    }
  }
}

// CLI argument parsing
function parseArgs(): { provider: string; model: string } {
  const args = process.argv.slice(2);

  let provider = '';
  let model = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && i + 1 < args.length) {
      provider = args[i + 1];
    } else if (args[i] === '--model' && i + 1 < args.length) {
      model = args[i + 1];
    }
  }

  if (!provider || !model) {
    console.error(
      'Usage: pnpm tsx tests/provider/func-call.ts --provider <provider> --model <model>',
    );
    console.error('\nAvailable providers and models:');

    // Load and display available configurations
    LlmConfig.load()
      .then((cfg) => {
        for (const [name, provider] of Object.entries(cfg.providers)) {
          console.log(`\n${name}:`);
          const modelNames = Object.keys(provider.models);
          for (const modelName of modelNames) {
            console.log(`  - ${modelName}`);
          }
        }
      })
      .catch(() => {});

    process.exit(1);
  }

  return { provider, model };
}

// Main execution
async function main() {
  try {
    const { provider, model } = parseArgs();

    console.log(`🧪 Function Call Test for ${provider}:${model}`);
    console.log(`⏰ Started at: ${new Date().toISOString()}`);
    console.log(`📁 rtws: ${process.cwd()}`);

    const tester = new FunctionCallTester(provider, model);
    await tester.initialize();
    await tester.runAllTests();

    console.log(`\n🏁 Test completed at: ${new Date().toISOString()}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`💥 Fatal error: ${message}`);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { FunctionCallTester, TestScenario };
