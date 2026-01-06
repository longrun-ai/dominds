import { Dialog, DialogID } from 'dominds/dialog';
import { dialogEventRegistry } from 'dominds/evt-registry';
import { driveDialogStream } from 'dominds/llm/driver';
import { DiskFileDialogStore } from 'dominds/persistence';
import type { TypedDialogEvent } from 'dominds/shared/types/dialog';
import { Team } from 'dominds/team';
import { generateDialogID } from 'dominds/utils/id';
import path from 'path';

async function main() {
  try {
    process.chdir(path.resolve(process.cwd(), 'tests/script-rtws'));
  } catch (err) {
    console.debug('Failed to change to tests/script-rtws directory, using current directory', err);
  }
  const team = await Team.load();
  const agentIdArg = process.argv.find((a) => a.startsWith('--agent='))?.split('=')[1];
  const taskArg = process.argv.find((a) => a.startsWith('--task='))?.split('=')[1];
  const promptArg = process.argv.find((a) => a.startsWith('--prompt='))?.split('=')[1];
  const agentId = agentIdArg || team.defaultResponder || Object.keys(team.members)[0];
  const taskDocPath = taskArg || 'test-tracks.md';
  const generatedId = generateDialogID();
  const dialogId = new DialogID(generatedId);
  const store = new DiskFileDialogStore(dialogId);
  const dialog = new Dialog(store, taskDocPath, dialogId, agentId);
  dialogEventRegistry.getPubChan(dialogId);
  const prompt = promptArg || 'Verify streaming dispatch and event flow.';

  let starts = 0;
  let chunks = 0;
  let ends = 0;
  let streamErrors = 0;
  let generatingStarted = false;
  let generatingFinished = false;
  let thinkingStarted = false;
  let thinkingEnded = false;
  let sayingStarted = false;
  let sayingEnded = false;
  let callingStarted = false;
  let callingEnded = false;
  let driveError: string | null = null;
  let timeoutHit = false;

  const timeoutMs = Number(process.env.DRIVE_TIMEOUT_MS || '15000');
  const sub = dialogEventRegistry.createSubChan(dialogId);
  const timeoutHandle = setTimeout(() => {
    timeoutHit = true;
    sub.cancel();
    console.error(
      JSON.stringify({
        type: 'drive_timeout',
        timeoutMs,
        dialogKey: dialogId.key(),
      }),
    );
    process.exit(1);
  }, timeoutMs);

  const producer = driveDialogStream(dialog, {
    content: prompt,
    msgId: generateDialogID(),
  }).catch((e: unknown) => {
    driveError = String(e instanceof Error ? e.message : e);
    console.error(
      JSON.stringify({ type: 'drive_error', dialogKey: dialogId.key(), error: driveError }),
    );
  });

  const consumer = (async () => {
    for await (const ev of sub.stream()) {
      if (ev.dialog.selfId !== dialogId.selfId || ev.dialog.rootId !== dialogId.rootId) continue;

      const dialogKey =
        ev.dialog.rootId === ev.dialog.selfId
          ? ev.dialog.selfId
          : `${ev.dialog.rootId}#${ev.dialog.selfId}`;
      switch (ev.type) {
        case 'generating_start_evt':
          starts += 1;
          generatingStarted = true;
          console.log(
            JSON.stringify({ type: ev.type, dialogKey, round: ev.round, genseq: ev.genseq }),
          );
          break;
        case 'generating_finish_evt':
          ends += 1;
          generatingFinished = true;
          console.log(
            JSON.stringify({ type: ev.type, dialogKey, round: ev.round, genseq: ev.genseq }),
          );
          return;
        case 'thinking_start_evt':
          starts += 1;
          thinkingStarted = true;
          console.log(JSON.stringify({ type: ev.type, dialogKey }));
          break;
        case 'thinking_chunk_evt':
          chunks += 1;
          console.log(
            JSON.stringify({
              type: ev.type,
              dialogKey,
              len: ev.chunk.length,
              preview: ev.chunk.slice(0, 80),
            }),
          );
          break;
        case 'thinking_finish_evt':
          ends += 1;
          thinkingEnded = true;
          console.log(JSON.stringify({ type: ev.type, dialogKey }));
          break;
        case 'saying_start_evt':
          starts += 1;
          sayingStarted = true;
          console.log(JSON.stringify({ type: ev.type, dialogKey }));
          break;
        case 'saying_finish_evt':
          ends += 1;
          sayingEnded = true;
          console.log(JSON.stringify({ type: ev.type, dialogKey }));
          break;
        case 'calling_start_evt':
          starts += 1;
          callingStarted = true;
          console.log(JSON.stringify({ type: ev.type, dialogKey, firstMention: ev.firstMention }));
          break;
        case 'calling_headline_chunk_evt':
        case 'calling_body_chunk_evt':
          chunks += 1;
          console.log(
            JSON.stringify({
              type: ev.type,
              dialogKey,
              len: ev.chunk.length,
              preview: ev.chunk.slice(0, 80),
            }),
          );
          break;
        case 'calling_finish_evt':
          ends += 1;
          callingEnded = true;
          console.log(JSON.stringify({ type: ev.type, dialogKey }));
          break;
        case 'stream_error_evt':
          streamErrors += 1;
          console.log(JSON.stringify({ type: ev.type, dialogKey, error: ev.error }));
          return;
        case 'func_result_evt':
        case 'tool_call_response_evt':
        case 'round_update':
        case 'questions_count_update':
        case 'full_reminders_update':
        case 'subdialog_created_evt':
        case 'end_of_user_saying_evt':
        case 'markdown_start_evt':
        case 'markdown_chunk_evt':
        case 'markdown_finish_evt':
        case 'codeblock_start_evt':
        case 'codeblock_chunk_evt':
        case 'codeblock_finish_evt':
        case 'tool_call_headline_finish_evt':
        case 'tool_call_body_start_evt':
        case 'tool_call_body_finish_evt':
          console.log(
            JSON.stringify({ type: ev.type, dialogKey } satisfies {
              type: TypedDialogEvent['type'];
              dialogKey: string;
            }),
          );
          break;
        default: {
          const _exhaustive: never = ev;
          void _exhaustive;
        }
      }
    }
  })();

  await Promise.all([producer, consumer]);

  clearTimeout(timeoutHandle);
  sub.cancel();

  const invariantsOk =
    generatingStarted &&
    generatingFinished &&
    (thinkingStarted ? thinkingEnded : true) &&
    (sayingStarted ? sayingEnded : true) &&
    (callingStarted ? callingEnded : true);

  console.log(
    JSON.stringify({
      summary: {
        starts,
        chunks,
        ends,
        streamErrors,
        timeoutHit,
        driveError,
        generatingStarted,
        generatingFinished,
        thinkingStarted,
        thinkingEnded,
        sayingStarted,
        sayingEnded,
        callingStarted,
        callingEnded,
      },
    }),
  );

  if (!invariantsOk || streamErrors > 0 || driveError !== null || timeoutHit) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
