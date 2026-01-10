# Usage

## Responses request types

`ChatGptResponsesRequest` and related unions mirror the Codex Rust responses
request schema and `ResponseItem` shape. The helpers below provide an idiomatic
way to start or continue a conversation.

```ts
import { createChatGptContinuationRequest, createChatGptStartRequest } from '@dominds/codex-auth';

const payload = createChatGptStartRequest({
  model: 'gpt-5.2-codex',
  instructions: 'You are Codex CLI.',
  userText: 'hello',
});

const history = JSON.parse(historyJson);
const followup = createChatGptContinuationRequest({
  model: 'gpt-5.2-codex',
  instructions: 'You are Codex CLI.',
  history,
  userText: 'continue',
});
```

Streaming responses return SSE events. Each JSON `data:` payload maps to
`ChatGptResponsesStreamEvent` (exported from the package).

```ts
import type { ChatGptResponsesStreamEvent } from '@dominds/codex-auth';

const event = JSON.parse(data) as ChatGptResponsesStreamEvent;
```

Idiomatic event handling uses a discriminated-union switch so TypeScript can
verify exhaustive handling:

```ts
import type { ChatGptEventReceiver, ChatGptResponsesStreamEvent } from '@dominds/codex-auth';

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
