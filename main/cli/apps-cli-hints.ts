export function formatDoctorCommand(appId: string | null): string {
  return appId && appId.trim() !== '' ? `dominds doctor ${appId}` : 'dominds doctor';
}

export function formatDoctorGuidance(
  params: {
    appId?: string | null;
    prefix?: string;
    includeLayerSummary?: boolean;
  } = {},
): string {
  const command = formatDoctorCommand(params.appId ?? null);
  const prefix = params.prefix ?? 'Diagnosis first:';
  const layerSummary =
    params.includeLayerSummary === false
      ? ''
      : ' declaration, lock, configuration, resolution, and fresh handshake';
  return `${prefix} run '${command}' before retrying or editing app state manually.${layerSummary}`;
}

export function formatMutationBoundaryNote(params: {
  commandName: string;
  layerDescription: string;
  appId?: string | null;
}): string {
  return (
    `${params.commandName} only updates ${params.layerDescription}; it does not prove that the app is healthy. ` +
    formatDoctorGuidance({
      appId: params.appId ?? null,
      prefix: 'If the result is not what you expected,',
      includeLayerSummary: true,
    })
  );
}
