import { runLiveStream } from '../helpers/live-provider';

// The legacy filename does not override the explicitly selected provider/API type.
runLiveStream('openai').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
