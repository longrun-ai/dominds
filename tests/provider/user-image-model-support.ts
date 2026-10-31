import assert from 'node:assert/strict';
import type { ChatMessage } from '../../main/llm/client';
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
const evidence = semanticEvidenceCollector('dominds-projection-model-images-');
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const dialog = await createMainDialog();
    const userImage = await fixtureImage(dialog, 11),
      toolImage = await fixtureImage(dialog, 12);
    const fixture = providerHistory();
    const context: ChatMessage[] = [
      { ...fixture.user, contentItems: [userImage.item] },
      fixture.call,
      {
        ...fixture.result,
        contentItems: [{ type: 'input_text', text: fixture.result.content }, toolImage.item],
      },
    ];
    for (const supports of [false, true]) {
      const projection = await projectImages('anthropic', context, supports);
      assert.deepEqual(nativeImageUrls(projection), supports ? [userImage.url, toolImage.url] : []);
      // Exact supplied data fidelity; generated omission explanations are reviewed separately.
      for (const supplied of [fixture.user.content, fixture.result.content])
        assert.ok(projectionTextValues(projection).some((text) => text.includes(supplied)));
      recordImageProjection(
        evidence,
        supports ? 'model-images-enabled' : 'model-images-disabled',
        context,
        projection,
        `Anthropic model supports_image_input=${supports}; both user and tool artifacts actually exist. Only model capability changes between these two projections.`,
      );
    }
    await evidence.write();
  });
  console.log('User and tool image capability with real-file positive control: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
