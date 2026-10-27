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

**Signed** admission (P3, `ever-works-node helper admit --signed`): the node accepts a helper the operating system
judges signed by the publisher the node package names as the manifest target's `signer` — the Developer ID Team ID on
macOS, the Authenticode signer's subject under a machine root on Windows. The check is
`apps/node/src/core/screen/helper/helper-signature.ts`. Linux is always hash-pinned. Producing such a helper is the
release signing below.

## Release builds

`build-release.sh` (Linux, macOS) and `build-release.ps1` (Windows) build `--release --locked` twice in clean
target directories and compare the SHA-256 of both outputs; a mismatch fails the build. They write
`unsigned-release-metadata.json` with `productionEligible: false` — an unsigned helper is never a production
artifact — and the fingerprint the node package's `helper-manifest.json` (`helper-manifest.schema.json`) must carry
for that version and target. Publishing a helper and baking its fingerprints into a node release are separate,
owner-approved steps; nothing here uploads anything.

The fingerprint is reproducible on the machine that built it: two builds there are byte-identical. A build on another
machine matches only with the same linker and system libraries (the CI runners' fingerprints differ from a
workstation's), so a release takes its fingerprint from the one release machine, and anyone checking it rebuilds
with that machine's toolchain.

## Release signing

`release-signing.json` holds the public half: the signing **identifier** stamped into every macOS signature
(`works.ever.screen-helper`), and the publisher a release names as `signer` — `darwin.teamId` and `win32.subject`, both
`null` until the owner decides who signs and publishes helper releases (FL-07 owner question 7). The identity itself
(a keychain identity, a certificate with its private key) never enters the repository; the signing machine provides it
through the environment.

| OS      | Command (after the release build)                                                                               | Environment                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| macOS   | `bash sign-release.sh dist`: `codesign` with Developer ID, the identifier, the hardened runtime and a timestamp | `SCREEN_HELPER_SIGN_IDENTITY`, `SCREEN_HELPER_TEAM_ID` (or the config) |
| Windows | `./sign-release.ps1 -OutDir dist`: Authenticode SHA-256, chain without the root, RFC 3161 timestamp             | `SCREEN_HELPER_SIGN_CERT_THUMBPRINT`, `SCREEN_HELPER_TIMESTAMP_URL`    |

Each script then checks the signature the way the node will — macOS: the Developer ID requirement of the Team ID, and
the identifier as well; Windows: `Valid`, a machine root, a timestamp — and refuses to finish otherwise. It writes
`dist/signed/` with the signed binary and `signed-release-metadata.json`, whose `sha256` (the reproducible unsigned
build), `signedSha256` and `signer` are the manifest target's fields in
`apps/node/src/core/screen/helper/helper-manifest.ts`; a release adds the download `url`. Neither script uploads
anything. The `Screen Helper` workflow
runs both as dry runs (`SCREEN_HELPER_DRY_RUN=1`: an ad hoc signature; `-DryRun`: a throwaway self-signed certificate,
removed again), which prove the commands and that such a signature is not mistaken for a release.

Open, for the owner: who holds the identities and signs (question 7); the final identifier (question 17: changing it
after the first signed release re-asks every macOS permission and breaks a requirement that pins it); and whether the
node should pin the identifier and a minimum helper version beside the Team ID (question 17), and the issuing CA on
Windows (question 18). `helper install` checks a download against `sha256` only, so a release that serves the signed
build also needs the node to accept `signedSha256` there.
