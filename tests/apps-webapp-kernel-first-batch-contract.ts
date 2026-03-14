import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MUST_USE_KERNEL_IMPORTS: ReadonlyArray<
  Readonly<{ fileRel: string; needles: ReadonlyArray<string> }>
> = [
  {
    fileRel: 'webapp/src/services/api.ts',
    needles: [
      '@longrun-ai/kernel/types',
      '@longrun-ai/kernel/types/snippets',
      '@longrun-ai/kernel/utils/time',
    ],
  },
  {
    fileRel: 'webapp/src/services/websocket.ts',
    needles: [
      '@longrun-ai/kernel/evt',
      '@longrun-ai/kernel/types',
      '@longrun-ai/kernel/types/language',
    ],
  },
  {
    fileRel: 'webapp/src/i18n/ui.ts',
    needles: ['@longrun-ai/kernel/types/language'],
  },
  {
    fileRel: 'webapp/src/components/dominds-app.tsx',
    needles: ['@longrun-ai/kernel/diligence'],
  },
];

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');

  for (const entry of MUST_USE_KERNEL_IMPORTS) {
    const source = await fs.readFile(path.join(domindsRootAbs, entry.fileRel), 'utf-8');
    for (const needle of entry.needles) {
      assert.equal(
        source.includes(needle),
        true,
        `${entry.fileRel} must import ${needle} as part of the first WebUI symlink removal batch.`,
      );
    }
  }

  const sharedPathAbs = path.join(domindsRootAbs, 'webapp', 'src', 'shared');
  const sharedExists = await fs
    .access(sharedPathAbs)
    .then(() => true)
    .catch(() => false);
  assert.equal(
    sharedExists,
    false,
    'webapp/src/shared should be removed once the second migration batch lands.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
