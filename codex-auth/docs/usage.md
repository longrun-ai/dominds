# Usage

## Responses request types

`ChatGptResponsesRequest` and related unions mirror the Codex Rust responses
request schema and `ResponseItem` shape. The helpers below provide an idiomatic
way to start or continue a conversation.

```ts
import { createChatGptContinuationRequest, createChatGptStartRequest } from '@longrun-ai/codex-auth';

const payload = createChatGptStartRequest({
  model: 'gpt-5.3-codex',
  instructions: 'You are Codex CLI.',
  // Native built-in tools are supported:
  // - web_search: cached/live web retrieval handled by Responses API
  // - local_shell: provider-side shell runtime (if available in your environment)
  tools: [{ type: 'web_search', external_web_access: true }],
  // Enable reasoning summaries / thinking stream (when supported by the backend + model).
  // If `reasoning` is provided, codex-auth will default `reasoning.summary` to `'auto'` and
  // automatically add `include: ['reasoning.encrypted_content']` unless you override `include`.
  reasoning: { effort: 'high', summary: 'auto' },
  // Allow the model to emit multiple tool calls in the same turn.
  // (Default: true)
  parallel_tool_calls: true,
  userText: 'hello',
});

const history = JSON.parse(historyJson);
const followup = createChatGptContinuationRequest({
  model: 'gpt-5.3-codex',
  instructions: 'You are Codex CLI.',
  history,
  userText: 'continue',
});
```

Streaming responses return SSE events. Each JSON `data:` payload maps to
`ChatGptResponsesStreamEvent` (exported from the package).

```ts
import type { ChatGptResponsesStreamEvent } from '@longrun-ai/codex-auth';

const event = JSON.parse(data) as ChatGptResponsesStreamEvent;
```

`parallel_tool_calls` defaults to `true` in `createChatGptStartRequest` /
`createChatGptContinuationRequest`. Set it to `false` if your runtime cannot
handle multiple in-flight tool calls safely.

Idiomatic event handling uses a discriminated-union switch so TypeScript can
verify exhaustive handling:

```ts
import type { ChatGptEventReceiver, ChatGptResponsesStreamEvent } from '@longrun-ai/codex-auth';

const receiver: ChatGptEventReceiver = {
  onEvent(event: ChatGptResponsesStreamEvent) {
    switch (event.type) {
      case 'response.created':
        console.log('created', event.response.id);
        break;
      case 'response.completed':
        console.log('completed', event.response.id);
        break;
      case 'response.failed':
        console.error('failed', event.response.error?.message);
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        console.log('item', event.item.type);
        break;
      case 'response.output_text.delta':
        process.stdout.write(event.delta);
        break;
      case 'response.reasoning_summary_text.delta':
        console.log('summary', event.summary_index, event.delta);
        break;
      case 'response.reasoning_text.delta':
        console.log('reasoning', event.content_index, event.delta);
        break;
      case 'response.reasoning_summary_part.added':
        console.log('summary part', event.summary_index);
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  },
};
```

Use the receiver with the streaming helper:

```ts
await client.trigger(payload, receiver);
```
