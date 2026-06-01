import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webappRoot = path.resolve(scriptDir, '..');
const distDir = path.join(webappRoot, 'dist');
const entryPoint = path.join(webappRoot, 'src', 'main.ts');

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function toDistHref(outputPath) {
  const absoluteOutputPath = path.isAbsolute(outputPath)
    ? outputPath
    : path.resolve(process.cwd(), outputPath);
  return `/${toPosixPath(path.relative(distDir, absoluteOutputPath))}`;
}

function findEntryOutput(outputs) {
  for (const [outputPath, output] of Object.entries(outputs)) {
    if (output.entryPoint && output.entryPoint.endsWith('src/main.ts')) {
      return { outputPath, output };
    }
  }
  throw new Error('esbuild did not report an output for src/main.ts');
}

async function renderIndexHtml(params) {
  const indexTemplatePath = path.join(webappRoot, 'index.html');
  let html = await fs.readFile(indexTemplatePath, 'utf8');

  html = html.replace(
    /^\s*<link rel="stylesheet" href="\/src\/assets\/(?:tokens|base)\.css" \/>\n/gm,
    '',
  );
  html = html.replace(
    /<link rel="icon" type="image\/svg\+xml" href="src\/assets\/favicon\.svg" \/>/,
    '<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />',
  );

  if (params.cssHref) {
    const htmlWithStylesheet = html.replace(
      /  <\/head>/,
      `    <link rel="stylesheet" href="${params.cssHref}" />\n  </head>`,
    );
    if (htmlWithStylesheet === html) {
      throw new Error('Failed to insert webapp stylesheet tag');
    }
    html = htmlWithStylesheet;
  }

  const scriptReplacement = `    <script type="module" src="${params.jsHref}"></script>`;
  const nextHtml = html.replace(
    /    <script type="module" src="\.\/src\/main\.ts"><\/script>/,
    scriptReplacement,
  );
  if (nextHtml === html) {
    throw new Error('Failed to replace webapp index script tag');
  }

  await fs.writeFile(path.join(distDir, 'index.html'), nextHtml);
}

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: 'es2022',
  outdir: distDir,
  entryNames: 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/',
  sourcemap: true,
  minify: false,
  metafile: true,
  loader: {
    '.svg': 'file',
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.otf': 'file',
  },
});

const { outputPath: jsOutputPath, output: jsOutput } = findEntryOutput(result.metafile.outputs);
const cssHref = jsOutput.cssBundle ? toDistHref(jsOutput.cssBundle) : null;
await fs.copyFile(
  path.join(webappRoot, 'src', 'assets', 'favicon.svg'),
  path.join(distDir, 'assets', 'favicon.svg'),
);
await renderIndexHtml({
  jsHref: toDistHref(jsOutputPath),
  cssHref,
});
