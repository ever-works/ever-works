# `ever-works-screen` — packaging and trust

The native screen helper behind the **Desktop** source of a computer's live view (FL-07). It captures one display of
the machine and hands the node JPEG keyframes and changed 64 × 64 tiles over its stdin / stdout. This file states
what is and is not shipped.

> **Build status (2026-10-27).** First compiled with the pinned Rust 1.88.0. On Windows (MSVC) `cargo build`,
> `cargo test`, `cargo clippy -- -D warnings` and `cargo fmt --check` pass, and `cargo clippy` is also clean for
> Linux x64 and macOS x64 / arm64. `Cargo.lock` is committed and `build-release.ps1` produces byte-identical builds.
> A Windows build streamed this machine's desktop end to end (hello, keyframe, tiles, exit on stdin close). The
> `Screen Helper` workflow (`.github/workflows/screen-helper.yml`, not a required check) runs the same on Windows,
> Linux and macOS for pull requests that touch this folder, and on demand. How to build and admit a build of your
> own: [`README.md`](README.md).

## What it is

| Concern     | P1 (this crate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport   | The helper's own stdin / stdout, length-prefixed (`src/protocol.rs`). Same user, same session. No network port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Linux       | X11: RandR monitors, `GetImage` of the monitor's rectangle, XFixes pointer. Wayland is refused by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Windows     | GDI `BitBlt` (with `CAPTUREBLT`) of the monitor's rectangle, the pointer drawn in; per-monitor DPI aware.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| macOS       | CoreGraphics `CGDisplayCreateImage` after a Screen Recording preflight; Accessibility preflighted for control.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Changes     | 64 × 64 tiles diffed at the stream's width, each JPEG-encoded; a keyframe on cadence; ≤ 512 KiB per publish.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Input (P2)  | X11 XTest, Windows `SendInput` + `SetCursorPos`, macOS Quartz events (Accessibility). Pointer mapped from picture pixels to the display (`src/input/`); the blocked shortcuts refused a second time; every pressed key and button released on `releaseAll`, `stop`, a lost display and stdin close. The injector opens on the first input only. After a crash during control, the node starts a fresh helper whose only command is `releaseHeld` (every modifier and button the OS reports held is released; nothing is pressed), and a helper that panics after injecting does the same before it aborts. |
| Environment | The node passes `DISPLAY`, `XAUTHORITY`, `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY` (Linux) and nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Faster capture paths are follow-ups behind the same `Capturer` trait: XShm on X11, DXGI desktop duplication on
Windows (dirty rectangles for free), ScreenCaptureKit on macOS (`CGDisplayCreateImage` is deprecated on recent
macOS releases and does not draw the pointer).

## Where it runs

P1 runs the helper as a **direct child of the node**. That works when the node itself runs in the person's desktop
session (started from a terminal, or as a per-user login item). When the node runs as a system service it has no
desktop to capture, and the helper says so (`no-display-session` on Windows session 0, no `DISPLAY` on Linux). The
plan's launches into the interactive session — a per-user LaunchAgent on macOS with a `0600` Unix socket, a one-off
scheduled task into the console session on Windows with an owner-only named pipe — are follow-ups.

On macOS the Screen Recording permission is granted to the process macOS holds responsible for the helper (the
terminal or app that started the node). A hash-pinned helper asks again after each update; a signed one (P3) keeps
the grant.

## Trust

The node never starts a helper it has not verified **immediately before the start** against the owner's admission
record (`helper-policy.json` in the node's config directory, written `0600`):

1. `ever-works-node helper install` downloads the build the node package's `helper-manifest.json` names for this
   platform and checks its SHA-256 against the manifest before keeping it.
2. `ever-works-node helper admit` prints the file's SHA-256 beside the published one and records the admission only
   after the owner types `admit` (**hash-pinned**, shown as "Reduced trust"). A fingerprint the manifest does not
   publish needs `--allow-unpublished` and is recorded as unpublished.
3. Before every start the node re-hashes the file; a different byte refuses the start with `helper-untrusted`, reports
   `helperTrust: none` and writes `node.helper.verify-failed` to the fleet audit.
4. `ever-works-node helper revoke` removes the record and stops a running helper within 2 seconds.
5. **Control** (P2) needs one more act on the machine: `ever-works-node helper control allow` explains what control
   means and records it only after the owner types `control`, bound to this admission (approving the helper again
   turns control off). `helper control deny` releases every key and button and ends a live control within a second.

**Signed** admission (Developer ID + Team ID on macOS, Authenticode on Windows through the existing broker) is P3.
Linux is always hash-pinned.

## Release builds

`build-release.sh` (Linux, macOS) and `build-release.ps1` (Windows) build `--release --locked` twice in clean
target directories and compare the SHA-256 of both outputs; a mismatch fails the build. They write
`unsigned-release-metadata.json` with `productionEligible: false` — an unsigned helper is never a production
artifact — and the fingerprint the node package's `helper-manifest.json` (`helper-manifest.schema.json`) must carry
for that version and target. Publishing a helper and baking its fingerprints into a node release are separate,
owner-approved steps; nothing here uploads anything.
