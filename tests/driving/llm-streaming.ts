import { ChatMessage, LlmConfig, SayingMsg } from 'dominds/llm/client';
import { getLlmGenerator } from 'dominds/llm/gen/registry';
import { Team } from 'dominds/team';
import type { FuncTool } from 'dominds/tool';
import path from 'path';

async function main() {
  try {
    process.chdir(path.resolve(process.cwd(), 'tests/script-rtws'));
  } catch (err) {
    console.debug('Failed to change to tests/script-rtws directory, using current directory', err);
  }
  const team = await Team.load();
  const agentIdArg = process.argv.find((a) => a.startsWith('--agent='))?.split('=')[1];
  const promptArg = process.argv.find((a) => a.startsWith('--prompt='))?.split('=')[1];
  const agentId = agentIdArg || team.defaultResponder || Object.keys(team.members)[0];
  const agent = team.getMember(agentId) || team.memberDefaults;
  const cfg = await LlmConfig.load();
  const providerKey = agent.provider || team.memberDefaults.provider!;
  const providerCfg = cfg.getProvider(providerKey);
  if (!providerCfg) {
    console.error(`Provider not found: ${providerKey}`);
    process.exit(2);
  }
  const gen = getLlmGenerator(providerCfg.apiType);
  if (!gen) {
    console.error(`Generator not found for apiType: ${providerCfg.apiType}`);
    process.exit(2);
  }
  const systemPrompt = '';
  const funcTools: FuncTool[] = [];
  const userText = promptArg || 'Stream test: respond in short chunks.';
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'test-user-msg',
      content: userText,
      grammar: 'texting',
    },
  ];
  console.log(
    JSON.stringify({
      provider: providerKey,
      apiType: providerCfg.apiType,
      baseUrl: providerCfg.baseUrl,
      model: agent.model || team.memberDefaults.model,
      agentId,
      prompt: userText,
    }),
  );
  let textChunkCount = 0;
  let totalTextLen = 0;
  let reasoningChunkCount = 0;
  let totalReasoningLen = 0;
  await gen.genToReceiver(
    providerCfg,
    agent,
    systemPrompt,
    funcTools,
    context,
    {
      thinkingStart: async () => {},
      thinkingChunk: async (chunk: string) => {
        reasoningChunkCount++;
        totalReasoningLen += chunk.length;
        console.log(
          JSON.stringify({
            type: 'reasoning_chunk',
            n: reasoningChunkCount,
            len: chunk.length,
            preview: chunk.slice(0, 100),
          }),
        );
      },
      thinkingFinish: async () => {
        console.log(
          JSON.stringify({
            type: 'reasoning_end',
            chunks: reasoningChunkCount,
            totalLen: totalReasoningLen,
          }),
        );
      },
      sayingStart: async () => {},
      sayingChunk: async (chunk: string) => {
        textChunkCount++;
        totalTextLen += chunk.length;
        console.log(
          JSON.stringify({
            type: 'text_chunk',
            n: textChunkCount,
            len: chunk.length,
            preview: chunk.slice(0, 100),
          }),
        );
      },
      sayingFinish: async () => {
        console.log(
          JSON.stringify({ type: 'text_end', chunks: textChunkCount, totalLen: totalTextLen }),
        );
      },
      funcCall: async () => {},
    },
    1,
  );
  if (textChunkCount === 0) {
    const batch = await gen.genMoreMessages(
      providerCfg,
      agent,
      systemPrompt,
      funcTools,
      context,
      1,
    );
    const assistant = batch.find(
      (m): m is SayingMsg => m.type === 'saying_msg' && m.role === 'assistant',
    );
    const content = assistant ? assistant.content : '';
    console.log(
      JSON.stringify({ type: 'batch_text', len: content.length, preview: content.slice(0, 200) }),
    );
  }
  console.log(
    JSON.stringify({
      summary: {
        reasoningChunkCount,
        totalReasoningLen,
        textChunkCount,
        totalTextLen,
      },
    }),
  );
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
