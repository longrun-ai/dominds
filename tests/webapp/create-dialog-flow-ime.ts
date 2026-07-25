import assert from 'node:assert/strict';

import { isImeCompositionKeydown } from '../../webapp/src/components/create-dialog-flow';

const ordinaryEnter = {
  isComposing: false,
  keyCode: 13,
};

assert.equal(
  isImeCompositionKeydown(ordinaryEnter, false),
  false,
  'ordinary Enter should remain available for dialog creation',
);
assert.equal(
  isImeCompositionKeydown(ordinaryEnter, true),
  true,
  'locally tracked composition must keep Enter inside the IME',
);
assert.equal(
  isImeCompositionKeydown({ isComposing: true, keyCode: 13 }, false),
  true,
  'the native composition flag must keep Enter inside the IME',
);
assert.equal(
  isImeCompositionKeydown({ isComposing: false, keyCode: 229 }, false),
  true,
  'the legacy IME key code must keep Enter inside the IME',
);

console.log('webapp create dialog flow IME: PASS');
