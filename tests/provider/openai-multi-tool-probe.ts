import { runLiveMultiTools } from '../helpers/live-provider';

runLiveMultiTools('volcano-engine', ['openai', 'openai-compatible']).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
