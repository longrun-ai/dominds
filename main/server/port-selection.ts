export const DEFAULT_WEBUI_PORT = 5666;
export const MIN_AUTO_WEBUI_PORT = 1024;

export type WebuiPortAutoDirection = 'down' | 'up';

export type ParsedPortSpec = {
  port: number;
  strictPort: boolean;
  portAutoDirection: WebuiPortAutoDirection;
};

export function parseWebuiPortSpec(raw: string): ParsedPortSpec | null {
  let numericText = raw;
  let strictPort = true;
  let portAutoDirection: WebuiPortAutoDirection = 'down';

  if (raw.endsWith('+')) {
    numericText = raw.slice(0, -1);
    strictPort = false;
    portAutoDirection = 'up';
  } else if (raw.endsWith('-')) {
    numericText = raw.slice(0, -1);
    strictPort = false;
    portAutoDirection = 'down';
  }

  if (!/^[0-9]+$/.test(numericText)) return null;
  const port = Number(numericText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { port, strictPort, portAutoDirection };
}

export function validateWebuiPort(port: number, context: string): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${context} must be an integer in [0, 65535] (got ${String(port)})`);
  }
}

export function buildWebuiPortCandidates(params: {
  preferredPort: number;
  strictPort: boolean;
  direction: WebuiPortAutoDirection;
}): number[] {
  validateWebuiPort(params.preferredPort, 'WebUI port');
  if (params.strictPort || params.preferredPort === 0) return [params.preferredPort];

  const candidates: number[] = [params.preferredPort];
  if (params.direction === 'down') {
    for (
      let candidate = params.preferredPort - 1;
      candidate >= MIN_AUTO_WEBUI_PORT;
      candidate -= 1
    ) {
      candidates.push(candidate);
    }
  } else {
    for (let candidate = params.preferredPort + 1; candidate <= 65535; candidate += 1) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function formatWebuiPortScanBound(params: {
  preferredPort: number;
  direction: WebuiPortAutoDirection;
}): string {
  return params.direction === 'down'
    ? `down to ${Math.min(params.preferredPort, MIN_AUTO_WEBUI_PORT)}`
    : 'up to 65535';
}
