#!/usr/bin/env node
// Downloads the official Node.js prebuilt runtime for the current build
// target and stages it under src-tauri/binaries/ using Tauri's sidecar
// naming convention: <name>-<rust-target-triple>[.exe].
//
// Env vars (set explicitly per-OS in CI, see .github/workflows/build-desktop.yml;
// auto-detected from the host when unset, so local `npm run tauri:dev` works
// with no setup on a supported OS/arch):
//   NODE_PLATFORM  "win" | "linux"
//   NODE_ARCH      "x64"
//   RUST_TARGET    e.g. "x86_64-pc-windows-msvc" or "x86_64-unknown-linux-gnu"

import { mkdirSync, createWriteStream, chmodSync, cpSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const NODE_VERSION = '20.18.1'; // pinned sidecar runtime; independent of the Node running this script

const PLATFORM_DEFAULTS = {
  win32: { NODE_PLATFORM: 'win', NODE_ARCH: 'x64', RUST_TARGET: 'x86_64-pc-windows-msvc' },
  linux: { NODE_PLATFORM: 'linux', NODE_ARCH: 'x64', RUST_TARGET: 'x86_64-unknown-linux-gnu' },
};
const hostDefaults = PLATFORM_DEFAULTS[process.platform];
if (!hostDefaults && (!process.env.NODE_PLATFORM || !process.env.NODE_ARCH || !process.env.RUST_TARGET)) {
  throw new Error(`no default sidecar target for host platform "${process.platform}"; set NODE_PLATFORM/NODE_ARCH/RUST_TARGET explicitly`);
}

const NODE_PLATFORM = process.env.NODE_PLATFORM || hostDefaults.NODE_PLATFORM;
const NODE_ARCH = process.env.NODE_ARCH || hostDefaults.NODE_ARCH;
const RUST_TARGET = process.env.RUST_TARGET || hostDefaults.RUST_TARGET;

const rootDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const binariesDir = path.join(rootDir, 'src-tauri', 'binaries');
mkdirSync(binariesDir, { recursive: true });

const existingBinary = path.join(binariesDir, `node-${RUST_TARGET}${NODE_PLATFORM === 'win' ? '.exe' : ''}`);
if (existsSync(existingBinary)) {
  console.log(`Sidecar Node runtime already staged at ${existingBinary}, skipping download.`);
  process.exit(0);
}

const isWin = NODE_PLATFORM === 'win';
const archiveExt = isWin ? 'zip' : 'tar.xz';
const distName = `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${distName}.${archiveExt}`;

const tmpDir = path.join(os.tmpdir(), `emotion-mapper-node-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const archivePath = path.join(tmpDir, `${distName}.${archiveExt}`);

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`failed to download ${url}: ${res.status}`);
await finished(Readable.fromWeb(res.body).pipe(createWriteStream(archivePath)));

console.log(`Extracting ${archivePath}`);
// Windows' bundled bsdtar (tar.exe) auto-detects zip as well as tar.xz, so a
// single `tar -xf` works for both archive formats on both OSes.
execFileSync('tar', ['-xf', archivePath, '-C', tmpDir], { stdio: 'inherit' });

const extractedDir = path.join(tmpDir, distName);
const sourceBinary = isWin ? path.join(extractedDir, 'node.exe') : path.join(extractedDir, 'bin', 'node');
const destBinary = path.join(binariesDir, `node-${RUST_TARGET}${isWin ? '.exe' : ''}`);

cpSync(sourceBinary, destBinary);
if (!isWin) chmodSync(destBinary, 0o755);
rmSync(tmpDir, { recursive: true, force: true });

console.log(`Node ${NODE_VERSION} runtime staged at ${destBinary}`);
