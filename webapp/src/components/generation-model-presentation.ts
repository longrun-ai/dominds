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
  const compactValues = metadata.fields
    .filter((field) => field.prominent)
    .map((field) => (field.kind === 'set' ? field.value : 'unset'));
  const compactLabel = [`${metadata.providerId}/${metadata.modelId}`, ...compactValues].join('·');

  const tooltipLines = [`provider-id: ${metadata.providerId}`, `model-id: ${metadata.modelId}`];
  for (const field of metadata.fields) {
    if (field.kind === 'set') {
      tooltipLines.push('', `${field.key}: ${formatValueWithLabel(field.value, field.valueLabel)}`);
      if (field.description !== undefined) tooltipLines.push(field.description);
      continue;
    }
    tooltipLines.push('', `${field.key}: unset`);
    if (field.description !== undefined) tooltipLines.push(field.description);
    if (field.documentedDefault !== undefined) {
      tooltipLines.push(
        `documented-default: ${formatValueWithLabel(
          field.documentedDefault,
          field.documentedDefaultLabel,
        )}`,
      );
    }
  }

  return {
    compactLabel,
    tooltip: tooltipLines.join('\n'),
  };
}
