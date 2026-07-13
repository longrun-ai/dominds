# Codex Provider Authentication Policy

## Decided product boundary

The built-in Dominds `apiType: codex` provider **supports only managed ChatGPT OAuth file authentication**. Its runtime accepts only a final `auth_mode: chatgpt` state backed by refreshable `id_token`, `access_token`, and `refresh_token` values plus a ChatGPT account ID.

This product boundary is intentionally narrower than `codex-rs`; it is not a backlog of modes that should be enabled automatically. `codex-auth` may continue recognizing the complete `codex-rs` authentication contract so it can produce accurate diagnostics. Recognizing an authentication method does not authorize the Dominds Codex provider to send requests with it.

Current behavior is:

| Detected authentication method                          | Dominds Codex provider behavior                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Complete, refreshable managed `chatgpt` OAuth file auth | Accepted                                                            |
| `chatgpt` from the ephemeral auth store                 | Rejected                                                            |
| `chatgpt` missing a required token or account ID        | Rejected; Codex ChatGPT file login must be run again                |
| `chatgptAuthTokens`, whether refreshable or not         | Rejected                                                            |
| `apikey`                                                | Rejected                                                            |
| External `headers`                                      | Rejected                                                            |
| `agentIdentity`                                         | Rejected                                                            |
| `personalAccessToken`                                   | Rejected                                                            |
| `bedrockApiKey`                                         | Rejected                                                            |
| `CODEX_ACCESS_TOKEN` containing a PAT or Agent Identity | Rejected; this variable overrides persistent auth and must be unset |

Unsupported startup auth is rejected before request-client creation. If credentials change to another mode, come from the ephemeral auth store, or remain `chatgpt` but become incomplete during refresh or 401 recovery, they are rejected again before any retry request. These local policy failures use the stable `DOMINDS_CODEX_PROVIDER_AUTH_POLICY` error code and are non-retriable. The provider must not fall back based on an upstream error, repeat the same authentication path, or silently select another credential.

## When another authentication method is required

If the target service exposes the OpenAI Responses API, configure a custom `apiType: openai` provider with its own authentication environment variable. For example:

```yaml
providers:
  my_openai_responses:
    name: My OpenAI Responses API
    apiType: openai
    baseUrl: https://api.openai.com/v1
    apiKeyEnvVar: MY_OPENAI_API_KEY
    models:
      gpt-5.6-sol:
        name: GPT-5.6 Sol
        optimal_max_tokens: 600000
        critical_max_tokens: 922000
        caution_remediation_cadence_generations: 10
        context_length: 1050000
        input_length: 1050000
        output_length: 128000
        context_window: '1.05M'
```

If `apiType: openai` cannot cover the required authentication flow, submit a feature request through [Dominds issues](https://github.com/longrun-ai/dominds/issues). Do not opportunistically add the new authentication method to the Codex provider.

## Default rule for future `codex-rs` alignment

Future synchronization with the `codex-rs` authentication contract must preserve this policy by default:

1. Update `codex-auth` parsing, types, and diagnostics for new contracts and modes.
2. Continue accepting only complete, refreshable, file-backed managed `chatgpt` OAuth at the Dominds Codex provider request boundary.
3. Reject every new mode loudly before any HTTP request, retaining guidance for a custom OpenAI Responses API provider or a Dominds feature request.
4. Update code comments, this document, and regression tests covering every authentication branch.
5. Expand the Codex provider authentication surface only through an explicit Dominds product decision. Upstream support alone is not sufficient justification.
