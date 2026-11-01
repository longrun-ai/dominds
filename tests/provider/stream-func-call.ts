import { runLiveToolPayloads } from '../helpers/live-provider';

runLiveToolPayloads('stream').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
