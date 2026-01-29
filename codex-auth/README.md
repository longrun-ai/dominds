# codex-auth

Node-friendly helpers for ChatGPT OAuth that are compatible with Codex
`auth.json` storage.

## Install

```sh
pnpm add @longrun-ai/codex-auth
```

## Library Usage

```ts
import {
  AuthManager,
  createChatGptClientFromManager,
  createChatGptStartRequest,
  runLoginServer,
} from '@longrun-ai/codex-auth';

const manager = new AuthManager();
const auth = await manager.auth();

if (!auth) {
  const server = await runLoginServer({ openBrowser: true });
  console.log(`Open this URL if your browser did not open: ${server.authUrl}`);
  await server.waitForCompletion();
}

const client = await createChatGptClientFromManager(manager);
const payload = createChatGptStartRequest({
  model: 'gpt-5.2-codex',
  instructions: 'You are Codex CLI.',
  userText: 'hello',
});
const response = await client.responses(payload);
const raw = await response.text();
console.log(raw);
```

Continue a conversation from stored history:

```ts
import { createChatGptContinuationRequest } from '@longrun-ai/codex-auth';

const history = JSON.parse(historyJson);
const followup = createChatGptContinuationRequest({
  model: 'gpt-5.2-codex',
  instructions: 'You are Codex CLI.',
  history,
  userText: 'continue',
});
await client.trigger(followup, receiver);
```

`responses()` returns an SSE stream; parse each `data:` payload as
`ChatGptResponsesStreamEvent`.

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
      case 'response.output_text.delta':
        process.stdout.write(event.delta);
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

Device code flow (headless):

```ts
import { runDeviceCodeLogin } from 'codex-auth';

await runDeviceCodeLogin({
  onDeviceCode: (code) => {
    console.log('Visit:', code.verificationUrl);
    console.log('User code:', code.userCode);
  },
});
```

## Auth Doctor (CLI)

The package ships a CLI that inspects `auth.json` and reports status.
It runs a ChatGPT chat probe unless `--no-verify` is used.

```sh
npx @longrun-ai/codex-auth --json
```

Refresh tokens (if available):

```sh
npx @longrun-ai/codex-auth --refresh
```

Skip the verification request (no LLM call):

```sh
npx @longrun-ai/codex-auth --no-verify
```

Dump SSE events from the verification request:

```sh
npx @longrun-ai/codex-auth --verbose
```

Override model or base URL:

```sh
npx @longrun-ai/codex-auth --model gpt-5.2-codex \
  --chatgpt-base-url https://chatgpt.com/backend-api/
```

Override `CODEX_HOME`:

```sh
npx @longrun-ai/codex-auth --codex-home /path/to/.codex
```

## Notes

- Default `CODEX_HOME` is `~/.codex` unless overridden.
- The CLI uses the same file schema as Codex Rust.
- Reasoning/thinking SSE events (`response.reasoning_*`) only stream when the request enables
  `reasoning` (and typically includes `reasoning.encrypted_content`).
- Proxy env vars are detected via `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
  (case-insensitive). If set, the verification request uses them.
