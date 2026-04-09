import domindsPackageJson from '../../package.json';

const parsedVersion =
  typeof domindsPackageJson.version === 'string' ? domindsPackageJson.version.trim() : '';

export const DOMINDS_RUNNING_VERSION = parsedVersion !== '' ? parsedVersion : 'unknown';
