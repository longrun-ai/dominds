import * as path from 'path';

export type RtwsCliParseResult = Readonly<{
  chdir?: string;
  argv: ReadonlyArray<string>;
}>;

export function extractGlobalRtwsChdir(
  params: Readonly<{
    argv: ReadonlyArray<string>;
    baseCwd?: string;
  }>,
): RtwsCliParseResult {
  const baseCwd = params.baseCwd ?? process.cwd();
  let chdir: string | undefined;
  const out: string[] = [];

  const readChdir = (argName: string, value: string): string => {
    if (value.trim() === '') throw new Error(`${argName} requires a directory argument`);
    return path.resolve(baseCwd, value);
  };

  for (let i = 0; i < params.argv.length; i++) {
    const arg = params.argv[i];

    if (arg === '--') {
      out.push(...params.argv.slice(i));
      break;
    }

    if (arg === '-C' || arg === '--cwd' || arg === '--chdir') {
      const next = params.argv[i + 1];
      if (typeof next !== 'string' || next.length === 0 || next === '--') {
        throw new Error(`${arg} requires a directory argument`);
      }
      chdir = readChdir(arg, next);
      i++;
      continue;
    }

    if (arg.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length);
      if (value.length === 0) throw new Error(`--cwd requires a directory argument`);
      chdir = readChdir('--cwd', value);
      continue;
    }

    if (arg.startsWith('--chdir=')) {
      const value = arg.slice('--chdir='.length);
      if (value.length === 0) throw new Error(`--chdir requires a directory argument`);
      chdir = readChdir('--chdir', value);
      continue;
    }

    out.push(arg);
  }

  return { chdir, argv: out };
}
