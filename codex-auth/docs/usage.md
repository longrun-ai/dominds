# Usage

## Auth loading

> **Dominds provider boundary:** the APIs below describe library-level contract support. The
> built-in Dominds `apiType: codex` provider accepts only managed, refreshable ChatGPT OAuth file
> auth. It intentionally rejects external tokens, headers, PAT, Agent Identity, API key, and
> Bedrock auth before sending a request. See
> [Codex provider auth policy](https://github.com/longrun-ai/dominds/blob/main/docs/codex-provider-auth-policy.md).

`AuthManager` follows the current Codex Rust auth precedence: optional
`CODEX_API_KEY` when `enableCodexApiKeyEnv` is set, ephemeral external auth,
`CODEX_ACCESS_TOKEN`, then configured persistent storage. When an `ExternalAuth`
provider is installed, its resolved `AuthState` is authoritative on every `auth()` call.

`CODEX_ACCESS_TOKEN` values beginning with `at-` are treated as personal access
tokens; other values are treated as agent identity JWTs. `createChatGptClientFromManager`
requires ChatGPT credentials: managed ChatGPT OAuth file auth, externally supplied
ChatGPT tokens, or in-memory request headers from an active external refresh provider.
Personal access token, agent identity, and Bedrock
API key modes are recognized, but this package refuses to use them for ChatGPT
requests because they cannot be converted into refreshable ChatGPT OAuth file auth.

External request headers follow the current Codex contract and are never read from or
written to `auth.json`:

```ts
import { AuthManager, createExternalHeaderAuth, type ExternalAuth } from '@longrun-ai/codex-auth';

const externalAuth: ExternalAuth = {
  resolve: async () => createExternalHeaderAuth(await resolveHeaders()),
  refresh: async () => createExternalHeaderAuth(await refreshHeaders()),
};
const manager = new AuthManager({ externalAuth });
```

Callers with a narrower product policy can pass `validateAuthState` to `AuthManager` so every
resolved environment, external, ephemeral, or persistent state is checked before it becomes the
active state. Passing the same validator to `createChatGptClientFromManager` adds a request-client
boundary check before initial client creation and after every auth reload or refresh, before a
recovered request can be sent. They can also pass `validateStoredAuth` to `AuthManager` to inspect
stored credentials and their `'persistent' | 'ephemeral'` source before a mode is parsed,
normalized, or promoted.

The Dominds-specific policy assertions throw `DomindsCodexProviderAuthPolicyError` with the stable
code `DOMINDS_CODEX_PROVIDER_AUTH_POLICY`, allowing the Dominds runtime to stop immediately instead
of retrying a local authentication configuration failure.

## Responses request types

`ChatGptResponsesRequest` and related unions mirror the Codex Rust responses
request schema and `ResponseItem` shape. The helpers below provide an idiomatic
way to start or continue a conversation.

```ts
import {
  createChatGptConversationId,
  createChatGptContinuationRequest,
  createChatGptStartRequest,
} from '@longrun-ai/codex-auth';

const conversationId = createChatGptConversationId();
const payload = createChatGptStartRequest({
  model: 'gpt-5.6-sol',
  instructions: 'You are Codex CLI.',
  conversationId,
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
  // Optional processing tier / latency class.
  // Typical public values are:
  // - default: standard processing
  // - priority: faster processing (Codex product `/fast` equivalent)
  service_tier: 'priority',
  userText: 'hello',
});

const history = JSON.parse(historyJson);
const followup = createChatGptContinuationRequest({
  model: 'gpt-5.6-sol',
  instructions: 'You are Codex CLI.',
  conversationId,
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

If you pass `conversationId`, codex-auth will also use it as the default
`prompt_cache_key`.

Bundled Codex prompt files are not auto-injected by the library. Pass explicit
`instructions` text yourself, or load a bundled prompt intentionally via
`loadCodexPrompt*` / `requireCodexPrompt*`.

Example:

```ts
import { requireCodexPromptSync } from '@longrun-ai/codex-auth';

const instructions = requireCodexPromptSync('gpt-5.6-sol');
```

`service_tier` is optional. For most callers, `default` and `priority` are the
useful user-facing choices. `priority` corresponds to faster processing without
changing reasoning effort.

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
