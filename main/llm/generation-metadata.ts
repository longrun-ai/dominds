import type { SetupProminentModelParamNamespace } from '@longrun-ai/kernel/types/setup';
import type {
  LlmGenerationMetadata,
  LlmGenerationMetadataField,
} from '@longrun-ai/kernel/types/storage';
import type { Team } from '../team';
import type { ModelParamOption, ProviderConfig } from './client';

type ProminentParamSource = {
  namespace: SetupProminentModelParamNamespace;
  options: Readonly<Record<string, ModelParamOption>>;
  configuredValues: Readonly<Record<string, unknown>> | undefined;
};

function asDynamicModelParamValues(
  values: object | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (values === undefined) return undefined;
  // Provider `model_param_options` keys are data-driven, so correlating those documented keys with
  // the statically typed provider namespace necessarily uses dynamic lookup at this boundary.
  return values as Readonly<Record<string, unknown>>;
}

function resolveProminentParamSource(
  providerConfig: ProviderConfig,
  modelParams: Team.ModelParams | undefined,
): ProminentParamSource | null {
  switch (providerConfig.apiType) {
    case 'codex': {
      const options = providerConfig.model_param_options?.codex;
      return options
        ? {
            namespace: 'codex',
            options,
            configuredValues: asDynamicModelParamValues(modelParams?.codex),
          }
        : null;
    }
    case 'openai': {
      const options = providerConfig.model_param_options?.openai;
      return options
        ? {
            namespace: 'openai',
            options,
            configuredValues: asDynamicModelParamValues(modelParams?.openai),
          }
        : null;
    }
    case 'openai-compatible': {
      const options = providerConfig.model_param_options?.['openai-compatible'];
      return options
        ? {
            namespace: 'openai-compatible',
            options,
            configuredValues: asDynamicModelParamValues(modelParams?.['openai-compatible']),
          }
        : null;
    }
    case 'anthropic': {
      const options = providerConfig.model_param_options?.anthropic;
      return options
        ? {
            namespace: 'anthropic',
            options,
            configuredValues: asDynamicModelParamValues(modelParams?.anthropic),
          }
        : null;
    }
    case 'anthropic-compatible': {
      const options = providerConfig.model_param_options?.['anthropic-compatible'];
      return options
        ? {
            namespace: 'anthropic-compatible',
            options,
            configuredValues: asDynamicModelParamValues(modelParams?.['anthropic-compatible']),
          }
        : null;
    }
    case 'google': {
      const options = providerConfig.model_param_options?.google;
      return options
        ? {
            namespace: 'google',
            options,
            configuredValues: asDynamicModelParamValues(modelParams?.google),
          }
        : null;
    }
    case 'mock':
      return null;
    default: {
      // Registered generators may have no built-in prominent-parameter namespace.
      // Their provider/model identity is still valid metadata.
      return null;
    }
  }
}

function serializeStructuredModelParamValue(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(
          `Cannot display non-finite prominent model parameter value: ${String(value)}`,
        );
      }
      return String(value);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item) => serializeStructuredModelParamValue(item)).join(',')}]`;
      }
      return `{${Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map(
          (key) =>
            `${JSON.stringify(key)}:${serializeStructuredModelParamValue(
              (value as Readonly<Record<string, unknown>>)[key],
            )}`,
        )
        .join(',')}}`;
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new Error(
        `Cannot display unsupported prominent model parameter value type: ${typeof value}`,
      );
    default:
      throw new Error(`Cannot display unknown prominent model parameter value: ${String(value)}`);
  }
}

function serializeModelParamValue(value: unknown): string {
  return typeof value === 'string' ? value : serializeStructuredModelParamValue(value);
}

function resolveDocumentedDefault(option: ModelParamOption): unknown {
  return 'default' in option ? option.default : undefined;
}

function resolveValueLabel(option: ModelParamOption, value: string): string | undefined {
  if (option.type !== 'enum') return undefined;
  const label = option.value_labels?.[value];
  return typeof label === 'string' && label.trim() !== '' ? label.trim() : undefined;
}

export function buildLlmGenerationMetadata(args: {
  providerId: string;
  configuredModelId: string;
  reportedModelId: string;
  providerConfig: ProviderConfig;
  modelParams: Team.ModelParams | undefined;
}): LlmGenerationMetadata {
  const providerId = args.providerId.trim();
  const configuredModelId = args.configuredModelId.trim();
  const modelId = args.reportedModelId.trim();
  if (providerId === '' || configuredModelId === '' || modelId === '') {
    throw new Error(
      `Cannot build LLM generation metadata with empty identity fields ` +
        `(providerId=${JSON.stringify(providerId)}, configuredModelId=${JSON.stringify(
          configuredModelId,
        )}, modelId=${JSON.stringify(modelId)})`,
    );
  }

  const source = resolveProminentParamSource(args.providerConfig, args.modelParams);
  const fields: LlmGenerationMetadataField[] = [
    {
      kind: 'set',
      key: 'configured-model-id',
      prominent: false,
      value: configuredModelId,
    },
  ];
  if (source) {
    for (const [key, option] of Object.entries(source.options)) {
      if (option.prominent !== true) continue;
      const base = {
        key: `${source.namespace}.${key}`,
        prominent: true,
        description: option.description,
      };
      const configuredValue = source.configuredValues?.[key];
      if (configuredValue !== undefined) {
        const value = serializeModelParamValue(configuredValue);
        const valueLabel = resolveValueLabel(option, value);
        fields.push({
          kind: 'set',
          ...base,
          value,
          ...(valueLabel === undefined ? {} : { valueLabel }),
        });
        continue;
      }

      const documentedDefault = resolveDocumentedDefault(option);
      if (documentedDefault === undefined) {
        fields.push({ kind: 'unset', ...base });
        continue;
      }
      const documentedDefaultText = serializeModelParamValue(documentedDefault);
      const documentedDefaultLabel = resolveValueLabel(option, documentedDefaultText);
      fields.push({
        kind: 'unset',
        ...base,
        documentedDefault: documentedDefaultText,
        ...(documentedDefaultLabel === undefined ? {} : { documentedDefaultLabel }),
      });
    }
  }

  return {
    providerId,
    modelId,
    fields,
  };
}
