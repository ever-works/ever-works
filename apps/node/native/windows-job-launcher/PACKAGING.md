# Windows Job launcher packaging boundary

This Phase 1 package builds one `win32-x64` helper. It is deliberately not exported by an application barrel, wired into the production process factory, downloaded at runtime, installed as a service, or published by CI.

## Reproducible build input

- Rust is pinned by `rust-toolchain.toml`; `windows-sys` is exact-pinned and `Cargo.lock` is committed.
- `build-release.ps1` uses `cargo build --locked --release --target x86_64-pc-windows-msvc` and the MSVC `/Brepro` linker flag.
- The generated JSON contains no timestamp or host path. It records the source commit, target, toolchain, binary size and SHA-256, and the `Cargo.lock` SHA-256.
- CI builds and tests the helper but does not upload, sign, publish, deploy, or install it.

## Phase 2 trust hooks

Before production wiring, a separate reviewed release pipeline must:

1. Generate a CycloneDX or SPDX SBOM from the locked Rust dependency graph and bind its digest into provenance.
2. Authenticode-sign the already-hashed release binary using an external signing identity; the private key must never enter the repository or node environment.
3. Publish the binary, signature/provenance, SBOM, and expected SHA-256 as one immutable versioned set.
4. Package that set with the node installer. Runtime code must use an explicit application-owned absolute path and verify the Authenticode chain plus pinned SHA-256 before launch.

Runtime download, `PATH` lookup, `.cmd`/`.bat` shims, and binaries selected from temp or workspace directories remain prohibited. The Node adapter accepts only an explicit child environment; provider credential discovery/injection and the future local credential broker are outside Phase 1.

## Phase 2 integration boundary

After this package and the separate model-process lifecycle change are reviewed, integration may add a private production factory that selects this adapter on Windows. That later change owns binary discovery from the trusted installed package, signature/hash enforcement, application lifecycle wiring, and end-to-end Fleet cancellation tests. Phase 1 intentionally does not edit `model-process.internal.ts`, its specs, `core/index.ts`, installers, or Windows services.
