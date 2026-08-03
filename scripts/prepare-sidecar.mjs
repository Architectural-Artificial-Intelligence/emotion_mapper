#!/usr/bin/env node
// Stages server/, public/, and a production-only node_modules/ into
// src-tauri/resources/ so Tauri can bundle them as app resources. Must run
// natively on each target OS so `canvas`/`sharp` install the correct
// platform binaries (see src-tauri/NOTES.md for why this can't be
// cross-compiled).

import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const resourcesDir = path.join(rootDir, 'src-tauri', 'resources');

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(resourcesDir, { recursive: true });

for (const entry of ['server', 'public', 'package.json', 'package-lock.json']) {
  cpSync(path.join(rootDir, entry), path.join(resourcesDir, entry), { recursive: true });
}

if (!existsSync(path.join(resourcesDir, 'package.json'))) {
  throw new Error(`expected ${resourcesDir}/package.json to exist after copy`);
}

console.log('Running npm ci --omit=dev inside staged resources (builds native canvas/sharp for this OS)...');
execFileSync('npm', ['ci', '--omit=dev'], { cwd: resourcesDir, stdio: 'inherit', shell: process.platform === 'win32' });

pruneSharpVariants(resourcesDir);

console.log(`Sidecar resources staged at ${resourcesDir}`);

// npm installs sharp's musl-libc variant defensively alongside the glibc one
// whenever it can't confidently detect the host libc (observed on this
// machine: both @img/sharp-linux-x64 and @img/sharp-linuxmusl-x64 got
// installed on plain glibc Ubuntu). The AppImage bundler (linuxdeploy)
// recursively resolves every .node/.so it finds and hard-fails trying to
// resolve the musl variant's libc.musl-x86_64.so.1, which doesn't exist on a
// glibc system — so the non-matching variant must be removed before bundling.
function pruneSharpVariants(dir) {
  const imgDir = path.join(dir, 'node_modules', '@img');
  if (!existsSync(imgDir)) return;
  const targetSuffix = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  for (const name of readdirSync(imgDir)) {
    if (!name.startsWith('sharp-') || name.endsWith(targetSuffix)) continue;
    rmSync(path.join(imgDir, name), { recursive: true, force: true });
    console.log(`Pruned non-target sharp variant: @img/${name}`);
  }
}
