import {
  KIMI_CODE_API_QUIRK,
  VOLCENGINE_INVALID_PARAMETER_AGGRESSIVE_RETRY_API_QUIRK,
  XCODE_BEST_STREAM_INTERNAL_ERROR_CODE,
  type LlmFailureSummary,
} from '../../main/llm/api-quirks';
import type { ProviderConfig } from '../../main/llm/client';
export function buildProviderConfig(): ProviderConfig {
  return {
    name: 'xcode.best - test',
    apiType: 'openai',
    apiQuirks: 'xcode.best',
    baseUrl: 'https://api.xcode.best/v1',
    apiKeyEnvVar: 'XCODE_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

export function buildPlainProviderConfig(): ProviderConfig {
  return {
    name: 'plain-openai - test',
    apiType: 'openai',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnvVar: 'PLAIN_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

export function buildOpenAiCompatibleSameContextEmptyProviderConfig(): ProviderConfig {
  return {
    name: 'openai-compatible same-context-empty-response - test',
    apiType: 'openai-compatible',
    apiQuirks: 'same-context-empty-response',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnvVar: 'OPENAI_COMPAT_EMPTY_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

export function buildVolcengineInvalidParameterProviderConfig(): ProviderConfig {
  return {
    name: 'Volcano Ark Coding Plan - test',
    apiType: 'openai-compatible',
    apiQuirks: VOLCENGINE_INVALID_PARAMETER_AGGRESSIVE_RETRY_API_QUIRK,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    apiKeyEnvVar: 'ARK_TEST_API_KEY',
    models: {
      test: {
        name: 'Test',
      },
    },
  };
}

export function buildKimiCodeProviderConfig(): ProviderConfig {
  return {
    name: 'Kimi Code - test',
    apiType: 'openai-compatible',
    apiQuirks: KIMI_CODE_API_QUIRK,
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyEnvVar: 'KIMI_CODE_TEST_API_KEY',
    models: {
      test: {
        name: 'Kimi For Coding',
      },
    },
  };
}

export function makeFailure(code: string, message: string): LlmFailureSummary {
  return {
    kind: 'retriable',
    code,
    message,
  };
}

export function makeKimiCodeHighRiskError(): { status: number; code: string; message: string } {
  return {
    status: 400,
    code: 'OPENAI_COMPATIBLE_REJECTED_REQUEST',
    message: '400 The request was rejected because it was considered high risk',
  };
}

export function makeGatewayHtml502Error(): { status: number; message: string } {
  return {
    status: 502,
    message:
      '502 <!DOCTYPE html>\n' +
      '<html lang="en-US">\n' +
      '<head><title>18181899.xyz | 502: Bad gateway</title></head>\n' +
      '<body>Cloudflare Bad gateway</body>\n' +
      '</html>',
  };
}

export function makeAuthUnavailableError(): { status: number; code: string; message: string } {
  return {
    status: 500,
    code: 'internal_server_error',
    message: '500 auth_unavailable: no auth available',
  };
}

export function makeXcodeBestMisreported403Error(): {
  status: number;
  code: string;
  message: string;
} {
  return {
    status: 403,
    code: 'forbidden',
    message: '403 Forbidden',
  };
}

export function makeXcodeBestMisreported403WithNested429Error(): {
  status: number;
  code: string;
  message: string;
  response: {
    status: number;
    headers: Record<string, string>;
  };
} {
  return {
    status: 403,
    code: 'forbidden',
    message: '403 Forbidden',
    response: {
      status: 429,
      headers: {
        'retry-after': '0.01',
      },
    },
  };
}

export function makeVolcengineInvalidParameterError(): {
  status: number;
  code: string;
  message: string;
} {
  return {
    status: 400,
    code: 'InvalidParameter',
    message:
      '400 A parameter specified in the request is not valid: %s Request id: 021778429772930a9c6544091777d16bd21be5aab8209d34efbd2',
  };
}

export function makeVolcengineNestedInvalidParameterWith429Error(): {
  status: number;
  code: string;
  message: string;
  response: { status: number };
} {
  return {
    ...makeVolcengineInvalidParameterError(),
    response: { status: 429 },
  };
}

export function makeWrappedVolcengineInvalidParameterError(): Error & {
  cause: { status: number; code: string; message: string };
  code: string;
  status: number;
} {
  const cause = makeVolcengineInvalidParameterError();
  const error = new Error(
    'OPENAI-compatible provider rejected stream request with HTTP 400.',
  ) as Error & {
    cause: { status: number; code: string; message: string };
    code: string;
    status: number;
  };
  error.cause = cause;
  error.code = cause.code;
  error.status = cause.status;
  return error;
}

export function makeXcodeBestStreamInternalError(args: { status?: number; retryAfter?: string }): {
  status?: number;
  code: string;
  message: string;
  headers?: Record<string, string>;
} {
  const error: {
    status?: number;
    code: string;
    message: string;
    headers?: Record<string, string>;
  } = {
    code: XCODE_BEST_STREAM_INTERNAL_ERROR_CODE,
    message: 'stream error: internal_error received from peer',
  };
  if (args.status !== undefined) {
    error.status = args.status;
  }
  if (args.retryAfter !== undefined) {
    error.headers = {
      'retry-after': args.retryAfter,
    };
  }
  return error;
}

export function makeXcodeBestStreamInternalResponseStatusError(args: {
  status: number;
  retryAfter?: string;
}): {
  code: string;
  message: string;
  response: {
    status: number;
    headers?: Record<string, string>;
  };
} {
  const response: {
    status: number;
    headers?: Record<string, string>;
  } = {
    status: args.status,
  };
  if (args.retryAfter !== undefined) {
    response.headers = {
      'retry-after': args.retryAfter,
    };
  }
  return {
    code: XCODE_BEST_STREAM_INTERNAL_ERROR_CODE,
    message: 'stream error: internal_error received from peer',
    response,
  };
}

export function makeNestedXcodeBestStreamInternalResponseStatusError(args: {
  status: number;
  retryAfter?: string;
}): {
  error: {
    code: string;
    message: string;
    response: {
      status: number;
      headers?: Record<string, string>;
    };
  };
} {
  return {
    error: makeXcodeBestStreamInternalResponseStatusError(args),
  };
}

export function makeUnexpectedEofError(): Error {
  return new Error('unexpected EOF');
}

export function makeWrappedUnexpectedEofError(): Error {
  return new Error('fetch failed', { cause: makeUnexpectedEofError() });
}
