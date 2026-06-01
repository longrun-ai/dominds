import fs from 'node:fs/promises';
import path from 'node:path';

if (process.argv.length < 3) {
  throw new Error('Usage: node scripts/rm-dir.mjs <dir> [dir...]');
}

for (const dir of process.argv.slice(2)) {
  const target = path.resolve(process.cwd(), dir);
  await fs.rm(target, { recursive: true, force: true });
}
