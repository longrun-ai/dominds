import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MAIN_MUST_USE_KERNEL_IMPORTS: ReadonlyArray<
  Readonly<{ fileRel: string; needles: ReadonlyArray<string> }>
> = [
  {
    fileRel: 'main/persistence.ts',
    needles: [
      '@longrun-ai/kernel/types/context-health',
      '@longrun-ai/kernel/types/dialog',
      '@longrun-ai/kernel/types/language',
      '@longrun-ai/kernel/types/storage',
    ],
  },
  {
    fileRel: 'main/dialog.ts',
    needles: [
      '@longrun-ai/kernel/types/context-health',
      '@longrun-ai/kernel/types/dialog',
      '@longrun-ai/kernel/types/drive-intent',
      '@longrun-ai/kernel/types/language',
      '@longrun-ai/kernel/types/storage',
    ],
  },
  {
    fileRel: 'main/apps-host/client.ts',
    needles: ['@longrun-ai/kernel/app-json', '@longrun-ai/kernel/app-host-contract'],
  },
  {
    fileRel: 'main/apps-host/host.ts',
    needles: ['@longrun-ai/kernel/app-json', '@longrun-ai/kernel/app-host-contract'],
  },
  {
    fileRel: 'main/apps-host/ipc-types.ts',
    needles: ['@longrun-ai/kernel/app-json', '@longrun-ai/kernel/types/language'],
  },
  {
    fileRel: 'main/apps/run-control.ts',
    needles: ['@longrun-ai/kernel/app-host-contract'],
  },
  {
    fileRel: 'main/tools/app-reminders.ts',
    needles: ['@longrun-ai/kernel/app-json', '@longrun-ai/kernel/types/dialog'],
  },
];

const FORBIDDEN_MAIN_IMPORT_SNIPPETS = [
  'shared/types',
  'apps/app-json',
  'apps-host/app-host-contract',
  'main/runtime/',
  'main/bootstrap/',
  'main/markdown/',
] as const;

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');

  for (const entry of MAIN_MUST_USE_KERNEL_IMPORTS) {
    const source = await fs.readFile(path.join(domindsRootAbs, entry.fileRel), 'utf-8');
    for (const needle of entry.needles) {
      assert.equal(
        source.includes(needle),
        true,
        `${entry.fileRel} must import ${needle} as part of the main -> kernel Phase 1 cutover.`,
      );
    }
    for (const forbidden of FORBIDDEN_MAIN_IMPORT_SNIPPETS) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${entry.fileRel} must not keep local contract import snippet ${JSON.stringify(forbidden)}.`,
      );
    }
  }

  const removedPaths = [
    'main/apps/app-json.ts',
    'main/apps-host/app-host-contract.ts',
    'webapp/src/shared',
  ] as const;

  for (const relPath of removedPaths) {
    const exists = await fs
      .access(path.join(domindsRootAbs, relPath))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false, `${relPath} must be removed after the Phase 1 cutover.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
