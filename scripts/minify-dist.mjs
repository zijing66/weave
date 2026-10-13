#!/usr/bin/env node
/**
 * In-place production minify for compiled dist trees. tsc output is plain,
 * identifier-preserving JS — this pass mangles it (esbuild transform; ESM
 * syntax and import specifiers are untouched) so published packages and the
 * pack:weave bundle ship without readable sources. `.d.ts` files stay as
 * they are: the public type surface must remain readable.
 *
 *   node scripts/minify-dist.mjs <distDir>...   # no args = the five package dists
 */
import { transform } from 'esbuild';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DISTS = [
  'weave-core',
  'weave-harness',
  'weave-templates',
  'weave-server',
  'weave-cli',
].map((dir) => path.join(root, 'packages', dir, 'dist'));

async function listJsFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const targets =
  process.argv.length > 2 ? process.argv.slice(2).map((p) => path.resolve(p)) : DEFAULT_DISTS;

let fileCount = 0;
let bytesBefore = 0;
let bytesAfter = 0;
for (const dist of targets) {
  let files;
  try {
    files = await listJsFiles(dist);
  } catch {
    continue; // dist 不存在 = build 未跑过，跳过
  }
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const { code } = await transform(source, {
      minify: true,
      loader: 'js',
      legalComments: 'eof',
    });
    await writeFile(file, code);
    fileCount += 1;
    bytesBefore += source.length;
    bytesAfter += code.length;
  }
}
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`minified ${fileCount} dist files (${kb(bytesBefore)} → ${kb(bytesAfter)})`);
