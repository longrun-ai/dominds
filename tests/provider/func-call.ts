#!/usr/bin/env node

/**
 * Function Call Test Script for @cmdr Agent
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
 * Usage: npx tsx tests/provider/func-call.ts --provider <provider> --model <model>
 *
 * Examples:
 *   npx tsx tests/provider/func-call.ts --provider iflow.cn --model kimi-k2-0905
 *   npx tsx tests/provider/func-call.ts --provider minimaxi.com-coding-plan --model MiniMax-M2
 *   npx tsx tests/provider/func-call.ts --provider bigmodel --model glm-4.6
 *
 * Validation includes:
 * - Required argument presence checks
 * - JSON parsing verification
 * - Custom business logic validation (command patterns, PID validation, etc.)
 * - Exact value matching against expected arguments
 */

import { ChatMessage, FuncCallMsg, LlmConfig } from 'dominds/llm/client';
import { generatorsRegistry } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';

interface TestScenario {
  name: string;
  description: string;
  prompt: string;
  expectedFunctionCall: string;
  expectedArgs?: Record<string, any>;
  argValidation?: (args: Record<string, any>) => { valid: boolean; error?: string };
}

class FunctionCallTester {
  private provider: string;
  private model: string;
  private llmConfig: LlmConfig;
  private providerConfig: any;
  private generator: any;
  private agent: Team.Member;

  constructor(provider: string, model: string) {
    this.provider = provider;
    this.model = model;
  }

  async initialize(): Promise<void> {
    console.log(`🔧 Initializing function call test for ${this.provider}:${this.model}`);

    // Load LLM configuration
    this.llmConfig = await LlmConfig.load();
    this.providerConfig = this.llmConfig.getProvider(this.provider);

    if (!this.providerConfig) {
      throw new Error(`Provider '${this.provider}' not found in configuration`);
    }

    // Check if API key is available
    const apiKey = process.env[this.providerConfig.apiKeyEnvVar];
    if (!apiKey) {
      console.warn(
        `⚠️  Warning: API key environment variable '${this.providerConfig.apiKeyEnvVar}' is not set`,
      );
      console.warn(
        `   Running in diagnostic mode - function calls will be detected but not executed`,
      );
    }

    // Get the appropriate generator
    this.generator = generatorsRegistry.get(this.providerConfig.apiType);
    if (!this.generator) {
      throw new Error(`Generator for '${this.providerConfig.apiType}' not found`);
    }

    // Create @cmdr agent with shell command tools
    this.agent = new Team.Member({
      id: 'cmdr',
      name: 'Commander',
      model: this.model,
    });

    console.log(`✅ Initialized ${this.provider}:${this.model} with @cmdr agent`);
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

  private getFunctionTools(): any[] {
    // Return tool schemas for function calling (tools will be provided by the system)
    return [
      {
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
        },
      },
      {
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
        },
      },
    ];
  }

  async testFunctionCall(
    scenario: TestScenario,
  ): Promise<{ success: boolean; functionCall?: FuncCallMsg; error?: string }> {
    console.log(`\n🧪 Testing scenario: ${scenario.name}`);
    console.log(`📝 Prompt: ${scenario.prompt}`);

    try {
      const context: ChatMessage[] = [
        {
          type: 'text',
          role: 'user',
          content: scenario.prompt,
        },
      ];

      const functionTools = this.getFunctionTools();
      const systemPrompt = this.getSystemPrompt();

      console.log(`🎯 Expected function call: ${scenario.expectedFunctionCall}`);
      if (scenario.expectedArgs) {
        console.log(`📋 Expected arguments:`, JSON.stringify(scenario.expectedArgs, null, 2));
      }

      let functionCall: FuncCallMsg | null = null;

      console.log(`🔄 Starting LLM non-streaming processing...`);

      // Use non-streaming mode for function call verification
      const messages = await this.generator.genMoreMessages(
        this.providerConfig,
        this.agent,
        systemPrompt,
        functionTools,
        context,
        1,
      );

      console.log(`📊 Non-streaming processing complete: ${messages.length} messages returned`);

      // Find the first function call in the returned messages
      functionCall = messages.find((msg) => msg.type === 'func_call_msg') as FuncCallMsg;

      if (functionCall) {
        console.log(`📞 Function call detected: ${functionCall.name}`);
        console.log(`📋 Function: ${functionCall.name}`);
        console.log(`📋 Arguments: ${functionCall.arguments}`);
      } else {
        console.log(`❌ No function call found in returned messages`);
        console.log(
          `📝 Returned messages:`,
          messages.map((m) => ({ type: m.type, role: (m as any).role, name: (m as any).name })),
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
      let parsedArgs: Record<string, any> = {};
      try {
        parsedArgs = functionCall.arguments ? JSON.parse(functionCall.arguments) : {};
        console.log(`📋 Parsed arguments:`, JSON.stringify(parsedArgs, null, 2));
      } catch (parseError) {
        console.log(`❌ Failed to parse function arguments as JSON:`, functionCall.arguments);
        return {
          success: false,
          error: `Function arguments are not valid JSON: ${functionCall.arguments}`,
          functionCall,
        };
      }

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
    } catch (error: any) {
      console.error(`💥 Test error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async runAllTests(): Promise<void> {
    console.log(`🚀 Starting function call tests for ${this.provider}:${this.model}`);
    console.log(`📁 Workspace: ${process.cwd()}`);

    const scenarios: TestScenario[] = [
      {
        name: 'Scenario 1: ls command',
        description: 'Test basic ls command execution',
        prompt:
          'Use your shell command tool to list all files in the current directory with details (run `ls -la`).',
        expectedFunctionCall: 'shell_cmd',
        expectedArgs: { command: 'ls -la' },
        argValidation: (args) => {
          if (!args.command) {
            return { valid: false, error: 'Missing required command argument' };
          }
          if (typeof args.command !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!args.command.includes('ls')) {
            return { valid: false, error: 'Command should contain ls' };
          }
          if (!args.command.includes('-la')) {
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
          if (!args.command) {
            return { valid: false, error: 'Missing required command argument' };
          }
          if (typeof args.command !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!args.command.includes('find')) {
            return { valid: false, error: 'Command should contain find' };
          }
          if (!args.command.includes('.ts')) {
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
          if (!args.command) {
            return { valid: false, error: 'Missing required command argument' };
          }
          if (typeof args.command !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!args.command.includes('grep')) {
            return { valid: false, error: 'Command should contain grep' };
          }
          if (!args.command.includes('shell_cmd')) {
            return { valid: false, error: 'Command should search for "shell_cmd"' };
          }
          if (!args.command.includes('.ts')) {
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
          if (!args.command) {
            return { valid: false, error: 'Missing required command argument' };
          }
          if (typeof args.command !== 'string') {
            return { valid: false, error: 'Command argument must be a string' };
          }
          if (!args.command.includes('tail') || !args.command.includes('-f')) {
            return { valid: false, error: 'Command should include tail -f for daemon process' };
          }
          if (!args.command.includes('/tmp/')) {
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
          if (!args.pid) {
            return { valid: false, error: 'Missing required pid argument' };
          }
          if (typeof args.pid !== 'number') {
            return { valid: false, error: 'PID argument must be a number' };
          }
          if (args.pid <= 0) {
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
      parsedArgs?: any;
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
      detailedResults.push({
        scenario: scenario.name,
        success: testResult.success,
        error: testResult.error,
        functionName: testResult.functionCall?.name,
        parsedArgs: testResult.functionCall?.arguments
          ? JSON.parse(testResult.functionCall.arguments)
          : null,
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
      'Usage: npx tsx tests/provider/func-call.ts --provider <provider> --model <model>',
    );
    console.error('\nAvailable providers and models:');

    // Load and display available configurations
    LlmConfig.load()
      .then((cfg) => {
        for (const [name, provider] of Object.entries((cfg as any).providers || {})) {
          console.log(`\n${name}:`);
          if (provider.models) {
            provider.models.forEach((model: string) => {
              console.log(`  - ${model}`);
            });
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
    console.log(`📁 Workspace: ${process.cwd()}`);

    const tester = new FunctionCallTester(provider, model);
    await tester.initialize();
    await tester.runAllTests();

    console.log(`\n🏁 Test completed at: ${new Date().toISOString()}`);
  } catch (error: any) {
    console.error(`💥 Fatal error: ${error.message}`);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { FunctionCallTester, TestScenario };
