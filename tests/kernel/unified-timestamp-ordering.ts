import {
  compareUnifiedTimestamps,
  isUnifiedTimestampAfter,
  pickNewerUnifiedTimestamp,
} from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';

const older = '2026-05-16 10:00:00';
const newer = '2026-05-16 10:00:01';

(() => {
  assert.equal(isUnifiedTimestampAfter(newer, older), true);
  assert.equal(isUnifiedTimestampAfter(older, newer), false);
  assert.equal(isUnifiedTimestampAfter(older, older), false);
})();

(() => {
  assert.equal(pickNewerUnifiedTimestamp(older, newer), newer);
  assert.equal(pickNewerUnifiedTimestamp(newer, older), newer);
  assert.equal(pickNewerUnifiedTimestamp(newer, undefined), newer);
})();

(() => {
  assert.equal(
    compareUnifiedTimestamps('2026-05-16T10:00:01.000Z', '2026-05-16T10:00:00.000Z') > 0,
    true,
  );
  assert.equal(compareUnifiedTimestamps('invalid-b', 'invalid-a') > 0, true);
  assert.equal(
    pickNewerUnifiedTimestamp('invalid-current', newer),
    newer,
    'parseable event timestamps should beat invalid cached timestamps',
  );
})();
