# Status: verified locally on Linux (glibc x64), Windows unverified

This scaffold was originally written without a local Rust toolchain, so the
API details below were best-effort guesses. Rust + Tauri's Linux system deps
were then installed and the full pipeline was exercised locally end-to-end
(`npm run prepare:sidecar` → `tauri build --debug` → extracted the built
`.deb` → ran the installed layout directly → confirmed `/health`, DXF import,
Documents-folder data relocation, and both native addons `sharp`/`canvas`
executing real operations from the packaged `node_modules`). Findings below.

## Confirmed correct as originally written

- `handle.path().document_dir()`, `handle.shell().sidecar("node")...spawn()`,
  `CommandEvent::{Stdout,Stderr,Terminated}`, and `window.eval(...)`-based
  navigation all compiled and worked exactly as guessed — no changes needed.
- `capabilities/default.json`'s `shell:allow-execute` permission shape was
  correct: the sidecar spawned without any permission-denied error.

## Bugs found and fixed during local verification

1. **`plugins.shell.sidecar` is not a valid config key.** Tauri panicked at
   startup: `unknown field 'sidecar', expected 'open'`. The sidecar
   permission is granted entirely through `capabilities/default.json`
   (`shell:allow-execute`) plus `bundle.externalBin` — the `plugins.shell`
   block should only be used for the `open` field, and was removed here.
2. **`resource_dir()` resolves one level above the actual resources.**
   It returns the app's install directory (e.g. `/usr/lib/Emotion Mapper/` for
   a `.deb`), not the `resources/` subfolder itself — `bundle.resources`
   entries land in a `resources/` child directory beneath that. `main.rs` now
   does `resource_dir().join("resources")` before using it as the sidecar's
   `current_dir`. Without this fix Node failed immediately with
   `Cannot find module '.../server/app.js'`.
3. **`npm ci` installed sharp's musl-libc variant on plain glibc Ubuntu**
   (both `@img/sharp-linux-x64` and `@img/sharp-linuxmusl-x64` ended up in
   `node_modules`). This alone is harmless, but the AppImage bundler
   (`linuxdeploy`) recursively resolves every `.node`/`.so` file it finds and
   hard-fails trying to resolve the musl variant's `libc.musl-x86_64.so.1`,
   which doesn't exist on a glibc system. Fixed by pruning non-matching
   `@img/sharp-*` variants in `scripts/prepare-sidecar.mjs` after `npm ci`.
4. Bundle identifier `com.emotionmapper.app` triggered a Tauri warning
   (the `.app` suffix collides with macOS's app-bundle extension) — changed
   to `com.emotionmapper.desktop`.

## Confirmed real, out-of-scope limitation (not a bug to fix here)

Sending `SIGTERM`/`SIGKILL` directly to the Tauri process (rather than
closing the window through the UI) leaves the Node sidecar running as an
orphan — confirmed by testing both the window-close path's `CloseRequested`
handler and the added `RunEvent::Exit` backstop, neither of which fires on a
raw signal to the parent. This matches the plan's documented scope: normal
"quit via the window" is handled; OS-level force-kill of the parent is not.
A fully robust fix (process-group kill, or a supervisor) is a follow-up item,
not attempted here.

## Still unverified

- **Windows build.** Only Linux was exercised locally (this machine has no
  Windows environment). The GitHub Actions matrix job for `windows-latest`
  is the first real test of the `.msi`/NSIS path, the `node-x86_64-pc-windows-msvc.exe`
  sidecar naming, and whether the same `resource_dir()` + `resources/` join
  fix applies identically on Windows's install layout — verify the first CI
  run's Windows artifact by hand rather than assuming it mirrors Linux.
- **AppImage on other distros.** Confirmed to build and the bundler resolves
  dependencies correctly after the sharp-variant fix, but was not actually
  launched (no need — the `.deb`-extracted layout already proved the sidecar
  path resolution and native addons work; AppImage uses the same Rust binary
  and resource layout).
