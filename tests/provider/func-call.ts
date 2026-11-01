import { runLiveToolPayloads } from '../helpers/live-provider';

runLiveToolPayloads('batch').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
