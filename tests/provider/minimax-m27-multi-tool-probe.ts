import { runLiveMultiTools } from '../helpers/live-provider';

runLiveMultiTools('minimaxi.com-coding-plan').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
