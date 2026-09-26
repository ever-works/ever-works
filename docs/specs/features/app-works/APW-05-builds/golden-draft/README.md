# Golden drafts — the generated `ever-works-build.yml`

> **Added 2026-09-17 (`EXT-22`).** These files pin, byte for byte, what
> [`plan.md` §2.4](../plan.md) describes in prose. They are **normative for the test folder** they are copied into:
> `packages/plugins/github-actions-build/src/__tests__/golden/` (T8, T41, T42, T46). Until they are copied, this folder
> is the only byte-level statement of the generated workflow, which is what APW-02, APW-05, APW-06 and APW-08 all read.

Fixtures, one per case the generator must decide differently:

| File                                                                                         | Case                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`minimal.ever-works-build.yml`](./minimal.ever-works-build.yml)                             | `dockerfile`, no args, no services, no checks, public repository, pushed to `main`.                                      |
| [`args.ever-works-build.yml`](./args.ever-works-build.yml)                                   | One literal build argument and one `fromEnv` argument, in restricted mode (`XC-01`).                                     |
| [`services-postgres.ever-works-build.yml`](./services-postgres.ever-works-build.yml)         | A `postgres:16` build service with `BUILD_SERVICE_DEFAULTS` and a build argument resolving to `127.0.0.1` (`APW05-G08`). |
| [`private-larger-runner.ever-works-build.yml`](./private-larger-runner.ever-works-build.yml) | A private repository with a larger runner label and attestations off.                                                    |
| [`verification.ever-works-build.yml`](./verification.ever-works-build.yml)                   | The `verify` job, `ew_reuse_digest`, and no `build` job at all (`APW05-G02`).                                            |
| [`checks.ever-works-build.yml`](./checks.ever-works-build.yml)                               | Strategy `image` with two checks, one advisory: the checks-only file (R-9, `APW05-G04`).                                 |

Conventions these drafts fix, and which no implementation may drift from:

- **Pins.** Every `uses:` carries `‹pin:<name>›`, a placeholder for the 40-character commit hash that `ACTION_PINS`
  resolves at implementation time. A pin is never a tag. The header's `inputs=sha256:<64 hex>` is likewise the
  fingerprint of the canonical inputs of [`plan.md` §4.5](../plan.md), not of the rendered file.
- **The header is three lines exactly**, and the third is the fingerprint line (FR-6).
- **`permissions: {}` at the top** and job-level grants only, so FR-12 is checkable by grep.
- **LF line endings, one trailing newline, two-space indentation** — the same bytes on every platform.

The renderer goldens for APW-06's Your-cluster output are drafted in that epic's own `golden-draft/` folder; this folder
covers only the build workflow.
