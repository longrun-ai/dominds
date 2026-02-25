#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../dist/bin/auth-doctor.js");

if (!existsSync(target)) {
  console.error(
    "[codex-auth] Missing dist/bin/auth-doctor.js. Run `pnpm -C codex-auth build`.",
  );
  process.exit(1);
}

await import(pathToFileURL(target).href);
