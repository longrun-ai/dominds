import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';

/** A complete supplied wire start, shared by the three stream-consumer regressions. */
export function anthropicMessageStart(): MessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'supplied-message-id',
      type: 'message',
      role: 'assistant',
      model: 'supplied-model-id',
      content: [],
      container: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
    },
  };
}
