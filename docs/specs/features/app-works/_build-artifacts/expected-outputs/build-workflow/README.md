# `ever-works-build.yml` — the build workflow written into a tenant repository

> **Status:** expected output (missing build artifact). Nothing here is committed to a tenant repository by
> this file; it is the **golden output** the acceptance suite asserts against and the implementation target
> for APW-05 T8/T41/T42.
>
> **Companion:** [`ever-works-build.yml`](./ever-works-build.yml) is the concrete generated file for the
> reference App spec `APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml`.
>
> **No secret value appears in either file.** Every build value travels as an Actions secret named
> `EW_<ENV NAME>` and is referenced only as `${{ secrets.EW_* }}`.

---

## 1. What this file is, and who writes it

The App Work's build definition lives in the user's App spec (`spec.build`, `spec.checks`) — never in the
platform. The build plugin turns it into **exactly one file inside the tenant's own repository**:

| Fact                                                                                                                                        | Source                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| The path is `.github/workflows/ever-works-build.yml`, and it is the **only** file the provider writes                                       | `APW-05-builds/spec.md:216` (FR-5); `APW-05-builds/plan.md:402` (`APP_BUILD_WORKFLOW_PATH`) |
| It is the only workflow APW-02's Actions hygiene keeps enabled                                                                              | `CONTRACTS.md:443`; `APW-02-fork-lifecycle/plan.md:92`, `:784-786`                          |
| The template is a string builder (no YAML library) emitting LF endings and a trailing newline, so the same inputs give byte-identical bytes | `APW-05-builds/plan.md:628`, `:664-667`; `APW-05-builds/spec.md:218` (FR-6)                 |
| The first 3 lines are the generated-file comment, the "hand edits are proposed over" line and the input fingerprint                         | `APW-05-builds/spec.md:219-220` (FR-6)                                                      |
| Delivery: a direct commit on a repository this App Work created with an unprotected branch; otherwise one pull request                      | `APW-05-builds/spec.md:221-224` (FR-7); `APW-05-builds/plan.md:676-699` (§4.6)              |

### Which epic's task writes it

| Interpolation / block                                                                                                                                                                                              | Owning task                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| The whole generator, header, triggers, `permissions: {}`, concurrency, guard, services, check-values, checkout, disk reclaim, buildx, login, build, secret check, push + digest, verify step, result write, upload | **APW-05 T8** — `packages/plugins/github-actions-build/src/workflow/generator.ts` (`APW-05-builds/tasks.md:132-153`)     |
| The **`checks` matrix job** (Resolution R-9)                                                                                                                                                                       | **APW-05 T41** — `src/workflow/checks-job.ts` (`APW-05-builds/tasks.md:549-565`)                                         |
| The **checks-only** workflow for `build.strategy: image \| none`                                                                                                                                                   | **APW-05 T42** — `APW-05-builds/tasks.md:567-581`                                                                        |
| `ACTION_PINS` (40-hex commit hashes, release tag in a trailing comment)                                                                                                                                            | **APW-05 T8** — `src/workflow/action-pins.ts`; a unit test fails when a pin is not `^[0-9a-f]{40}$` (`tasks.md:150-151`) |
| The embedded verification script (§4.10)                                                                                                                                                                           | **APW-05 T15** — `src/workflow/verify-runner.sh.ts` (`tasks.md:240-255`)                                                 |
| The secret-in-image script (§4.11)                                                                                                                                                                                 | **APW-05 T15** — `src/workflow/secret-check.sh.ts`                                                                       |
| Writing it into the repository (commit vs pull request, read-back, hand-edit detection)                                                                                                                            | **APW-05 T9** — `src/repo/workflow-writer.ts` (`tasks.md:155-169`)                                                       |
| The `EW_` secrets it references                                                                                                                                                                                    | **APW-05 T10** — `src/repo/secret-sync.ts` (`tasks.md:171-183`)                                                          |
| `runs-on` selection                                                                                                                                                                                                | **APW-05 T11** — `src/runner/runner-selector.ts` (`tasks.md:185-193`)                                                    |

---

## 2. Every interpolation point

`‹…›` in this table is a generator input. The value it takes for the reference spec is in the
"app-fixture-hello" column; the cal-diy value is in §5.

| #   | Line in the generated file                                      | Interpolation                                                                                                                                                                 | Driven by                                                                             | Requirement                                                                                                                                     |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | line 3                                                          | `# ever-works-build generator=‹1› inputs=sha256:‹64 hex›`                                                                                                                     | `APP_BUILD_GENERATOR_VERSION` (`APW-05-builds/plan.md:406`) + `inputsHash`            | `CONTRACTS.md:443` (header shape), `APW-05-builds/plan.md:664`                                                                                  |
| 2   | `on.push.branches` and `on.pull_request.branches`               | `‹tracked branch›`                                                                                                                                                            | `spec.source.branch`                                                                  | FR-11 (`spec.md:230-232`); `APW-03 schema.md:117`                                                                                               |
| 3   | `on.pull_request.types`                                         | fixed `[opened, synchronize, reopened]`                                                                                                                                       | —                                                                                     | FR-11                                                                                                                                           |
| 4   | `on.workflow_dispatch.inputs`                                   | `ew_build_id`, `ew_sha` (string, required), `ew_mode` (`build`\|`verify`), `ew_verify_plan` (base64url JSON, ≤ 60,000 chars)                                                  | `startBuild()` (`plan.md:202-204`); `APP_BUILD_VERIFY_PLAN_MAX_CHARS` (`plan.md:428`) | R-10 (`CONTRACTS.md:53`), FR-41                                                                                                                 |
| 5   | `run-name`                                                      | expression only — carries the Build id so the observer can adopt a correlated run by `display_title`                                                                          | `plan.md:151`, `:136-138`                                                             | `plan.md:136`                                                                                                                                   |
| 6   | `permissions: {}` (top level)                                   | fixed empty                                                                                                                                                                   | —                                                                                     | FR-12; `plan.md:253` ("keeps FR-12 checkable by grep")                                                                                          |
| 7   | `concurrency.group`                                             | `ever-works-build-` + `pr-‹n›` on a pull request, else `‹github.ref_name›`                                                                                                    | —                                                                                     | FR-14 (`spec.md:236-237`)                                                                                                                       |
| 8   | `concurrency.cancel-in-progress`                                | `true` **only** for `pull_request`                                                                                                                                            | —                                                                                     | FR-14; ACC-05-10                                                                                                                                |
| 9   | `jobs.build.if`                                                 | same-repository guard (expression)                                                                                                                                            | —                                                                                     | FR-11 ("pull requests from other repositories never run a job that can read secrets or push images"); ACC-05-06                                 |
| 10  | `jobs.build.runs-on`                                            | `‹runner label›`                                                                                                                                                              | `APP_BUILD_RUNNERS` + plugin settings `largerRunnerLabel`                             | FR-22 (`spec.md:260-262`); `plan.md:422-425`, `:645-658`; ACC-05-22                                                                             |
| 11  | `jobs.build.timeout-minutes`                                    | `‹build.resources.timeoutMinutes›` **+ 30 when a verification plan can run**                                                                                                  | `spec.build.resources.timeoutMinutes`                                                 | FR-24; `plan.md:168`                                                                                                                            |
| 12  | `jobs.build.permissions`                                        | `{ contents: read, packages: write }`; `+ attestations: write, id-token: write` when attestations are on                                                                      | plugin setting `attestations` (public repositories only)                              | FR-12, FR-30; `plan.md:169`                                                                                                                     |
| 13  | `jobs.build.services`                                           | one entry per `spec.build.services[]`, with health options by known image (`postgres*` → `pg_isready`, `redis*` → `redis-cli ping`, `minio*` → `/minio/health/live`)          | `spec.build.services`                                                                 | FR-20; `plan.md:170-171`, `:668-671`; ACC-05-12                                                                                                 |
| 14  | `env.EW_IMAGE`                                                  | `ghcr.io/‹owner lower›/‹repo lower›/ever-works-app`                                                                                                                           | the Work Repository                                                                   | FR-27 (`spec.md:273`); `APP_BUILD_IMAGE_NAME` (`plan.md:405`)                                                                                   |
| 15  | `env.EW_SHA`                                                    | `${{ inputs.ew_sha \|\| github.event.pull_request.head.sha \|\| github.sha }}`                                                                                                | —                                                                                     | FR-28 (the commit tag addresses the commit, `plan.md:38`)                                                                                       |
| 16  | `env.EW_SECRET_NAMES`                                           | space-separated `EW_` names whose `env` entry is `secret: true` **and not** build-service derived                                                                             | APW-07 values for phase `build`                                                       | `plan.md:175`, `:803-804`                                                                                                                       |
| 17  | step `Check build values`                                       | the `env:` keys are the `EW_` names of every `spec.build.args[].fromEnv`; the `for name in …` list is the same set; prints names only and exits `78` with `EW_MISSING:<NAME>` | `spec.build.args[].fromEnv`                                                           | FR-19 ("the workflow's first step re-checks presence and fails in under 1 minute"); `plan.md:177-179`; ACC-05-14                                |
| 18  | `actions/checkout` `with.ref`                                   | `${{ env.EW_SHA }}`, `fetch-depth: 1`, `persist-credentials: false`, `lfs: false`                                                                                             | —                                                                                     | FR-25 ("checkout fetches a single commit")                                                                                                      |
| 19  | step `Reclaim runner disk`                                      | emitted while plugin setting `reclaimDisk` is `true` (default)                                                                                                                | `reclaimDisk`                                                                         | FR-25; `plan.md:182-183`, `:652`                                                                                                                |
| 20  | `actions/setup-buildx-action` `with.buildkitd-flags`            | `--allow-insecure-entitlement network.host` **only when `spec.build.services` is non-empty**                                                                                  | `spec.build.services`                                                                 | FR-20                                                                                                                                           |
| 21  | `actions/login-action`                                          | fixed `registry: ghcr.io`, `username: github.actor`, `password: secrets.GITHUB_TOKEN`                                                                                         | —                                                                                     | FR-26                                                                                                                                           |
| 22  | build step `with.context` / `with.file`                         | `‹build.context›` / `‹build.context›/‹build.dockerfile›`                                                                                                                      | `spec.build.context`, `spec.build.dockerfile`                                         | `APW-03 schema.md:162-163`                                                                                                                      |
| 23  | build step `with.target`                                        | `‹build.target›` when set                                                                                                                                                     | `spec.build.target`                                                                   | `APW-03 schema.md:164`                                                                                                                          |
| 24  | build step `with.build-args`                                    | one line per `spec.build.args[]`: `‹NAME›=‹literal value›` for `value`, `‹NAME›=${{ secrets.EW_‹NAME› }}` for `fromEnv`                                                       | `spec.build.args`                                                                     | FR-10 ("the workflow contains no App env value: only literal build arguments already written in the App spec, and references to `EW_` secrets") |
| 25  | build step `with.tags`                                          | `${{ env.EW_IMAGE }}:sha-${{ env.EW_SHA }}` always; `branch-‹branch slug›` for tracked-branch builds; `pr-‹n›` for pull requests. `latest` is never emitted                   | `trackedBranch`                                                                       | FR-28 (`spec.md:274-275`); branch slug rule `plan.md:668`; ACC-05-07                                                                            |
| 26  | build step `with.labels`                                        | `org.opencontainers.image.source`, `org.opencontainers.image.revision`, `io.ever-works.app-spec-hash=‹appSpecHash›`                                                           | `WorkAppSpecState.specHash` (APW-03)                                                  | `plan.md:206-209`                                                                                                                               |
| 27  | build step `with.cache-from` / `with.cache-to`                  | `type=registry,ref=‹EW_IMAGE›:buildcache`; `cache-to` carries `mode=max` and is emitted **only on `push`**                                                                    | —                                                                                     | FR-26 ("pull request builds only read the cache"); ACC-05-10; this repo's own convention `.github/workflows/k8s-build.yml:177-178`              |
| 28  | `with.load: true`, `with.push: false`, `with.provenance: false` | fixed                                                                                                                                                                         | —                                                                                     | FR-21 ("before anything is pushed, the finished image's metadata is checked")                                                                   |
| 29  | step `Check the image for secret build values`                  | emitted **only when `EW_SECRET_NAMES` is non-empty**; body is `APW-05-builds/plan.md:790-800` verbatim                                                                        | `EW_SECRET_NAMES`                                                                     | FR-21; ACC-05-15. **Not emitted for this reference spec** — see §4                                                                              |
| 30  | step `Push`                                                     | `docker push --all-tags "$EW_IMAGE"` then `docker image inspect --format '{{index .RepoDigests 0}}'` into `ew-digest.txt`                                                     | —                                                                                     | FR-29; `plan.md:216-218`                                                                                                                        |
| 31  | step `Verify in the runner`                                     | emitted **only when a verification plan may run**; `timeout-minutes: 30`; body implements `plan.md:756-786`                                                                   | `startBuild({ mode: 'verify', verification })`                                        | R-10 (`CONTRACTS.md:53`, `:293`); ACC-05-23                                                                                                     |
| 32  | step `Write result` + `upload-artifact`                         | artifact `ever-works-build-result`, ≤ 8 KiB, `retention-days: 7`, `if-no-files-found: ignore`                                                                                 | `APP_BUILD_RESULT_MAX_BYTES` (`plan.md:417`)                                          | `plan.md:223-228`; the observer validates it against a strict schema (`plan.md:726`)                                                            |
| 33  | `jobs.checks.name`                                              | `"Ever Works check: ${{ matrix.check.name }}"` — the **exact** check-run name                                                                                                 | `spec.checks[].name`                                                                  | R-9 (`CONTRACTS.md:52`, `:300`); `APP_BUILD_CHECK_NAME_PREFIX` (`plan.md:437`); FR-65; ACC-05-29                                                |
| 34  | `jobs.checks.if`                                                | pull request **and** same repository                                                                                                                                          | —                                                                                     | R-9; ACC-05-29                                                                                                                                  |
| 35  | `jobs.checks.runs-on`                                           | the build job's label (a check does not inherit the build's memory check)                                                                                                     | `plan.md:846`                                                                         | `plan.md:846`                                                                                                                                   |
| 36  | `jobs.checks.timeout-minutes`                                   | `${{ matrix.check.timeoutMinutes }}` = `ceil(spec.checks[].timeoutSeconds / 60)`                                                                                              | `spec.checks[].timeoutSeconds`                                                        | `plan.md:842`                                                                                                                                   |
| 37  | `jobs.checks.continue-on-error`                                 | `${{ !matrix.check.required }}`                                                                                                                                               | `spec.checks[].required` (default `true`)                                             | R-9; FR-68                                                                                                                                      |
| 38  | `jobs.checks.permissions`                                       | exactly `{ contents: read }` — nothing else                                                                                                                                   | —                                                                                     | R-9 ("read-only token"); FR-66; ACC-05-29                                                                                                       |
| 39  | `jobs.checks.strategy`                                          | `fail-fast: false`, `max-parallel: 5`                                                                                                                                         | `APP_BUILD_CHECKS_MAX_PARALLEL` (`plan.md:439`)                                       | R-9                                                                                                                                             |
| 40  | `jobs.checks.strategy.matrix.check[]`                           | one row per `spec.checks[]` **in declared order**: `{ name, required, timeoutMinutes, commandB64 }`                                                                           | `spec.checks` (≤ 20)                                                                  | R-9; `plan.md:840-842`; `APP_BUILD_CHECKS_MAX` (`plan.md:438`)                                                                                  |
| 41  | `commandB64`                                                    | `base64(‹spec.checks[].command›)` — commands travel base64-encoded so neither YAML nor the `${{ }}` engine ever interprets a byte of repository-authored text                 | `spec.checks[].command`                                                               | FR-67; `plan.md:248`, `:256-257`; ACC-05-29                                                                                                     |
| 42  | `jobs.checks` steps                                             | checkout of `github.event.pull_request.head.sha` (`fetch-depth: 1`, `persist-credentials: false`), then one `bash -e` run of the decoded command                              | —                                                                                     | `plan.md:243-248`                                                                                                                               |
| 43  | absence of `needs:` on `jobs.checks`                            | deliberate — a failed image build must never skip a check                                                                                                                     | —                                                                                     | FR-69; `plan.md:254-255`                                                                                                                        |
| 44  | absence of `secrets.` / `EW_` / `cache-` in `jobs.checks`       | deliberate — grep-asserted                                                                                                                                                    | —                                                                                     | FR-66; `plan.md:257-258`; ACC-05-29                                                                                                             |

### The fingerprint is a real hash of real inputs

`inputsHash = sha256(canonical JSON)` over the canonical inputs of `APW-05-builds/plan.md:662-665`
(`generator`, `trackedBranch`, normalised `build`, value **names** with `secret`/`fromBuildService` flags,
`runner`, `settings`, `pins`, `verifyEnabled`, `checks`). For the reference spec the exact bytes hashed are:

```json
{
	"build": {
		"args": [{ "fromEnv": "FIXTURE_BUILD_LABEL", "name": "FIXTURE_BUILD_LABEL" }],
		"context": ".",
		"dockerfile": "Dockerfile",
		"resources": { "cpu": 2, "memoryGiB": 4, "timeoutMinutes": 10 },
		"services": [],
		"strategy": "dockerfile",
		"target": "runtime"
	},
	"checks": [
		{
			"commandSha256": "fc21ee81dccb909d28900d21c93c09adb78a55f3948be4d9a56850094e6e9b82",
			"name": "unit",
			"required": true,
			"timeoutMinutes": 5
		},
		{
			"commandSha256": "23b5fa2bcc111ec78fcc57d99ec834d8e81e6813a9eeccda0975c9b82067e708",
			"name": "format",
			"required": false,
			"timeoutMinutes": 3
		}
	],
	"generator": 1,
	"pins": {
		"buildPush": "4444444444444444444444444444444444444444",
		"checkout": "1111111111111111111111111111111111111111",
		"login": "3333333333333333333333333333333333333333",
		"setupBuildx": "2222222222222222222222222222222222222222",
		"uploadArtifact": "5555555555555555555555555555555555555555"
	},
	"runner": { "class": "github-public", "label": "ubuntu-latest" },
	"settings": { "attestations": false, "reclaimDisk": true },
	"trackedBranch": "main",
	"values": [{ "fromBuildService": false, "name": "FIXTURE_BUILD_LABEL", "secret": false }],
	"verifyEnabled": true
}
```

`sha256` of those bytes (UTF-8, no trailing newline) is

```
186731bcc4f907151752084e738541550a80203078b1d74972ae42a1521c9b06
```

which is the value on line 3 of the generated file. **Assumption:** the byte form above is this artifact's
definition of "canonical JSON" (keys sorted, compact separators, values normalised per
`AppBuildBlock`/`BuildValue` in `plan.md:485-506`); the generator must adopt exactly this form or this
fingerprint will differ. See `../open-questions.md` **Q-1**.

The two `commandSha256` values are `sha256` of the raw command strings:

| Check    | `spec.checks[].command`          | `timeoutSeconds` | `timeoutMinutes` | `commandB64`                               | `commandSha256`                                                    |
| -------- | -------------------------------- | ---------------- | ---------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `unit`   | `npm ci && npm test`             | 300              | 5                | `bnBtIGNpICYmIG5wbSB0ZXN0`                 | `fc21ee81dccb909d28900d21c93c09adb78a55f3948be4d9a56850094e6e9b82` |
| `format` | `npm ci && npm run format:check` | 180              | 3                | `bnBtIGNpICYmIG5wbSBydW4gZm9ybWF0OmNoZWNr` | `23b5fa2bcc111ec78fcc57d99ec834d8e81e6813a9eeccda0975c9b82067e708` |

---

## 3. What the reference file pins

The reference instance is generated from
`APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml`:

| Input                 | Value used                                                                                                      | Where it comes from                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| tracked branch        | `main`                                                                                                          | `works.yml:19`                                                                                    |
| repository visibility | public                                                                                                          | the fixture is the public `ever-works/app-fixture-hello` (`APW-13-golden-paths/tasks.md:241-250`) |
| runner                | `github-public` → `ubuntu-latest` (4 vCPU / 16 GiB)                                                             | `plan.md:422-425`; 4 GiB ≤ 16 − 2, so no `runnerTooSmall`                                         |
| build values          | one `fromEnv` arg, `FIXTURE_BUILD_LABEL` (`phase: build`, literal value `fixture-blueprint-0.1.0`) — non-secret | `works.yml:42`, `:91`                                                                             |
| `EW_SECRET_NAMES`     | empty → the secret-in-image step is **not** emitted                                                             | `plan.md:212-215`                                                                                 |
| build services        | none → no `services:`, no buildx network flags                                                                  | `works.yml:36-43`                                                                                 |
| checks                | `unit` (required) + `format` (advisory) → a 2-row matrix                                                        | `works.yml:124-126`                                                                               |
| `timeout-minutes`     | `10` + `30` (verification may run) = `40`                                                                       | `works.yml:43`; `plan.md:168`                                                                     |
| `build.target`        | `runtime`                                                                                                       | `works.yml:40`                                                                                    |
| build args            | `FIXTURE_BUILD_LABEL=${{ secrets.EW_FIXTURE_BUILD_LABEL }}`                                                     | `works.yml:42`                                                                                    |
| attestations          | `false` (default) → no attestation permissions                                                                  | `plan.md:653`                                                                                     |

### Placeholders

Per the artifact rules these are **placeholders**, not real values, and the acceptance suite must not treat
them as data:

| Placeholder                                                                                                  | Appears as                                               | Why it is a placeholder                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `example-owner`                                                                                              | `ghcr.io/example-owner/app-fixture-hello/ever-works-app` | the real owner is the user who forked the fixture; a real GitHub login must not be baked into a golden file                                                                       |
| `1111…`…`5555…` (40× one digit)                                                                              | `uses: …@‹40 hex›`                                       | `ACTION_PINS` are "resolved at implementation time" (`APW-05-builds/tasks.md:134-135`, `:150-151`); the shape (`^[0-9a-f]{40}$`) is what the golden asserts                       |
| `sha256:0000…0001/2/3`                                                                                       | the throwaway dependency images inside the verify script | `plan.md:779-780` ("images pinned by digest in the script"); the real digests are chosen when `verify-runner.sh.ts` is written (T15)                                              |
| `d5cff638…0be7`                                                                                              | `io.ever-works.app-spec-hash`                            | `sha256` of the Blueprint file as committed at APW-13's path — a stand-in for the effective spec's `specHash` (`WorkAppSpecState`, APW-03), which is computed at the build commit |
| `${{ secrets.EW_FIXTURE_BUILD_LABEL }}`, `${{ secrets.GITHUB_TOKEN }}`, `${{ secrets.EW_VERIFY__PROMPTED }}` | secret references                                        | values never appear in a workflow file; `EW_VERIFY__PROMPTED` is the reserved per-run verification secret (`plan.md:440`, `:770-775`)                                             |

No hostname, cluster address, token or secret value appears anywhere in the generated file.

---

## 4. Conditional blocks this reference spec does **not** trigger

Each is emitted verbatim only when its condition holds. A golden set that covers only the reference spec
would leave these unasserted, so the byte shapes are recorded here.

**`build.services` non-empty** (emitted before `env:`; `plan.md:170-171`, `:184-186`, `:198-199`) — for the
cal-diy Blueprint's `{ name: postgres, image: 'postgres:16' }`:

```yaml
services:
    postgres:
        image: 'postgres:16'
        env:
            POSTGRES_PASSWORD: 'ever-works-build'
            POSTGRES_USER: 'ever-works-build'
            POSTGRES_DB: 'app'
        ports:
            - '5432:5432'
        options: >-
            --health-cmd "pg_isready -U ever-works-build" --health-interval 5s
            --health-timeout 5s --health-retries 20
```

plus, on the two docker steps:

```yaml
- uses: docker/setup-buildx-action@2222222222222222222222222222222222222222 # v4.3.0
  with:
      buildkitd-flags: '--allow-insecure-entitlement network.host'
      # …and on docker/build-push-action:
      network: host
      allow: network.host
```

The build-value that references the service resolves to the runner-local address `127.0.0.1`
(`plan.md:703-705`; ACC-05-12: "the fixture build migrates an ephemeral Postgres; the real database is never
contacted").

**`EW_SECRET_NAMES` non-empty** (`plan.md:212-215`, `:790-800`) — emitted between the build and push steps:

```yaml
- name: Check the image for secret build values
  if: inputs.ew_mode != 'verify'
  env:
      EW_NEXTAUTH_SECRET: ${{ secrets.EW_NEXTAUTH_SECRET }}
  run: |
      set -euo pipefail
      docker image inspect "$EW_IMAGE:sha-$EW_SHA" > "$RUNNER_TEMP/ew-image.json"
      docker history --no-trunc --format '{{.CreatedBy}}' "$EW_IMAGE:sha-$EW_SHA" >> "$RUNNER_TEMP/ew-image.json"
      for name in $EW_SECRET_NAMES; do
        value="${!name:-}"
        [ "${#value}" -ge 8 ] || continue
        if grep -qF -- "$value" "$RUNNER_TEMP/ew-image.json"; then echo "EW_SECRET_IN_IMAGE:${name#EW_}"; exit 79; fi
      done
      echo "secret-check: passed"
```

**Attestations on** (public repositories only, `plan.md:169`) — the build job's permissions gain
`attestations: write` and `id-token: write`.

**A private repository** — `runs-on` becomes the plugin setting `largerRunnerLabel` when set, else the
private runner; `APP_BUILD_RUNNERS.githubPrivate` is `{ label: 'ubuntu-latest', vcpu: 2, memoryGiB: 7 }`
(`plan.md:422-425`). `build.resources.memory` above the runner's memory − 2 GiB blocks the Build before
anything is written (FR-23; ACC-05-22).

**`build.strategy: image` or `none` with checks** — a **checks-only** file (`APW-05-builds/plan.md:848-850`;
T42): the same header, `on: pull_request` only (no `push`, no `workflow_dispatch`), `permissions: {}`, the
same concurrency block, the `checks` job and **nothing else**. With no checks left, nothing is written and a
checks-only file the platform wrote is proposed for removal by pull request, never deleted directly
(`plan.md:694-696`; FR-70; ACC-05-30).

**A branch other than the tracked branch in `pull_request`/`push`** — the branch slug in the moving tag is
lower-cased, `[^a-z0-9._-]` → `-`, repeats collapsed, trimmed to 100 characters (`plan.md:668`).

---

## 5. cal-diy — how the same generator instance differs

For `APW-13-golden-paths/blueprints/cal-diy/.works/works.yml` the generator's inputs change as follows. The
plan template is identical; only these lines differ.

| Line                          | app-fixture-hello                                        | cal-diy                                                                                                                                                                                                                         | Source                                                                                                   |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `env.EW_IMAGE`                | `ghcr.io/example-owner/app-fixture-hello/ever-works-app` | `ghcr.io/example-owner/cal.diy/ever-works-app`                                                                                                                                                                                  | the Work Repository; FR-27 lower-cases                                                                   |
| `timeout-minutes`             | `40`                                                     | `90` (`60` + `30`)                                                                                                                                                                                                              | `works.yml:71`                                                                                           |
| `build.target`                | `runtime`                                                | `runner`                                                                                                                                                                                                                        | `works.yml:55`                                                                                           |
| `build-args`                  | one `fromEnv` line                                       | three literal lines (`MAX_OLD_SPACE_SIZE=6144`, `CALCOM_TELEMETRY_DISABLED=1`, `DATABASE_URL=postgresql://postgres@localhost:5432/calendso`) and **no** `EW_` reference; therefore the `Check build values` step is not emitted | `works.yml:56-65`; `plan.md:177` (step is emitted "if any fromEnv args")                                 |
| `services`                    | none                                                     | `postgres` (block in §4) + buildx network flags + `network: host` / `allow: network.host` on the build step                                                                                                                     | `works.yml:66-70`                                                                                        |
| `EW_SECRET_NAMES`             | `""`                                                     | `""` — the Blueprint deliberately passes no secret as a build argument (`works.yml:63-65`), so the secret-in-image step is still not emitted                                                                                    | `plan.md:175`                                                                                            |
| checks matrix                 | 2 rows (`unit` 5 min required, `format` 3 min advisory)  | 3 rows (`type-check` 60 min required, `biome` 30 min advisory, `unit-tests` 60 min advisory)                                                                                                                                    | `works.yml:262-275`                                                                                      |
| `io.ever-works.app-spec-hash` | `d5cff638…0be7`                                          | `6977cfdf…ecea`                                                                                                                                                                                                                 | `sha256` of each Blueprint file as committed at `APW-13-golden-paths/blueprints/<name>/.works/works.yml` |

cal-diy's three check `commandSha256` values:

| Check        | `command`                                                | `timeoutSeconds` | `timeoutMinutes` | `commandSha256`                                                    |
| ------------ | -------------------------------------------------------- | ---------------- | ---------------- | ------------------------------------------------------------------ |
| `type-check` | `yarn install --immutable && yarn type-check:ci --force` | 3600             | 60               | `c508b79d967c1c2b9ef366d12fc72432c968b072e763d6fb708400976ea0128c` |
| `biome`      | `yarn install --immutable && yarn biome check .`         | 1800             | 30               | `f1f121b088ff5ae378a6daa69858f49f256b39329346c1e546e9239ca862e232` |
| `unit-tests` | `yarn install --immutable && TZ=UTC yarn test`           | 3600             | 60               | `beb92b9d5be8a7e6bfe6ecb060b36b0b32ea47509491da68bb66999f870830f2` |

---

## 6. Conventions deliberately copied from this repository's own image lane

The generated file must not contradict `.github/workflows/k8s-build.yml`, which is the platform's own
worked example of this lane:

| Convention                                                                                 | Where it comes from                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Registry cache beside the image with `mode=max`                                            | `k8s-build.yml:177-178`, `:205-206`                                                       |
| `permissions: contents: read` + `packages: write` at job level                             | `k8s-build.yml:26-28`                                                                     |
| An immutable `sha-<gitsha>` tag is the only tag built; a moving tag is promoted separately | `k8s-build.yml:174-176`, `:212-242`                                                       |
| `cancel-in-progress` is a **measured** decision, never a default                           | `k8s-build.yml:8-25` (four consecutive production builds were killed by the next cascade) |

The generated workflow's `cancel-in-progress` differs by design and not by accident: FR-14 requires a newer
commit on a **pull request** to cancel that pull request's running build, and requires a tracked-branch build
to **never** be cancelled (at most one waits, newest waiting wins). The expression
`${{ github.event_name == 'pull_request' }}` implements exactly that split — the same distinction
`k8s-build.yml:8-25` documents, scoped to the ref that may safely be cancelled.

`ACTIVE_WORKFLOW_FILES` (`packages/plugins/github/src/types.ts:47-51` — `.github/workflows/deploy_vercel.yaml`,
`deploy_prod.yaml`, `deploy_k8s.yaml`) is **not** touched by this epic and does **not** contain
`ever-works-build.yml`; APW-02 owns the hygiene allowlist that keeps the Ever Works build workflow enabled
(`CONTRACTS.md:443`; `APW-02-fork-lifecycle/plan.md:92`). Nothing in this file changes that list.
