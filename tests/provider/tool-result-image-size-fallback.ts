import assert from 'node:assert/strict';
import type { ChatMessage } from '../../main/llm/client';
import {
  ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  buildImageBudgetKeyForContentItem,
  selectLatestImagesWithinBudget,
} from '../../main/llm/gen/tool-result-image-ingest';
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
const evidence = semanticEvidenceCollector('dominds-projection-image-budget-');
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const dialog = await createMainDialog();
    const fixture = providerHistory();
    const images = await Promise.all(
      [1, 2, 3].map((index) => fixtureImage(dialog, index, 20 * 1024 * 1024)),
    );
    for (const api of ['openai', 'openai-compatible', 'anthropic'] as const) {
      const selected = api === 'anthropic' ? images.slice(0, 2) : images;
      const context: ChatMessage[] = [
        fixture.user,
        fixture.call,
        {
          ...fixture.result,
          contentItems: [
            { type: 'input_text', text: fixture.result.content },
            ...selected.map((image) => image.item),
          ],
        },
      ];
      const projection = await projectImages(api, context);
      assert.deepEqual(
        nativeImageUrls(projection),
        selected.slice(api === 'anthropic' ? -1 : -2).map((image) => image.url),
      );
      assert.ok(
        projectionTextValues(projection).some((text) => text.includes(fixture.result.content)),
      );
      recordImageProjection(
        evidence,
        api + '-declared-budget',
        context,
        projection,
        `${api} keeps the newest artifacts within its current declared-byteLength budget; every artifact exists with distinct bytes.`,
      );
    }
    const oldImage = images[0]!,
      newImage = images[1]!;
    const oldUser = { ...fixture.user, contentItems: [oldImage.item] };
    const newTool = {
      ...fixture.result,
      contentItems: [{ type: 'input_text' as const, text: fixture.result.content }, newImage.item],
    };
    const unified: ChatMessage[] = [oldUser, fixture.call, newTool];
    const selected = selectLatestImagesWithinBudget(
      unified,
      ANTHROPIC_TOOL_RESULT_IMAGE_BUDGET_BYTES,
    );
    assert.deepEqual(
      [...selected],
      [
        buildImageBudgetKeyForContentItem({
          msg: newTool,
          itemIndex: 1,
          artifact: newImage.item.artifact,
        }),
      ],
    );
    assert.equal(
      selected.has(
        buildImageBudgetKeyForContentItem({
          msg: oldUser,
          itemIndex: 0,
          artifact: oldImage.item.artifact,
        }),
      ),
      false,
    );
    const projection = await projectImages('anthropic', unified);
    assert.deepEqual(nativeImageUrls(projection), [newImage.url]);
    recordImageProjection(
      evidence,
      'anthropic-cross-source-budget',
      unified,
      projection,
      'The same declared-byteLength budget spans user attachments and tool results; the newer tool artifact is selected.',
    );
    await evidence.write();
  });
  console.log('Image identity, native payload and declared-size selection: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
