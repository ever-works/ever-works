# Windows Job launcher packaging and runtime trust boundary

This package builds one `win32-x64` native helper. Phase 2 wires it into the private model-process factory, but this repository still does not publish, download, deploy, install, or register the helper as a Windows service. Production containment remains unavailable until a node operator supplies a complete trust policy for an externally signed, immutably installed artifact.

## Reproducible unsigned build

- `rust-toolchain.toml`, the exact `windows-sys` dependency, and committed `Cargo.lock` pin the Rust inputs.
- `build-release.ps1` removes every inherited `CARGO_*`, `RUST*`, and `GIT_*` input and native MSVC `LINK` / `_LINK_` option before the first external command. Inherited `PATH`, `ProgramFiles`, `ProgramFiles(x86)`, profile overrides, encoded/target Rust flags, compiler/wrapper selections, and Git repository/config selectors are not discovery inputs. Git and `vswhere` are resolved only from OS-known absolute Program Files roots; Rust 1.88 is resolved only from the OS-known user-profile root and must match the checked-in binary/DLL and target-library file-set digests in `trusted-build-toolchain.json`. Git, `vswhere`, `link.exe`, and `cvtres.exe` must have `Status=Valid` Authenticode signatures from their exact pinned publishers. Visual Studio must remain below an OS-known Program Files root, while the Windows SDK must resolve from its machine installation-registry root; every resulting tool/library path must be canonical, local, and non-reparse.
- Cargo runs from a random per-invocation directory below the OS-known Local AppData root, never from an environment-derived temp path. Every existing path component is canonicalized and rejected if it is a reparse point. The directory has a protected private ACL that grants the build identity read/execute but no create/write/delete rights, and its ACL, ancestry, reparse state, and absence of `.cargo/config*` are revalidated immediately before each Cargo invocation. The script uses an isolated `CARGO_HOME`, fixed absolute compiler/linker paths, disabled caches and incremental compilation, `SOURCE_DATE_EPOCH` from the source commit, and exactly `-C link-arg=/Brepro`.
- One invocation deletes and builds two separate target trees (`target/repro-build-1` and `target/repro-build-2`). It hashes both executables directly and emits `reproducible: true` only after their raw SHA-256 values are identical. CI verifies both retained executables against that evidence rather than rerunning a cached build or comparing JSON alone.
- Generated JSON uses stable ordering, UTF-8 without BOM, and no timestamp or host path.
- The generated unsigned metadata records `productionEligible: false`, both reproducibility hashes, a canonical PE content hash, the lockfile SHA-256, source commit, target, size, SBOM digest, and provenance digest. Build inputs bind the exact Rust/Cargo executables, fixed Rust flags, normalized environment policy, MSVC toolset and linker, and MSVC/Windows SDK library-set digests.
- Script-produced metadata always uses the stable builder identity `local-untrusted` / `urn:ever-works:builder:build-release-script:v3`. GitHub and runner environment fields are retained only as `untrusted-environment` invocation hints; environment variables cannot authenticate GitHub Actions. The repository pin and host Authenticode checks prevent inherited discovery inputs from silently selecting different tools, but they do not authenticate the runner, its trust store, the original choice of reviewed pin, or the installed MSVC/SDK image. Metadata therefore explicitly records `externalAuthenticatedRunnerAttestation: required`; authenticated GitHub provenance requires a separate OIDC/GitHub-attestation boundary.
- The deterministic CycloneDX 1.5 SBOM is derived from locked Cargo metadata. The in-toto/SLSA provenance binds the unsigned binary, source commit, lockfile, and SBOM.
- CI builds a clean control pair and a second clean pair under hostile profile, wrapper, encoded-flag, target, and spoofed GitHub environment inputs, then compares the executable hashes directly. It retains outputs only inside the job workspace; no workflow step uploads or publishes a binary.

The unsigned build SHA-256 is reproducibility metadata only. It is never valid as the production runtime `expectedSha256` because Authenticode signing changes the artifact bytes.

## Post-sign manifest contract

Signing happens outside this repository with an externally controlled code-signing identity. `create-signed-manifest.ps1` does not sign anything. It requires both the actual unsigned artifact and the already-signed artifact, holds no-write/no-delete leases while inspecting each, and fails closed unless:

1. the unsigned metadata passes the checked-in JSON schema;
2. the actual unsigned artifact's raw SHA-256, size, unsigned canonical PE identity, and both clean-build hashes match that metadata;
3. the SBOM and provenance file digests match, and every mirrored in-toto claim matches the schema-validated metadata and actual locked inputs: subject/hash, checked-out source commit and epoch, Cargo.lock, SBOM, build definition, build inputs/tool policy, builder, invocation/environment evidence, and both reproducibility records;
4. the recorded unsigned size and canonical PE content hash prove that the signed file is the exact verified unsigned binary with only the PE checksum, security-directory entry, zero alignment padding, and appended Authenticode certificate table changed;
5. the certificate table is the sole aligned append and ends exactly at EOF;
6. `Get-AuthenticodeSignature` returns `Status=Valid`;
7. the leaf certificate subject exactly equals the configured publisher subject;
8. the leaf certificate SHA-256 exactly equals the configured pin; and
9. the signed artifact SHA-256 differs from the verified unsigned build hash.

The canonical derivation deliberately excludes only fields Authenticode signing is allowed to change. It rejects a different PE signed by the same pinned certificate, nonzero alignment padding, overlays after the certificate table, and mutations anywhere else in the recorded unsigned bytes. Signature validity remains a separate fail-closed requirement; canonical equivalence alone never establishes trust.

The resulting manifest deliberately remains `productionEligible: false` with `releaseApproval: required`. A later externally reviewed release/installer lane must approve an actual production certificate, package the immutable signed set, protect its ACLs, and place the signed artifact hash and exact certificate pins in node-owned configuration. This slice has no real signing certificate and makes no production-eligible artifact claim.

`unsigned-release-metadata.schema.json` and `signed-artifact-manifest.schema.json` keep the unsigned reproducibility hash and final signed runtime hash structurally distinct.

## Runtime trust and TOCTOU defense

On Windows, `createModelProcessExecutor` selects native containment only when `windowsJobLauncher` supplies all of:

- a normalized local drive-absolute `.exe` path;
- the SHA-256 of the final signed helper;
- the exact Authenticode leaf publisher subject; and
- the exact leaf certificate SHA-256.

The runtime never searches `PATH`, uses the current directory, accepts UNC/device paths, or falls back to `child_process` on Windows. It invokes the absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` with an integrity-bound encoded broker command—never a mutable script and never `-ExecutionPolicy Bypass`.

For every probe and model run, the broker:

1. opens each configured path component with `FILE_FLAG_OPEN_REPARSE_POINT` and rejects any reparse point;
2. confirms the helper's handle-resolved canonical path equals the configured local absolute path;
3. holds read-only handles that deny write/delete sharing from verification through helper lifetime;
4. hashes the held file stream and checks `Status=Valid`, exact publisher subject, and exact leaf certificate SHA-256;
5. starts the helper with `UseShellExecute=false` and an explicitly cleared environment;
6. repeats hash and Authenticode verification before forwarding any native protocol bytes; and
7. retains all leases until the helper exits.

The broker itself receives only `SystemRoot`, `WINDIR`, and the non-secret trust policy. Provider credentials are never placed in the broker/helper environment. Raw provider credentials remain refused by the separately reviewed model-executor boundary; locally authenticated model configuration is passed only in the native launch protocol for the model child.

Broker death closes its private helper stdin/stdout pipes. The native helper treats parent EOF/output loss as a cancellation condition, terminates its kill-on-close Job, and verifies an empty Job before a normal completion can be trusted. Cancellation, deadline, output-limit, malformed-protocol, and broker-crash paths never install a direct Windows process fallback.

## Test-only signing fixture

`test-pe-authenticode-content.ps1` signs the recorded PE and an adversarially changed PE with the same short-lived fixture certificate. It proves that signing/checksum/certificate-table changes preserve the canonical hash, while a different same-signer PE and mutations outside the certificate table do not. It needs no trusted-root insertion, removes the test certificate immediately, and runs before the separately bounded hosted-root fixture.

`prepare-test-signed-manifest.ps1` creates a short-lived, non-exportable, self-signed code-signing certificate only on an ephemeral Windows CI runner, marks its fixture `testOnly: true` and `productionEligible: false`, and removes the certificate and copied helper in an `if: always()` cleanup step. It exists solely to exercise valid/mismatched signature, hash, publisher, tamper lease, and broker-death behavior. Current hosted Windows policy can deny inserting that public fixture certificate into `CurrentUser\Root`; that remains a visible bounded test-policy blocker, not a reason to weaken production signature verification. Neither script is a developer or production signing path.

## Installer and service boundary (not implemented)

The existing Windows service script discovers globally installed Node/NSSM paths and does not yet define an immutable helper payload, protected artifact/config ACLs, or signed-manifest ingestion. Those concerns overlap the service/installer and CLI packaging surfaces and are intentionally excluded from this review slice. No service installation, scheduled task, node enrollment, or live configuration was performed.
