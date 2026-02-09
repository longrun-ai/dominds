import assert from 'node:assert/strict';

import { driveDialogStream as driveDialogStreamV1 } from '../../main/llm/driver';
import { driveDialogStream as driveDialogStreamV2 } from '../../main/llm/driver-v2';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import {
  formatAssignmentFromSupdialog,
  formatTeammateResponseContent,
} from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  lastAssistantSaying,
  listTellaskResultContents,
  parseSingleTellaskCall,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

type RunSummary = Readonly<{
  assistantSayings: ReadonlyArray<string>;
  tellaskResultContents: ReadonlyArray<string>;
}>;

async function runScenario(
  driver: typeof driveDialogStreamV1,
  trigger: string,
  expectedResume: string,
  msgId: string,
): Promise<RunSummary> {
  const dlg = createRootDialog('tester');
  dlg.disableDiligencePush = true;

  await driver(dlg, { content: trigger, msgId, grammar: 'markdown' }, true);
  await waitFor(
    async () => lastAssistantSaying(dlg) === expectedResume,
    4_000,
    'root final saying',
  );
  await waitForAllDialogsUnlocked(dlg, 4_000);

  const assistantSayings = dlg.msgs
    .filter((msg) => msg.type === 'saying_msg' && msg.role === 'assistant')
    .map((msg) => msg.content);
  const tellaskResultContents = listTellaskResultContents(dlg.msgs);

  return { assistantSayings, tellaskResultContents };
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Parity probe: basic tellask flow.';
    const rootFirstResponse = [
      'Start.',
      '!?@pangu Please compute 1+1.',
      '!?Return only the number.',
    ].join('\n');
    const parsed = await parseSingleTellaskCall(rootFirstResponse);
    const language = getWorkLanguage();
    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      tellaskHead: parsed.tellaskHead,
      tellaskBody: parsed.body,
      language,
      collectiveTargets: ['pangu'],
    });
    const subdialogResponseText = '2';
    const expectedInjected = formatTeammateResponseContent({
      responderId: 'pangu',
      requesterId: 'tester',
      originalCallHeadLine: parsed.tellaskHead,
      responseBody: subdialogResponseText,
      language,
    });
    const rootResumeResponse = 'Ack: parity tellask flow complete.';

    await writeMockDb(tmpRoot, [
      { message: trigger, role: 'user', response: rootFirstResponse },
      { message: expectedSubdialogPrompt, role: 'user', response: subdialogResponseText },
      { message: expectedInjected, role: 'user', response: rootResumeResponse },
    ]);

    const v1Summary = await runScenario(
      driveDialogStreamV1,
      trigger,
      rootResumeResponse,
      'driver-v2-parity-v1-basic-tellask',
    );
    const v2Summary = await runScenario(
      driveDialogStreamV2,
      trigger,
      rootResumeResponse,
      'driver-v2-parity-v2-basic-tellask',
    );

    assert.deepEqual(v2Summary, v1Summary, 'v2 summary should match v1 in basic tellask flow');
  });

  console.log('driver-v2 v1-v2-parity-basic-tellask: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 v1-v2-parity-basic-tellask: FAIL\n${message}`);
  process.exit(1);
});
