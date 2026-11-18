// Builds the static site into docs/ (served by GitHub Pages).
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { FIREBASE_CONFIG } from './src/firebase-config.js';

const SITE = 'https://siyabajaj330-boop.github.io/tapeout/';
const OUT = 'docs';
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

rmSync(`${OUT}/assets`, { recursive: true, force: true });
mkdirSync(`${OUT}/assets/fonts`, { recursive: true });

const result = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  outdir: `${OUT}/assets`,
  entryNames: 'app-[hash]',
  chunkNames: 'chunk-[hash]',
  loader: { '.json': 'json' },
  legalComments: 'linked',
  metafile: true,
  logLevel: 'warning',
});
const entry = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint === 'src/main.js')[0].split('/').pop();

const css = readFileSync('src/styles.css');
const cssName = `styles-${hash(css)}.css`;
writeFileSync(`${OUT}/assets/${cssName}`, css);

for (const [pkg, prefix, weights] of [['geist-sans', 'geist-sans', [400, 500, 600, 700]], ['geist-mono', 'geist-mono', [400, 500, 600]]]) {
  for (const w of weights) {
    const f = `${prefix}-latin-${w}-normal.woff2`;
    copyFileSync(`node_modules/@fontsource/${pkg}/files/${f}`, `${OUT}/assets/fonts/${f}`);
  }
}
copyFileSync('src/favicon.svg', `${OUT}/assets/favicon.svg`);
if (existsSync('src/og.png')) copyFileSync('src/og.png', `${OUT}/assets/og.png`);

const authDomain = FIREBASE_CONFIG.authDomain;
const csp = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://lh3.googleusercontent.com",
  "connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
  `frame-src ${authDomain ? 'https://' + authDomain + ' ' : ''}https://accounts.google.com https://apis.google.com`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  'upgrade-insecure-requests',
].join('; ');

const html = readFileSync('src/index.html', 'utf8')
  .replace('__CSP__', csp)
  .replaceAll('__SITE__', SITE)
  .replace('__CSS__', cssName)
  .replace('__JS__', entry);
writeFileSync(`${OUT}/index.html`, html);
writeFileSync(`${OUT}/404.html`, '<!DOCTYPE html><meta charset="utf-8"><title>Tapeout</title><meta http-equiv="refresh" content="0; url=/tapeout/"><a href="/tapeout/">Go to Tapeout</a>\n');
writeFileSync(`${OUT}/.nojekyll`, '');

const files = readdirSync(`${OUT}/assets`).filter((f) => f.endsWith('.js'));
const sizes = files.map((f) => `${f} ${(readFileSync(`${OUT}/assets/${f}`).length / 1024).toFixed(0)} KiB`);
console.log('entry:', entry, '| css:', cssName, '\n' + sizes.join('\n'));
