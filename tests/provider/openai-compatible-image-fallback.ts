import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { ChatMessage } from '../../main/llm/client';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';
import { providerHistory } from '../helpers/provider-context';
import {
  fixtureImage,
  nativeImageUrls,
  projectImages,
  projectionTextValues,
  recordImageProjection,
} from '../helpers/provider-images';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-projection-image-missing-');
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const dialog = await createMainDialog();
    const image = await fixtureImage(dialog, 7);
    await fs.unlink(image.file);
    const fixture = providerHistory();
    const context: ChatMessage[] = [
      fixture.user,
      fixture.call,
      {
        ...fixture.result,
        contentItems: [{ type: 'input_text', text: fixture.result.content }, image.item],
      },
    ];
    const missing = await projectImages('openai-compatible', context);
    assert.deepEqual(nativeImageUrls(missing), []);
    assert.ok(projectionTextValues(missing).some((text) => text.includes(fixture.result.content)));
    recordImageProjection(
      evidence,
      'capable-missing-artifact',
      context,
      missing,
      'The selected model explicitly supports images, but its referenced local artifact is absent. Request construction completes with text fallback.',
    );
    await fs.writeFile(image.file, image.bytes);
    const restored = await projectImages('openai-compatible', context);
    assert.deepEqual(nativeImageUrls(restored), [image.url]);
    recordImageProjection(
      evidence,
      'capable-restored-artifact',
      context,
      restored,
      'The same capability and history now reference a restored artifact; actual native payload equals the supplied bytes.',
    );
    const defaultPath = await buildOpenAiCompatibleRequestMessagesWrapper('', context);
    assert.deepEqual(nativeImageUrls(defaultPath), []);
    recordImageProjection(
      evidence,
      'default-path-with-present-artifact',
      context,
      defaultPath,
      'The artifact exists, but this unconfigured compatible path has no explicit image-capable model.',
    );
    await evidence.write();
  });
  console.log('Compatible image capability, missing fallback and restored bytes: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
