import type { LlmGenerationMetadata } from '@longrun-ai/kernel/types/storage';

export type GenerationModelPresentation = {
  compactLabel: string;
  tooltip: string;
};

function formatValueWithLabel(value: string, valueLabel: string | undefined): string {
  return valueLabel === undefined ? value : `${value} (${valueLabel})`;
}

export function formatGenerationModelPresentation(
  metadata: LlmGenerationMetadata,
): GenerationModelPresentation {
  const compactValues = metadata.prominentModelParams.map((param) =>
    param.kind === 'set' ? param.value : 'unset',
  );
  const compactLabel = [`${metadata.providerId}/${metadata.modelId}`, ...compactValues].join('·');

  const tooltipLines = [
    `provider-id: ${metadata.providerId}`,
    `model-id: ${metadata.modelId}`,
    `configured-model-id: ${metadata.configuredModelId}`,
  ];
  for (const param of metadata.prominentModelParams) {
    const fieldPath = `${param.namespace}.${param.key}`;
    if (param.kind === 'set') {
      tooltipLines.push(
        '',
        `${fieldPath}: ${formatValueWithLabel(param.value, param.valueLabel)}`,
        param.description,
      );
      continue;
    }
    tooltipLines.push('', `${fieldPath}: unset`, param.description);
    if (param.documentedDefault !== undefined) {
      tooltipLines.push(
        `documented-default: ${formatValueWithLabel(
          param.documentedDefault,
          param.documentedDefaultLabel,
        )}`,
      );
    }
  }

  return {
    compactLabel,
    tooltip: tooltipLines.join('\n'),
  };
}
