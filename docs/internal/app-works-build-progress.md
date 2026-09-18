# App Works — build progress (single source of truth)

**Branch:** `feat/app-works-implementation` on `ever-works/ever-works` (created 2026-09-17, based on
`plan/any-repo-as-work` @ `a183ecd70`, **not** merged to anything).
**Owner instruction:** work end to end, all waves, tests + docs + specs, commit continuously to this branch, do
**not** merge — review comes later.
**Additive-only rule (NN #27 / R-26):** every change is an improvement or an addition. Nothing is deleted,
removed, weakened or narrowed. If a spec reads as requiring a removal, the spec is wrong — rewrite as an addition.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done and verified · `[!]` blocked (reason recorded).

---

## 0. Where the work comes from

| Source                      | What it gives                                                                                                                 | Location                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Programme spec              | 13 epics `APW-01`…`APW-13` + README, CONTRACTS (R-1…R-27), ACCEPTANCE (445 ids), TRACKER, EXISTING-SUBSTRATE, BUILD-READINESS | `docs/specs/features/app-works/`                                                                                                                                                   |
| Implementation plan         | Wave 0…3 order, the eight decisions, operator notes                                                                           | `docs/internal/app-works-implementation-plan.md`                                                                                                                                   |
| **Gap register**            | **455 rows** — 24 blockers, 158 high, 200 medium, 73 low; **119 adversarially confirmed**, 2 refuted, 334 unverified          | copy in the branch root: `.app-works-gaps.json`; blockers also as `.app-works-blockers.json` (source: `ever-works/workspace` `knowledge/notes/2026-09-17-app-works/completeness/`) |
| Build artifacts             | schema + validator + 42 fixtures, catalog design, fixture app, golden manifests, decision artifacts                           | `docs/specs/features/app-works/_build-artifacts/`                                                                                                                                  |
| The spec tree's own checker | links + acceptance ids                                                                                                        | `node docs/specs/features/app-works/tools/verify-spec-tree.mjs`                                                                                                                    |

**Baseline at branch creation:** spec tree **CLEAN** — 84 files, 935 relative links, 0 broken; **445 acceptance ids
defined, 445 indexed, 0 orphaned**, exit 0.

**Current state (2026-09-17, end of round 1):** spec tree **CLEAN** again — **124 files, 1829 relative links, 0
broken; 548 acceptance ids defined, 548 indexed, 0 orphaned**, exit 0. The checker now always writes its complete
finding list to `tools/verify-spec-tree.report.txt`, because the console only prints the first 40 and that hid 60
findings once.

| Deliverable                | State                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gap register               | 24 blockers: **20 fixed, 4 confirmed already discharged**. All high rows in APW-01/02/03/04/05/06/07/10/13 addressed. ~50 medium/low rows in APW-01/02/03 remain untouched and are listed per epic.                                                                                                                      |
| Spec tree                  | `CLEAN`, 549/549 ids, 0 broken links (1833 links, 124 files)                                                                                                                                                                                                                                                             |
| Wave 0                     | **both PRs implemented, tested and pushed**                                                                                                                                                                                                                                                                              |
| **Shared contracts**       | **landed** — `packages/contracts/src/apps/`, 10 modules + 3 specs, 749 exported names (517 runtime), **0 collisions**, wired into the package root                                                                                                                                                                       |
| Ever ID                    | DNS live; manifests in `k8s-gitops` PR #56; deployment blocked by the backups-first gate                                                                                                                                                                                                                                 |
| Test estate                | created (two Organizations), isolation proven                                                                                                                                                                                                                                                                            |
| Implementation (Waves 1–3) | **Wave 1 in progress — 5 foundation tasks landed, 4 running.** Landed: the contracts surface, `app-runtime.ts` (T1), the k8s renderer base (T4/T5). Running: the plugin App contract (T2), the agent ports (T3), the k8s manifest renderer (T6/T7), the launcher types (APW-11 T1). The epics' features are not written. |

### Wave 1 foundation ledger (what "done" means here)

| Task                | Deliverable                                                                                                                   | Test evidence                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| contracts           | `packages/contracts/src/apps/` — **11 modules**, 4 specs                                                                      | contracts **3377 / 81 files**, 0 collisions                                                                            |
| **T1**              | `app-runtime.ts` — 84 exports (12 unions, 38 precondition + 18 failure codes, 52 numbers)                                     | +111 tests, pins proven by 3 perturbations                                                                             |
| **T4/T5**           | `app-names.ts` + `app-security.ts` — every name/label of plan §4.1, the whole §4.4 table                                      | k8s plugin **242 / 12 files** (was 184/10), one test per §4.4 cell                                                     |
| **T2**              | `app-deployment.types.ts` (29 types) + the ten **optional** `IDeploymentPlugin` members + `isAppDeploymentPlugin`             | plugin **458 / 32 files** (was 419/31); **vercel 51/2 IDENTICAL** and still builds — no existing plugin needed an edit |
| **T3**              | `packages/agent/src/app-runtime/{ports,default-ports,index}.ts` — every interface of plan §9.6 + five fail-closed bindings    | agent **16 tests**; the `./app-runtime` subpath resolves after a build                                                 |
| **T6/T7**           | `app-manifest.renderer.ts` (58 exports) + `app-network-policy.renderer.ts` (27)                                               | k8s plugin **358 / 14 files** (was 242/12); 4 perturbations red then reverted; old renderer hash-identical to HEAD     |
| **APW-11 T1**       | `app-launcher.ts` — 36 exports, 11 constants, 2 fail-closed predicates                                                        | contracts **+45 tests**; pins proven by 4 runtime + 3 compile failures                                                 |
| APW-03 T1           | `app-spec.types.ts`, `app-spec-issues.ts`, `app-license.types.ts`, `apps-catalog.types.ts`, `work-app-spec.dto.ts`            | contracts **3454 / 82 files**; barrel **34 areas**, 524 runtime exports                                                |
| T8/T9               | `app-runner.script.ts`, `app-jobs.renderer.ts`, `app-rollout.ts`                                                              | k8s plugin **505 / 17 files**; `status.mapper.ts` + `manifest.renderer.ts` hash-identical to HEAD                      |
| **APW-11 T2–T5**    | launcher persistence: entity + repository + migration (`1792110000000-CreateAppLauncherPreferences`)                          | diff 242 insertions / **1 deletion**; migration reversible                                                             |
| **APW-11 T30**      | R-25: `AppLauncherPreference` → `data/account/app-launcher-preferences.jsonl`, `by: 'user'`; `redaction.ts` untouched         | agent **95 / 5 suites**; 4 perturbations red then reverted, 3 hashes restored; zip read back with `jszip`              |
| **APW06-G26**       | `AppComponentInput.runAsUser?: number` — the contract catches up with APW-03 `schema.md:202`                                  | k8s **505 / 17** after a **rebuilt** plugin dist; `tsc --noEmit` exit 0; renderer needed no code change                |
| **APW-11 T31**      | the five operator switches in the three deploy manifests + `.env.example`; `_ENV` literal per file; switch ships OFF          | manifests **24/24/24** + env **18** insertions, **0 deletions**; guard spec **13 tests**; 3 perturbations red          |
| **AppPrecondition** | declared in `app-runtime.ts` (plan §3.1:375, §5.1:674) after being referenced-but-absent everywhere under `packages/**`       | contracts **3457 / 82**; `type-check:tests` exit 0; 2 perturbations red (`TS2578` + union removal), hash restored      |
| **APW-11 T32**      | `app_launcher` badge: `TYPE_TO_I18N` + colour entry, and `appLauncher` in **all 21 locales** (XC-24)                          | badge spec **4 tests** (real `de.json` bundle + a fallback control); 3 perturbations red; bundles 1+0 across 21 files  |
| **APW-02 T9/T10**   | git-provider fork capabilities: 9 optional `GitRepository` fields + 9 optional `IGitProviderPlugin` members + plan §3.3 types | plugin **492 / 33** (was 458/32); diffs 219/0 · 8/0 · 20/0; required-member probe went red in the dependant too        |

**Two foundation tasks own a guard worth knowing about:**

- **T3 carries the R-5 guard**: a test that walks `packages/agent/src/app-runtime/` at run time and asserts no file in it
  mentions the managed-tier ceiling environment variable — with a vacuity check (it asserts it really read the files) and
  a known-good control, so it cannot pass by scanning nothing. It was proven by appending the forbidden string and
  watching the test fail.
- **T5 carries the §4.4 invariant**: one `it` per cell of the plan's security table, plus a matrix assertion that no
  rendered container lacks `allowPrivilegeEscalation: false` and `capabilities.drop: [ALL]`.

**APW06-G27 — an integration break found by one agent in another's file, and fixed the same round.** T2's agent proved
with a temporary probe that `app-security.ts`'s _local_ two-value `AppSecurityTarget` made `AppRenderInput`
**unassignable** to `AppSecurityInput` (`TS2322`, the literal `none` is not assignable) — `AppDeployTarget` really has
three values (R-12), and T6 renders components through that module. Fixed by aliasing `AppSecurityTarget` to the plugin
contract's `AppDeployTarget` instead of redeclaring it, with a spec guard pinning all three values _and_ the two
previously-supported ones, so the fix **widened** the type rather than changing it.

**⚠️ Environment hazard the agents hit, worth a CI fix:** the plugin packages resolve `IDeploymentPlugin` from
`packages/plugin/dist`, not source — so `k8s`/`vercel` type-checks can pass against a stale contract and prove nothing
about additivity. Proved by making a member required and watching both still exit 0. `@ever-works/plugin` must be built
before dependent suites run, and the documented workflow does not say so.

### The programme's real size (measured, not estimated)

`node docs/specs/features/app-works/tools/wave-plan.mjs` reads the merge order out of `TRACKER.md` and every task
heading out of each epic's `tasks.md`: **693 task headings across 13 epics** — APW-13 73 · APW-06 73 · APW-04 60 ·
APW-03 57 · APW-08 56 · APW-10 53 · APW-12 53 · APW-02 51 · APW-05 48 · APW-07 48 · APW-01 44 · APW-09 44 ·
APW-11 33.

For scale: this branch has completed **Wave 0's 2 tasks** and **Wave 1's APW-06 foundation tasks T1–T9** (the ledger's
five rows: the contracts surface every other task compiles against, the plugin's deployment contract, the agent's
runtime ports, the k8s names/security modules and both renderers, plus the runner script, the job renderer and the
rollout classifier), **APW-03 T1**'s spec contracts, and **APW-11's P1.1 data layer** (T1, T2–T5, T30). Anyone reading
this should treat "all waves end to end" as a multi-month engineering programme with a team, not a single session —
the point of this file is that every step taken is _verified_, not that the whole thing is near done.

### ✅ SPEC FREEZE — the acceptance lanes pin this revision

**The specs are frozen as of `9a379106b`** (2026-09-17). The golden-outputs work proved why this matters: every spec
file changed _while that work was in flight_ (APW-05 `plan.md` 1173→1763 lines, APW-06 1195→1852, APW-10 1033→1127,
and two changes altered golden output mid-task — APW-10 gained `authScheme` and `smtp` in `dependencies`, APW-05
gained the `verify` job).

`_build-artifacts/expected-outputs/golden/README.md` §8 records a **sha256 per spec file** at the revision the
goldens were derived from. **Any acceptance lane that compares real platform output against these goldens must pin
that revision**, or it will fail on drift rather than on a defect. Freeze revision:

| Item                   | Value                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Branch                 | `feat/app-works-implementation`                                                            |
| Commit                 | `9a379106b` (see the log below for later commits)                                          |
| Spec tree              | 124 files, 1830 relative links, **0 broken**; **548 acceptance ids defined / 548 indexed** |
| Golden checker         | `node check.mjs` → **All 2064 golden assertions passed**, exit 0                           |
| Blueprint specs (live) | `cal-diy-template` 22238 B · `umami-template` 9304 B · `app-fixture-hello-template` 6770 B |

### Known baseline conditions (recorded, deliberately NOT "fixed")

- **A full agent-package sweep is not a clean gate in this worktree, for two unrelated reasons.** Running all 820
  suites (`pnpm --filter @ever-works/agent test`, `--maxWorkers=2`) reported **4 failed suites / 2 failed tests**, and
  the split matters:
    1. **One genuine, PRE-EXISTING failure, nothing to do with App Works:** `agent-plugins/mcp-server-config.service.spec.ts`
       fails two assertions because this machine's temp directory is spelled `E:\temp\…` in the expectation and
       `E:\Temp\…` in the value — a **path-case artifact of Windows**, not a behaviour difference. Evidence that it is
       not ours: `git log --since=2026-09-17 -- packages/agent/src/agent-plugins` returns **zero commits**, and the two
       diffs are only the drive-directory's case (`packageRoot`, and `${PLUGIN_ROOT}/data` expansion, which the spec
       deliberately does not normalise because the string may not be a path at all).
    2. **Three suites that pass ALONE and fail only in the sweep** — `items-generator.module` (9/9 alone),
       `campaign-activation.service` (13/13) and `work-lifecycle.org-enrollment` (5/5) all reported "Test suite failed
       to run" under load while several agents were building and running suites on the same machine. Re-run them before
       treating a red sweep as a regression; the individual suites are the reliable signal here.
- **Prettier settings are PER PACKAGE, not global.** `packages/agent`, `apps/api` and `apps/web` each carry their own
  `.prettierrc` — printWidth **100**, tabWidth 4, **spaces**, trailingComma **"all"** — and those files resolve to it.
  Anything without one (`packages/plugin`, `packages/plugins/k8s`) resolves to the **root `package.json`** `prettier`
  key: printWidth **120**, **tabs**, trailingComma **"none"**. My own briefs said 120/none for agent and api files and
  were wrong twice; `prettier --check`, which every task runs, is what caught it. Check with
  `pnpm exec prettier --find-config-path <file>` rather than assuming.

- **Prettier drift is now FIXED** for the programme's own tree. `npx prettier --check "docs/**/*.md"` passes
  wholesale — the app-works specs, the internal app-works docs, and the two files a glob kept missing. It had been
  pre-existing drift across 34+ files, including all four programme-level files. Reformatting prose can silently
  drop emphasis, so before committing the pass I proved content survived: word counts identical (APW-06 `spec.md`
  10 882 → 10 882), paragraph-style emphasis preserved (`*and*` → `_and_`, `*not*` → `_not_`, 1 → 1), and the
  spec-tree checker still `CLEAN` afterwards.
- **`read:packages` is deliberately NOT added to `GITHUB_FULL_SCOPES`.** `GITHUB-PERMISSIONS.md` rows 18/19 record
  that APW-05 validates for `read:packages` while the platform's own scope set omits it, and it labels that a
  **gap** whose fix APW-05 owns. Adding it is additive but **widens the OAuth consent screen every member sees** —
  a real product decision — and APW-05's plan/tasks currently document the omission accurately as the present
  state. **Owner call:** add the scope (updating APW-05 `plan.md:42`, `tasks.md:296-302` and `GITHUB-PERMISSIONS.md`
  rows 18/19 together) or keep GHCR read on a separate user-supplied token.
- **`apps/api` has no `lint` script and eslint is not installed in this worktree**, so
  `pnpm --filter ever-works-api lint` can never pass here; the enforced gate is `prettier --check`. Worth a Wave-0
  CI note.
- **`packages/*/dist` staleness makes the documented test workflow unrunnable from a cold tree.** At the start of
  this branch `packages/{contracts,plugin,agent}/dist` were stale, so _no_ `apps/api` suite could even start
  (`Tests: 0 total`) until `contracts`+`plugin` were rebuilt. The pre-build step is missing from the documented
  workflow and will bite the next agent.
- **Five Blueprint ✗ spec findings are recorded, not fixed** (golden `README.md` §5): two of three Blueprints declare
  a cron that the managed tier refuses (`CRON_TOO_FREQUENT`); the fixture and Cal.diy declare `smtp`, which a
  _verification_ Build cannot start (`verificationDependencyUnsupported`) so only Umami is runner-verifiable as
  written; the App spec's component/cron/volume caps (10/20/5) exceed the Work CRD's (8/10/4) so
  `SPEC_LIMIT_EXCEEDED` can refuse a spec APW-03 accepted; Umami's image switches user by NAME and nothing renders
  `runAsUser`; and `EW_VERIFY_BUILD` has no derivable value.
- **`_build-artifacts/expected-outputs/manifests/` is stale** relative to the Blueprints (the fixture worker still
  renders 48Mi/96Mi where the Blueprint now says 64Mi/128Mi). Recorded; the newer `golden/` tree supersedes it and
  nothing was deleted.
- **`ever-works/platforms` is private while the launcher catalog reader fetches it over the public raw host**, so
  the launcher's P1 read would fail until it is made public or read with a token. Recorded in CONTRACTS §8,
  README §8 Q7, TRACKER and APW-11 T18. **Owner call.**
- **Ten owner decisions stay open by design**, surfaced with recorded defaults and never silently decided:
  APW12-G15, APW08-G25, APW09-G24, APW11-G20, EXT-30, EXT-15, EXT-19, GAP-19, GAP-29 — plus the APW-09 FR-41
  operator deny-list route, which has no owning epic and needs one assigned.
- **`Actions: write` vs `administration`** in APW-02 `plan.md` §4.5 is still an open discrepancy.

---

## 1. Track A — close the gap register

### A1. Blockers (24)

| #   | Gap                                                                                  | Area   | Confirmed  | Status                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | ------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `APW01-G01` prerequisites/merge order omit tasks APW-01 P1 compiles against          | APW-01 | yes        | `[ ]`                                                                                                    |
| 2   | `XC-02` new upstream workflows run before Actions hygiene, can read `EW_` secrets    | APW-02 | unverified | `[ ]`                                                                                                    |
| 3   | `APW03-G01` APW-03 P2 ↔ APW-01/APW-06 dependency loop                                | APW-03 | yes        | `[ ]`                                                                                                    |
| 4   | `EXT-01` `ever-works/apps` catalog repository does not exist                         | APW-03 | unverified | `[x]` **resolved** — `ever-works/templates` created and seeded 2026-09-17                                |
| 5   | `APW04-G01` no execution path puts a provisioning run in the restricted sandbox      | APW-04 | yes        | `[ ]`                                                                                                    |
| 6   | `APW05-G01` push/PR runs never discovered without a webhook                          | APW-05 | yes        | `[ ]`                                                                                                    |
| 7   | `APW05-G02` verification Build cannot run — no workflow, verify mode builds no image | APW-05 | yes        | `[ ]`                                                                                                    |
| 8   | `APW05-G03` push-started Builds can never be deployable; no preparation state        | APW-05 | yes        | `[ ]`                                                                                                    |
| 9   | `XC-01` PR and verification builds hand every `EW_` secret to unreviewed code        | APW-05 | unverified | `[ ]`                                                                                                    |
| 10  | `GAP-07` push/PR Builds discovered only from webhooks; no epic installs one          | APW-05 | unverified | `[ ]`                                                                                                    |
| 11  | `APW06-G01` kubeconfig save path dials the user cluster from the API process         | APW-06 | yes        | `[ ]`                                                                                                    |
| 12  | `APW06-G02` the Trigger worker cannot host `app-deploy` as planned                   | APW-06 | yes        | `[ ]`                                                                                                    |
| 13  | `GAP-06` namespace policies ↔ dependency ordering circularity                        | APW-06 | unverified | `[ ]`                                                                                                    |
| 14  | `APW07-G01` first-Deployment deadlock between providers and namespace                | APW-07 | yes        | `[ ]`                                                                                                    |
| 15  | `APW10-G01` in-zone dependency provisioning contracted to APW-10, no task builds it  | APW-10 | unverified | `[ ]`                                                                                                    |
| 16  | `GAP-22` no SMTP dependency can work on the tier; both Blueprints need one           | APW-10 | unverified | `[ ]`                                                                                                    |
| 17  | `APW13-G01` no working mechanism gives a throwaway test user a GitHub connection     | APW-13 | unverified | `[ ]`                                                                                                    |
| 18  | `APW13-G02` PR lanes start no background job runtime                                 | APW-13 | unverified | `[ ]`                                                                                                    |
| 19  | `GAP-01` all three Blueprint drafts fail blueprint-mode validation                   | APW-13 | unverified | `[x]` **resolved** — drafts fixed and validator green on 42 fixtures (`_build-artifacts/apw-03-schema/`) |
| 20  | `EXT-02` Blueprint drafts are not valid Blueprint repositories (catalog C4)          | APW-13 | unverified | `[x]` **resolved** — repos created with `ever-works-app-blueprint` topic + valid specs                   |
| 21  | `EXT-03` fixture application has no source, image or CI                              | APW-13 | unverified | `[x]` **resolved** — `ever-works/app-fixture-hello` created and seeded (54 files)                        |
| 22  | `EXT-04` test estate does not exist                                                  | APW-13 | unverified | `[~]` owner decided: **an Ever Works tenant**, not a GitHub test org; repos exist, tenant remaining      |
| 23  | `APW13-UF-01` Umami image switches to a user by NAME; refused under `runAsNonRoot`   | APW-13 | unverified | `[ ]`                                                                                                    |
| 24  | `APW13-UF-02` Cal.diy image runs as root and writes into its own files at boot       | APW-13 | unverified | `[ ]`                                                                                                    |

### A2. Confirmed non-blocker gaps (110)

52 high + 58 medium, all adversarially confirmed. Worked per area, below.

### A3. Unverified gaps (334)

Triage adversarially before acting: open the cited files first; **an agent failure is not a refutation.**

---

## 2. Track B — implement the waves

Per `docs/internal/app-works-implementation-plan.md` §3–§6.

### Wave 0 — independent fixes (ship first)

| PR  | Scope                                                                                                                                     | Status |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0.1 | Agent git tools resolve provider/owner/repo from the Work's repository, honour `branch`, refuse protected branches — **tests first**      | `[ ]`  |
| 0.2 | Checkout directory keys unique/case-preserving/provider-scoped; no silent `git init`; non-blocking fork request with existing-fork lookup | `[ ]`  |

Verified defect premises at `origin/develop @ 653449ad3`:
`apps/api/src/agents/agents.module.ts:685` and `:706` hard-code `providerId = 'github'`; `:700` returns
`branch: branch ?? 'main'` that nothing uses; `:732-733` pass `owner: ''` / `repo: ''`;
`packages/plugin/src/git/git-operations.ts:306-308` keys the checkout by `slugifyText(owner-repo)`; `:113-125`
silently `git init`s when the remote is missing.

### Waves 1–3

Mirrors the plan's step tables. Tracked per epic in §3.

---

## 3. Track C — per-epic status

| Epic                          | Spec  | Gaps closed | Implemented | Tested | Notes |
| ----------------------------- | ----- | ----------- | ----------- | ------ | ----- |
| APW-01 app Work kind          | ready |             |             |        |       |
| APW-02 fork lifecycle         | ready |             |             |        |       |
| APW-03 App spec + catalog     | ready |             |             |        |       |
| APW-04 App Provisioner        | ready |             |             |        |       |
| APW-05 builds                 | ready |             |             |        |       |
| APW-06 app runtime            | ready |             |             |        |       |
| APW-07 app env + dependencies | ready |             |             |        |       |
| APW-08 evolve loop            | ready |             |             |        |       |
| APW-09 upstream pull requests | ready |             |             |        |       |
| APW-10 apps hosting tier      | ready |             |             |        |       |
| APW-11 app launcher           | ready |             |             |        |       |
| APW-12 Ever ID                | ready |             |             |        |       |
| APW-13 golden paths           | ready |             |             |        |       |

---

## 4. Track D — external / operator work

| Item                                                                                                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `ever-works/templates` (public), `app-fixture-hello`, `app-fixture-hello-template`, `cal-diy-template`, `umami-template`, `platforms` | `[x]` created + seeded 2026-09-17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `gh api repos/ever-works/<r>`                                                 |
| **`auth.ever.co` DNS**                                                                                                                | `[x]` **live** — proxied `CNAME` → `5a1c27a6-…cfargotunnel.com` in the `ever.co` zone, record id `506584f8c80e91b9f5f589109b46afbf`. Resolves through Cloudflare and answers **404 from nginx**, which is the correct pre-deploy state (the tunnel reaches the cluster; nothing claims the host yet).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `Invoke-RestMethod` create + `Resolve-DnsName` + `HEAD https://auth.ever.co/` |
| **`auth.ever.co` — ZITADEL stand-up**                                                                                                 | `[~]` **manifests done and in review**; **not deployed**. New `ever-id-prod` app in `ever-co/k8s-gitops` on branch `feat/ever-id-zitadel` → **PR [#56](https://github.com/ever-co/k8s-gitops/pull/56)**. Also a new `Database/zitadel` on the shared CNPG cluster. Verified: all JSON parses, `kubectl kustomize` builds, `--dry-run=client --validate=strict` creates all 7 objects. Secrets come from OpenBao at `ever/id/prod/zitadel` and are **not** provisioned yet, so the pod cannot start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `gh pr view 56 --repo ever-co/k8s-gitops`                                     |
| Ever Works test tenant for the acceptance lanes                                                                                       | `[x]` **done** — see the box below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `docs/internal/app-works-test-estate.md`                                      |
| PR to `ever-co/ever-teams` / `ever-co/ever-gauzy` for Ever ID                                                                         | `[ ]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | owner authorised                                                              |
| Existing `repo`-kind regression suites stay green                                                                                     | `[ ]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | every change is additive                                                      |
| **🛑 `ever-works/platforms` is PRIVATE — the launcher's production catalog read cannot work**                                         | `[ ]` **owner call.** Measured 2026-09-18: `gh repo view ever-works/platforms` → `isPrivate=true`, and `HEAD https://raw.githubusercontent.com/ever-works/platforms/main/platforms.json` → **404** for an anonymous client (GitHub answers 404, not 403, for a private repo — so this reads exactly like "the file is missing"). Plan §5.2 specifies a **raw-host, token-free** read, which is the same shape the **public** `ever-works/templates` already uses successfully (`…/templates/main/README.md` → **200**). Three ways out, all additive: **(a) make the repo public** — it carries app names, URLs and icons, the same class of content as the public `templates` repo, and needs no secret in the API process; **(b) keep it private and read it through the GitHub API with a platform PAT** — correct but adds a secret, a rotation and a token in the request path, and departs from §5.2; **(c) publish the catalog to a public mirror** — a second place to keep in step. **Recommended: (a).** T8 lands as specified meanwhile, so the switch is a visibility change, not a code change. | `gh repo view` + anonymous `HEAD` on both raw hosts                           |

### Track D — the test estate (done 2026-09-17)

**A "tenant" is not creatable here.** A `Tenant` is an internal 1:1-with-a-user container with **no create API**
(`packages/agent/src/entities/tenant.entity.ts:33,22-25,52-53`; `apps/api/src/scope/tenant-bootstrap.service.ts:10-14`).
The **creatable, user-facing scope is an Organization** (1 Tenant : 0..N Organizations —
`organizations/organization.service.ts:506`, `POST /api/organizations`), selected per request with the
`x-scope-slug` header. So the lanes get **organizations**, not a second tenant:

| Object       | Slug              | id                                     |
| ------------ | ----------------- | -------------------------------------- |
| Organization | `app-works-dev`   | `cf89c6bb-3cbd-46d9-b73e-db57466c804e` |
| Organization | `app-works-stage` | `ef834760-935c-44f0-921f-103959f2644e` |

Isolation is **proven with a negative control**: `GET /api/schedules` → `count=29` unscoped, `count=0` for each new
scope, **HTTP 404** for a fake slug. The account's own active scope did not move.

**Four estate gaps were found and are NOT worked around** (they are recorded, not papered over):
`ever-works/templates` has **no `e2e` branch** although the dev/stage catalog pin requires one; `MAILHOG_URL` has no
source in `.config` (APW-07's mail sink appears undeployed); `EVER_WORKS_GITHUB_PAT_CLASSIC` lacks `read:org`; and
the **git connection is per-User, not per-Organization**, so both scopes share one GitHub identity.

### Track D blocker — 🛑 **the backups-first gate is TRIPPED cluster-wide (not an App Works defect)**

**On-site Ceph RGW is unreachable, so WAL archiving to `s3://pg-backups` has failed since 13:50Z on 2026-09-17.**
All three gateways and the MetalLB VIP are dark, from the local machine _and_ from inside the cluster. `rgw-lb/rgw-s3-lb`
is `0/5` ready and its log is a continuous `rgw_nodes/<NOSRV> … SC` stream. `pg_stat_archiver` on primary `pg-2`:
`last_archived_time 13:50:32Z`, `last_failed_time 21:30:58Z`, `failed_count 1084`; ~110 WAL segments queued. Also
failing on the same endpoint: `pg-logical-dump`, `pve-config`, `offsite-sync`, `openbao-raft-snapshot`,
`openbao-auto-unseal`.

**No data is lost and nothing was changed** — this was diagnosed read-only and recorded on the fleet board
(`ever-co/homelab` `MAINTENANCE.md`, commit `2f06199`). The consequence for _this_ programme: **the Ever ID database
cannot be added to the shared cluster until archiving is healthy**, which is exactly what the fleet's backups-first
rule requires. The remaining restore point is the `pg-nightly-20260917020000` base backup plus WAL to 13:50Z.

---

## 5. Log

Newest first. One line per meaningful step, with the commit sha when pushed.

- **2026-09-18 · the App spec's references and rules, and a seed route the e2e lane can trust.**
  **APW-03 T4/T5** — `app-spec.refs.ts` (1190 lines) and `app-spec.rules.ts` (1958), four new files,
  **5504 insertions, zero deletions**; the `works-config` sweep goes **387 → 550 tests** across 16 suites.
  T4 implements every row of schema.md §21 with an accept **and** a refuse case, Tarjan cycle detection (a
  three-entry cycle names all three, a self-reference is a one-entry cycle, two independent cycles are both found,
  a diamond is not a cycle) and the depth-10 limit. T5 implements **R1–R27 as pure functions** plus the four
  companions the T3 handoff assigned here — the quantity RANGES T3 deliberately left out of the schema,
  `http.body` over 16 KiB, `cron_invalid` via `parseCron`, and RE2 `pattern_unsupported` — with a registry test
  that every §22 rule id and every code has a failing _and_ a passing fixture asserting code, severity, line and
  column, and §24.4's display paths pinned exactly.
  🌟 **The best evidence of the round came from a perturbation that could not fail:** making R27 read a `fork`
  relation as private produced **zero red**, which means the assertion was missing rather than the code correct —
  the assertion was added and the same perturbation re-run red. Four other perturbations (depth off-by-one, Tarjan
  replaced by a depth check, R4 ignoring the implicit `<NAME>_PUBLIC`, R24 _guessing_ a licence class with no
  registry) were red on the first try, all restored to `75A977AE…` / `5C59E6BF…`.
  Honest boundaries, all decisions rather than omissions: the five **server-only** codes stay with T6 and the
  context type reserves their §22 field names; R24 and R27 **skip** when their registry/visibility input is absent
  because a guess is worse than silence; and T6 must not re-emit this task's codes or one leaf gets two reports.
  Two requirements nobody owns yet are flagged: §16:363's "`smoke.http.body` is POST only", and secret-scanning
  `build.services[].env[].value` (R10 covers `build.args[].value` only — and §24.1's `POSTGRES_PASSWORD:
build-only` service env suggests that limit is deliberate).
  **APW-11 T33 — the non-production seed route** (515-line controller + 234-line DTO + 24 tests; api `app-launcher`
  106 → **130 tests**). The gate is the point: production answers **404 even with the variable set**, an unset
  variable answers 404 anywhere, both from a guard and never 403. It is deliberately **not** behind the launcher's
  own switch, because T20's flag-off lane must be able to seed the rows it then proves are invisible. Three
  perturbations red, restored to `78132EB4…` — the third wrote rows for a stranger and turned ACC-11-52's tile
  assertion red, which is the property that makes such a route safe to expose at all. R-40's config getter does not
  exist yet, so the gate is implemented locally behind an optional seam; landing the getter needs no change here.

- **2026-09-18 · the fork lookup becomes three steps, and the launcher switch gets one reader.**
  **APW-02 T17/T18** (github-plugin 226 → **255 tests**). `findExistingFork` was only the plan's step 1; it is now the
  contract-shaped public method — the same-name identity check (previous body preserved verbatim, shared through a
  pure `isForkOfUpstream`), then GraphQL filtered by owner, then a REST listing bounded at **three pages**.
  `forkRepository` keeps its signature and calls the same orchestrator before every create, which is what makes the
  lookup a capability rather than a private helper of the create path. T18 adds sync (409 → `conflict`,
  422 → `unprocessable`), divergence with the exact `owner:branch...branch` basehead, and branch refs —
  `updateBranchRef` **always** sends `force: false`, with the caller's option deliberately unread.
  The Done-when is asserted, not assumed: the happy path issues exactly **1 REST + 1 GraphQL + 1 REST**, and "nothing
  found" is exactly three listing calls, pages [1, 2, 3]. Five perturbations red, restored to `DA0EF3C3…`.
  🛑 **Three things plan §4.3 gets wrong, found with read-only `gh api` probes and recorded:** (1) `forkHeadSha`
  **cannot** come from a `per_page: 1` compare — compare commits are **chronological**, so that single commit is the
  OLDEST of the range, and unpaginated the list caps at 250 (probed on `nodejs/node`: `per_page=1` → `f131cca0…`
  while the branch tip is `d1ef63f8…`), so one extra branch read supplies the head; (2) GraphQL `affiliations` is
  **viewer-relative**, so step 2 finds a renamed fork only when the target owner is the token's own user or one of
  its orgs — every other owner relies on step 3; (3) a 200 merge-upstream with `merge_type` absent is reported as
  `merged`, the outcome that never under-reports a change, and `up_to_date` is only claimed from `none`.
  `base_commit.sha` as the upstream head **is** correct as written (it equals `main`'s tip, distinct from
  `merge_base_commit`).
  **APW-11 T9's config half** — `config.appLauncher.isEnabled()` now exists and **both** readers go through it: the
  guard's seam and `features.appLauncherEnabled` on `GET /api/config`, with `apps/api/src/config/constants.ts`
  _delegating_ rather than re-reading, so the two agree by construction (APW11-G12).
  ⚖️ **A contradiction inside T9's own task text, resolved deliberately and written down:** its guard line says
  `=== 'true'` while its accessor line asks for the platform's `truthy()` set. The **strict** reading wins — the
  controller spec already pins `'1'`/`'yes'`/`'TRUE'`/`''` as OFF, the "no installation stops working" rationale
  cannot apply to a variable this epic introduces (all three manifests ship `'false'`), and a surface-wide gate fails
  closed. One function decides it, which is the reason the accessor exists. Proven by two perturbations restored to
  `39E39C32…` / `114BE3CD…`: failing **open** when unset is 5 red, and making the controller stop delegating (back to
  `truthy()`) is 2 red — the two readers disagreeing is itself a test failure.

- **2026-09-18 · the fork lifecycle gets its state row, the launcher gets its routes: APW-02 T12–T14 + T15, APW-11 T9.**
  **APW-02 T12/T13/T14 — `WorkUpstreamState`** (entity 308 lines, migration 317, repository 483, specs 35 + 44 + 14;
  **2483 insertions, zero deletions**). The entity spec _and_ the migration spec both pin the **column count and the
  sorted name set against plan §3.1's table**, so the table and the entity cannot drift apart — that is the guard the
  "the table exactly" claim rests on. Registration is the three required places, all additions; `_repository-inventory.ts`
  is deliberately untouched because this repository is feature-owned.
  **Concurrency is the point and it is tested with real simultaneity:** both claim methods are driven by `Promise.all`
  of two calls, asserting the union of claimed ids has no duplicates _and_ that every due row was claimed exactly
  once. The plan's single `UPDATE … WHERE id IN (…)` was **rejected with a reason worth keeping**: two callers with the
  same `nowMs` write the same stamp, so a read-back cannot tell whose claim a row is. The implementation selects
  candidates then conditionally updates each row with the same predicate inside one transaction. The perturbation that
  removed the 600 s claim lease made the second call take the same row (union 6 entries, 3 unique ids). `down()`
  dropping `works` itself was another, and the `readinessState` default a third — all restored byte-identically.
  **APW-02 T15 — the AppWorks module** (module + barrel + 5-test spec; the three Activity families `APP_FORK`,
  `APP_ACTIONS`, `APP_UPSTREAM` with their feed-kind rows; the `"./app-works"` subpath). Its module spec is the pattern
  worth copying: it compiles the module **twice** — standalone with only the repository token overridden, and over a
  **real better-sqlite3 DataSource** that then queries the table — so a `forFeature` the DataSource never heard of
  fails with "no such table" instead of passing on a metadata comparison. The perturbation that emptied `providers`
  went red in _both_ compiles.
  **APW-11 T9 — the three routes, the guard and the module** (controller 416 lines + 45 HTTP-level tests, guard 73,
  module 51; `api.module.ts` +7/0). The guard answers an opaque **404, not 403**, on all three routes when the switch
  is off, because a switched-off feature must be invisible; the pin limit maps to **422 `{code:'pinLimit',limit}`**.
  Three perturbations red, restored to `01C1C781…` / `88BA0202…`. Note for future readers: **T9's text names
  `apps/api/src/app.module.ts`, which does not exist** — the root module is `api.module.ts`, and the spec now asserts
  the registration is present there.
  🛑 **A NEW MASKING HAZARD, found by this task's own run: `apps/api/jest.config.js` ignores TS2307.** ts-jest stayed
  green while `tsc` could not resolve `@ever-works/agent/app-launcher` at all (stale `packages/agent/dist`). Building
  the package fixed the type-check and _immediately_ exposed a real bad import in the new spec. The lesson already
  recorded for `packages/plugin/dist` now has teeth: **build the workspace packages before trusting an `apps/api`
  type-check**, and never read a green jest run as a type check.
  **Sweeps this round, and one that must NOT be read as a regression:** `apps/web` **422 files / 4062 tests green**
  (so the 21-locale edit and the two new guards are safe); contracts 3457 / 82; k8s plugin 578 / 18; github-plugin
  226 / 11; agent's targeted suites 353 + 332 + 79 + 81 + 387. The **full agent sweep (820 suites) reported 4 failed
  suites**, and the split matters: one is a genuine **pre-existing** failure (`agent-plugins/mcp-server-config`, two
  assertions differing only in the _case_ of `E:\temp` vs `E:\Temp` — that package has had **zero** commits since
  2026-09-17), and three pass alone (9/9, 13/13, 5/5) and failed only under load while several agents were building on
  the same machine. Both are recorded in the baseline-conditions section rather than "fixed".

- **2026-09-18 · three more slices: APW-11 T8 (catalog), APW-02 T16 (GitHub errors + facts), APW-06 T10 (k8s wrappers).**
  **APW-11 T8 — `PlatformCatalogService`** (schema 518 + service 835 + a 48-test spec, all new). The catalog is read
  **inside the API process** (APW11-G06), so this is where the fetch and its safety rules live: `_REPO` containment
  refused at boot, an 8,000 ms timeout, ≤ 24 entries, icons ≤ 16,384 B with SVG deny patterns, 3,600,000 / 30,000 ms
  TTLs and a `:last-good` entry with no expiry. **The hard-gated override is asserted in both directions** — the
  production check runs FIRST and returns before either variable is read, which the perturbation proved by reading
  `catalog.test` where `raw.githubusercontent.com` was expected. Three more perturbations (25th entry, oversize icon,
  `javascript:`/`http:`/userinfo) each went red and were restored to `4BE50593…` / `F7E35706…`. **A correction made
  mid-task paid off:** the spec reads the draft fixture **directly** instead of keeping a copy — the fixture's own
  header says it is this spec's fixture and that the two byte-heavy icons are generated at test time, so a second copy
  would only have drifted. Two judgement calls recorded rather than buried: `catalogAvailable` is false **only** when
  nothing can be served (a last-good serve is `true` plus the new `stale: true`, per the contracts comment and
  ACC-11-07), and the 8,000 ms timeout is pinned as the exported constant plus an `AbortSignal` rather than by waiting
  eight real seconds.
  **APW-02 T16 — GitHub errors and repository facts** (`github-errors.ts` 192 lines + two specs of 27 tests each;
  `github-api.service.ts` +76/−2). All seven plan §4.2 signal rows, including `x-ratelimit-reset` read as **epoch
  seconds** into the contract's ISO `retryAt`; `empty` probed **only** when `size === 0`, because `empty` from an
  unknown size is a claim GitHub never made. Four perturbations red, restored to `AFD611EA…` / `7B0B2D21…`.
  **Honest gaps stated, not invented:** plan §4.2 has no row for a 5xx, a transport failure or an unmatched 403, so
  those become `unprocessable` with the **real status preserved** (0 when no response arrived) — never `not_found`,
  never `unauthorized`, never a rate limit a caller would sleep on; and `license?.spdx_id` is followed literally, so a
  repository with no licence file leaves `licenseSpdx` unreported while `NOASSERTION` becomes `null`. Broadcast for
  callers: non-404 failures from this path are now `GitProviderRequestError` carrying `status` (plan §4.2's
  instruction), and every caller was checked.
  **APW-06 T10 — the k8s API wrappers** (`applyObject`, `readObject`, `listObjects`, `deleteObject`, `readPodLog`,
  `createSelfSubjectAccessReview`, plus `authorizationV1Api` on the factory). The trap was **which API flavour the
  package actually exports**: client-node 1.4.0 re-exports the **object-parameter** classes, whose methods resolve to
  the body, while the legacy positional classes resolve to a `RequestContext` — so a fully mocked suite could pass
  against the wrong shape, and one test loads the **real** client to prove the factory's constructor really has
  `createSelfSubjectAccessReview`. A response with no status is `allowed: false`: the permission probe **fails
  closed**. Five perturbations red, restored to `0AE79591…`. `readObject` omits `metadata.namespace` for an empty
  namespace, which is what makes cluster-scoped kinds work instead of 404.
  **Round totals:** 45 commits on the branch, all pushed, nothing merged. Verified suites this round: agent 353 + 180
    - 210 + 387, k8s 578, github-plugin 226, contracts 3457, web 6, apps/api 61. The **task-path meter** puts landed
      surface at APW-06 15 paths and APW-11 8 (see §5's meter entry) — the one crisp progress reading this programme has.

- **2026-09-18 · four more verified slices and one guard: APW-06 T11, APW-03 T3, APW-11 T7 and T6, plus T21.**
  **APW-06 T11 — the kubeconfig guard** (`app-kubeconfig.guard.ts` 863 lines + 44 tests; `errors.ts` gains exactly two
  codes). It refuses a kubeconfig's local-execution and file-reading features, requires a public https server and pins
  the validated IP. The trap it exists for is **IPv4-mapped and NAT64 addresses** — `::ffff:10.0.0.1` carries a private
  IPv4 inside an IPv6 literal, so a naive `10.0.0.0/8` check passes it — and the perturbation that removed the
  mapped-form re-check while leaving the deny tables intact is what proves it (3 red, including
  `::ffff:10.0.0.1 … expected true to be false`). Five further perturbations each went red and were restored to
  `B30D3610…`. It also ships a **source scan** with a vacuity check: any file under `src/app` that loads a kubeconfig
  must reference the guard, with a known-good control, so the next task cannot quietly bypass it.
  🛑 **Two spec-vs-reality findings routed, not fixed:** plan §6.1's claim that _"client-node does not follow
  redirects"_ is **false for the installed v1.4.0** (its `isomorphic-fetch` transport passes no `redirect` option and
  node-fetch v2 defaults to `follow`), so the transport fix belongs to T10/T14 — the guard can only guarantee one
  request to the validated literal IP with the 307 surfaced, which the mocked-307 test asserts; and plan §6.1
  (APW06-G20) places this classifier in `packages/plugin/src/helpers/cluster-address-policy.ts`, which does not exist
  and is outside T11's ownership, so it is exported from the guard and a later move is a re-export.
  **APW-03 T3 — the structural App spec schema** (1498 lines + 210 tests; `KIND_SPEC_SCHEMAS` gains `app`, +14/0).
  **No refinements anywhere, deliberately:** `z.toJSONSchema()` silently _drops_ them, so a `.refine()` would make
  T8's published artifact weaker than the runtime. The flagged trap was honoured — `source` and `components` stay
  optional — and the mutual-assignability assertion of plan.md:517-518 is written four ways (raw `z.input` → `AppSpec`,
  the reverse through an array-readonly normaliser, type identity, and a modifier-mismatch check that **names** the
  drifting field), going red when either field is made required. Six perturbations, each restored to `38B4E277…`.
  **And the artifact that registration turned red was regenerated, not hand-edited:** `works.v2.schema.json` is
  generated and has its own drift guard, so it is now 43,015 → 132,095 bytes, **+1378 lines / 0 deletions**; T8 still
  owns refining it. Whole `works-config` sweep: **387 tests / 14 suites green** (384 + 1 failure before).
  **APW-11 T7 — exposure on Work update** (8 files, +1041/−4; the four deleted lines are the pinned activity-type
  count 200 → 201 and three _widened_ imports). The subtle requirement is that "changed" compares the PAIR
  `(storedValue, storedExplicit)`, so `null → true` on an `app` Work is a real change while `null → null` and
  `true → true` write nothing at all — the perturbation that logs the no-op turns exactly those three tests red. The
  Activity row names neither the Work nor an address, asserted **against the produced record** (perturbation 3 put
  both into the summary and printed the offending row), and `feed-kind.ts`'s explicit classification is load-bearing:
  removing it is red while the fallback test stays green.
  **APW-11 T6 — `AppLauncherService`** (7 new files + 2 specs, 67 tests, written first: the suite started red on
  `Cannot find module '../app-launcher.service'`), plus the `"./app-launcher"` **subpath in
  `packages/agent/package.json`** — without it the module exists but is unreachable by T8's API module. Four
  perturbations restored to `E73ED38B…`, including the **chip rule** I routed to this task in advance:
  `findLatestReadyForWorks` decides liveness and `findLatestForWorks` stays unfiltered, so CANCELED/SUPERSEDED ⇒ no
  chip is the service's decision, not the repository's. Seams are named so the next tasks cannot miss them: APW-06 T17
  must bind a **batch** `findStateForWorks` over `WORK_APP_RUNTIME_STATES`, APW-06 T48 must bind over **this** module's
  `MANAGED_HOST_ROOT_RESOLVER` / `APP_PUBLISHED_HOSTS` tokens (a second `Symbol('APP_PUBLISHED_HOSTS')` would leave
  the port unbound), and APW-03 must bind `APP_SPEC_DISPLAY_NAMES`.
  **APW-11 T21 — the no-sign-on copy guard** (6 tests): it reads the term list out of `no-sso-terms-draft.md` rather
  than copying it, and scans **every launcher key in every bundle** instead of a fixed three namespaces — a spec
  pinned to those three would have scanned _nothing_ today and passed. Proven by three perturbations run as a pair: an
  English claim is 2 red; the German phrase with its row still `seeded` adds **no** red, which is the review state
  working; flipping the row to `reviewed` makes the guard name it. A control pins that spec §6's two permitted
  sentences ("You may need to sign in") do not match.
  🔧 **Convention corrected, and it cost two agents time:** prettier settings are **per package**.
  `packages/agent`, `apps/api` and `apps/web` each carry a `.prettierrc` (printWidth **100**, trailingComma **"all"**,
  spaces); everything without one — `packages/plugin`, `packages/plugins/k8s` — resolves to the root `package.json`
  key (printWidth **120**, **tabs**, trailingComma **"none"**). My briefs said 120/none for agent and api files, which
  is wrong; `prettier --check`, which every task runs, is what caught it both times.

- **2026-09-18 · a task-path METER, and the APW-09 interface handoff recorded in the spec tree.**
  **The meter.** `docs/specs/features/app-works/tools/verify-task-paths.mjs` reads all 13 epics' `tasks.md`, extracts
  the exact paths each task names, and reports which already exist. Building it taught the reason a naive version of
  this is useless: the tree writes the newness marker **two ways** (`(**new**)` 212 times, `(new)` 375 times), so a
  checker that knows only one of them reports ~1 400 "stale" paths that are simply not built yet. It is therefore
  published as a **meter, not a defect list** — and the crisp signal it does produce is "a path a task marks as new
  that already exists", i.e. landed surface: **APW-06 15 paths, APW-11 8, every other epic 0**, which matches exactly
  where this branch has work. Numbers: 699 tasks, 2 667 root-anchored paths (202 package-relative ones skipped rather
  than guessed at), 1 117 present, 1 550 absent — of which 629 are absent _because_ another task says it creates
  them. It refuses to report at all if it parses fewer than 600 tasks or 500 paths, so a broken parser cannot look
  like a clean tree.
  **The handoff.** CONTRACTS.md §3 now records that APW-02 T9/T10 landed the **interface half** of APW-09 T3
  (`createBranchFromSha?` / `updateBranchRef?`, both optional, both `Promise<GitBranch>`), that APW-09 T3 must
  therefore **implement, facade and test** them but **not re-declare** them, and that a different return type is a
  change in both epics in one PR. APW-09's own `tasks.md` gained the pointer. Two measured facts went in as well:
  `packages/plugins/gitlab` does not exist here, so the plan's "every existing implementation compiles unchanged"
  covers github-plugin + agent and not the three packages its wording implies; and `GitProviderRequestError` does not
  set `this.name`, so `error.name === 'Error'` while `message === reason` — branch on `instanceof` or `reason`, never
  on `name`, the opposite of `RepositoryNotReadyError`. Verified here: the spec-tree verifier is still
  **CLEAN (1833 links, 549/549 ids)**, **R- rows 41 → 41** so nothing was withdrawn, and CONTRACTS.md's 36 changed
  lines are **all table rows re-padded by prettier**, with the file's word count _rising_ 16 238 → 16 538. The golden
  README gained **§8.1**, which keeps provenance honest: §8 stays the revision the golden outputs were generated from
  (it is deliberately _not_ rewritten) and §8.1 records the current spec hashes as a **freshness** check, with the
  reading rule — a §8.1 mismatch means the specs moved, never that a golden file is wrong.

- **2026-09-18 · APW-02 T9 + T10 land: the git-provider contract grows its fork capabilities, additively.**
  **915 insertions, zero deletions**, five files: nine OPTIONAL fields on `GitRepository` (`source?`, `allowForking?`,
  `archived?`, `visibility?`, `stars?`, `sizeKb?`, `licenseSpdx?`, `empty?`, `movedFrom?`), nine OPTIONAL members on
  `IGitProviderPlugin` (`findExistingFork?`, `syncForkBranch?`, `getForkDivergence?`, `createRepositoryCopy?`,
  `setActionsPermissions?`, `createWebhook?`, `deleteWebhook?`, `createBranchFromSha?`, `updateBranchRef?`), the new
  `git-provider.app-forks.ts` types of plan §3.3, both re-export barrels, and a 34-test spec. Every added member's
  JSDoc states the caller must **materialise** it on the plugin instance first — the lazy-plugin proxy over-reports
  optional methods, so "the member exists" is not "the plugin implements it", and that is a real bug source this
  contract can prevent.
  Verified here (not taken on the agent's word): plugin **492 / 33 files** green (was 458/32; the new spec is the
  +34, and it passes 34/34 run directly), `type-check` exit 0 for plugin and github-plugin, the nine members read
  back **with `?`** and the nine fields **with `readonly … ?`** straight out of the file, and `git diff --numstat`
  = 219/0, 8/0, 20/0 plus two new files — so "every existing implementation compiles unchanged" is structural, not
  a claim. The required-member perturbation (make `findExistingFork` required) was captured red **twice**: the
  conformance spec (`TS2741`, `TS2344`) and, after a deliberate dist rebuild, the **dependent** github-plugin
  (`TS2420` on `GitHubPlugin`) — then reverted with sha256 `7E11E7BF…D4E` identical on both sides. That second red
  is the whole point of the dist-rebuild rule recorded further up this file.
  Two deliberate differences from plan §3.3, both additive and both reported rather than hidden: the error's
  `details` bag is a named exported `GitProviderErrorDetails` (same structure), and
  `createBranchFromSha?` / `updateBranchRef?` return `Promise<GitBranch>` because neither plan §3.3 nor CONTRACTS §3
  states a return type — if APW-09 wants another one, it changes in both epics at once, since the names and
  parameters already match.
  📌 **Handoff: APW-09 T3 must SKIP its interface edit.** CONTRACTS §3 lists `createBranchFromSha` / `updateBranchRef`
  as APW-09's, but APW-02 needed them first, so they are on the interface now; APW-09's tasks.md already anticipates
  the split. What remains for APW-09 T3 is the GitHub implementation (`createRef`, `updateRef({ force: false })`),
  the facade pass-throughs and its own specs. Also reported: `packages/plugins/gitlab` **does not exist** in this
  repo, so the plan's "gitlab compiles unchanged" is vacuous — the real dependents are github-plugin and agent.
- **2026-09-18 · two operator-facing facts measured, not assumed.** (1) **`ever-works/platforms` is PRIVATE**, and the
  anonymous raw-host read the launcher's production path depends on returns **404** — GitHub answers 404 rather than
  403 for a private repo, so this looks exactly like "the file is missing" to anyone debugging it later. The public
  `ever-works/templates` raw read returns 200, which is the control proving the mechanism itself works. Three
  additive ways out are written into Track D with a recommendation (make the repo public — it carries app names, URLs
  and icons, the same class of content as the already-public `templates`); T8 lands as specified meanwhile, so the
  fix is a visibility change, not a code change. (2) **The golden checker still passes: 2064 assertions, 0 failures**,
  re-run after today's contract additions (`AppPrecondition`, `runAsUser`) — it reads the spec tree and the
  Blueprints at run time and prints its own limits beside the verdict, so green here means "the rendered desired
  state still matches every Blueprint", not "a deploy would work".
- **2026-09-18 · the `app_launcher` Activity row stops reading "app launcher" in 21 locales (APW-11 T32, XC-24).**
  `ActivityTypeBadge` translates a row only when `TYPE_TO_I18N` names its `actionType`, and otherwise shows
  `actionType.replace(/_/g, ' ')` — the raw wire value. A missing entry is therefore neither a crash nor a blank: it
  is the English words "app launcher" rendered in a German, Japanese or Arabic UI, and it is invisible in an English
  screenshot. `app_launcher: 'appLauncher'` plus a colour entry (the one palette the table had not used, `sky`, so a
  launcher row is distinguishable at a glance from the deploy/plugin/member rows around it) are added, and
  `dashboard.activity.filters.types.appLauncher` now exists in **all 21 bundles** — real translations, not English
  fallbacks (ar · bg · de `App-Starter` · en · es · fr · he · hi · id · it · ja · ko · nl · pl · pt · ru · th · tr ·
  uk · vi · zh).
  The spec is `apps/web/src/components/activity-log/ActivityTypeBadge.unit.spec.tsx` — **4 tests**, and two design
  choices make it mean something: the `next-intl` mock resolves the key out of **the real `messages/de.json`**, so the
  test fails when a locale loses the key as well as when the component forgets to ask for it (a mock that echoed the
  key back would pass for both faults), and there is a **control** — an unmapped action type must still fall through
  to `some future type`, so "no raw text anywhere" cannot be what is being asserted, because the fallback is a
  feature and it stays. A fourth test walks all 21 bundles for the key, which is T32's "in every locale, in this PR"
  and is checked nowhere else. Proven by three perturbations, each captured red then reverted with its sha256
  restored: the `TYPE_TO_I18N` entry removed (1 red — T32's own "Done when"), the colour entry removed (1 red), and
  the key removed from `ja.json` (1 red). The control stayed green throughout, which is its job. Bundle edits are
  **1 insertion / 0 deletions per file, 21 files**, so nothing existing moved.
  🛑 **A baseline condition found while doing this, deliberately NOT fixed here: the non-English bundles are ~1,692
  keys behind English, each.** `apps/web/scripts/sync-locale-parity.mjs` backfills them with **English text** — its
  own run reported "33840 key(s) added across 20 locale(s)" — so running it inside a task silently turns 20 locales
  into copies of `en`. Its output was reverted to the committed bytes by a per-file copy (byte-verified: the diff
  went to zero files before this task's one line was re-applied), and the drift is recorded for the owner to decide
  on: it is a translation-programme decision, not an App Works task.
- **2026-09-18 · the launcher's operator switches are wired, and `AppPrecondition` stops being a dangling name.**
  **APW-11 T31 (the manifest half).** `.deploy/k8s/k8s-manifest.{dev,stage,prod}.yaml` and `apps/api/.env.example`
  now carry the five variables this epic introduces — `EVER_WORKS_APP_LAUNCHER_ENABLED`,
  `EVER_WORKS_PLATFORM_CATALOG_{REPO,REF,ENV,SELF_ID}` — with **24 / 24 / 24 and 18 insertions and zero deletions**.
  `_ENV` is a literal per file on purpose (`develop` / `stage` / `production`): its documented default is
  `production`, so an installation that never set it would show production addresses on stage and dev (spec FR-10,
  APW11-G19). The switch ships **`false` everywhere** — unset, empty and any unrecognised value are all the OFF
  state, so it cannot fail open, and flipping that one line is the whole operation (XC-10, FR-65).
  T31's stated Test is a hand-run `git grep`, which is a check someone must remember to run and which cannot tell
  the right container from the wrong one — and the container is exactly what matters here, because
  `PlatformCatalogService` fetches the catalog **inside the API process** (plan §5.2, APW11-G06), so a variable
  that only reached the web container would configure nothing. The grep therefore became a spec:
  `apps/api/src/app-launcher/__tests__/launcher-deploy-switches.spec.ts` — **13 tests** that parse the three
  manifests as YAML and assert, per file, that the API container carries all five, that **no other container
  carries the catalog variables**, that `_ENV` is that file's own environment, and that the switch value is exactly
  `'true'` or `'false'` (never `1`, `yes` or empty, which read as ON to a person and OFF to the guard). The
  switch's _value_ is deliberately not pinned: a test that failed when an operator turned the launcher on would be
  fighting the feature it guards. Proven by three perturbations, each captured red then reverted with the file's
  sha256 restored: `_ENV` deleted from the stage manifest (2 red), a catalog variable added to the **web** container
  (1 red), and the prod switch set to `"1"` (1 red). Hashes after revert: dev `9EB22AB1…`, stage `C7C84DF2…`, prod
  `4729DA54…`, byte-identical — and one perturbation taught a lesson worth recording: a `(?m)^…$` regex silently
  matches **nothing** in these CRLF files, which is why the edits are done by line identity instead.
  **Deferred, explicitly:** T31's second half — the controller-spec case that flipping the flag off leaves every
  stored row untouched and answers 404 on all three routes (ACC-11-50) — belongs with T9, which does not exist yet;
  it lands there rather than being simulated here.
  **`AppPrecondition` is declared.** APW-06 plan §3.1:375 and §5.1:674 name a shape
  (`{ code, names?, message, fixUrl? }`) as "unchanged", and §4.9's `APP_DEPLOY_PRECONDITIONS` /
  `APP_TARGET_REFUSED` bodies carry `unmet: AppPrecondition[]` — but **no such type existed anywhere under
  `packages/**`**, and the two renderers that needed it each declared a structurally compatible interface locally
instead (both even say "`AppPrecondition`-shaped" beside their own `AppRenderRefusal`). It is now declared in
`packages/contracts/src/apps/app-runtime.ts`, beside the union its `code`comes from, with three tests: only`code`+`message`are required, every §5.1 code is accepted, and`AppRenderRefusal`'s three codes are a subset of
`APP_PRECONDITION_CODES` — so the "`-shaped`" claim is checkable rather than aspirational. Additive throughout:
nothing renamed, nothing removed, the local interfaces untouched and still assignable. Two `@ts-expect-error`
pins make it non-vacuous, and the gate for them is **`type-check:tests`**, not the vitest run — vitest's own
typecheck does not cover spec files, which the first perturbation proved by staying green exactly where
`tsc -p tsconfig.speccheck.json`reported`TS2578: Unused '@ts-expect-error' directive`. §5.1's "`managed_ineligible`(+ reasons)" is recorded as an **open question** in the type's docstring rather than guessed: if that code needs a
fifth field, it arrives as another optional member. Contracts: **3457 / 82 files** green,`type-check`and`type-check:tests` exit 0.
- **2026-09-18 · the R-25 classification is closed for APW-11, and `AppComponentInput.runAsUser` lands (APW06-G26).**
  `AppLauncherPreference` is classified in the **account** domain of the AW-22 workspace backup
  (`data/account/app-launcher-preferences.jsonl`, `by: 'user'`), with **`redaction.ts` untouched** — the rows hold
  item keys, visibility, order and two flags, and the entity docstring says so at the table itself. T30 asked for
  three things and all three are pinned, in two suites rather than one: the coverage-table assertions in
  `collectors.spec.ts` (classified **once**, in `account`, `by: 'user'`; not dropped — asserted through
  `shouldDropEntirely`, the predicate the walk actually consults; the planned query is `equals: { userId }` **with and
  without** an active Organization and carries no `organizationId` predicate; `Work` is still referenced once, by
  `works/works.jsonl`, with `appLauncherExposed` on that row) and an **archive-level** test in
  `workspace-backup-runner.spec.ts` that runs the real runner, **reads the produced zip back with `jszip`**, and
  asserts the manifest lists the file with `records: 1` and the line is the pinned row.
  **Proven by four perturbations, each captured red then reverted with the file's sha256 restored:**
  `by: 'user'` → `organization` (2 assertions red: the classification and the query — the query one matters because
  this table has no `organizationId` column at all, so a `workspace` scope would have exported the person's pins to
  nobody), the appended file spec deleted (3 red across both suites — including the zip test, which is the point of
  having it), `AppLauncherPreference` added to `BACKUP_DROPPED_ENTITIES` (1 red), and `Work.appLauncherExposed`
  renamed (1 red). `domain-specs.ts` `A6E2D047…`, `redaction.ts` `2250A526…`, `work.entity.ts` `CF223914…` — all three
  byte-identical after the reverts. `redaction.ts` is not in the final diff, as T30 requires.
  Alongside it, **APW06-G26 is closed from the contract side**: `AppComponentInput` gains the optional
  `readonly runAsUser?: number` that APW-03 `schema.md:202` and APW-06 plan §4.4 already specify, so the renderer can
  finally _receive_ the field the spec has been describing (before this, an image whose `USER` is a name — Umami's
  `nextjs` — was undeployable on both targets with nothing an author could set). Additive and optional: existing App
  specs render byte-identically, the renderer's structural read and the declared field now agree, and **no change was
  needed in the renderer when the contract caught up** — only its stale comment was refreshed. Verified: agent
  **95 tests / 5 suites** green (`collectors`, `redaction`, `workspace-backup-runner`), k8s plugin **505 / 17** green,
  `tsc --noEmit` exit 0 for the k8s package against a **rebuilt** `packages/plugin/dist` (which now carries
  `runAsUser` — the dist-rebuild hazard below is not theoretical), prettier clean on all five changed files.
- **2026-09-18 · `77aed370c` + `02b17691f` — the shared contract surface lands.** `packages/contracts/src/apps/`
  goes in: nine modules (app-source, apps-limits, app-upstream, builds, app-env, app-dependencies,
  tenant-postgres-ddl, apps-tier, ever-id) plus two specs, **665 exported names of which 433 are runtime values,
  with zero collisions**. `apps` is wired into the package root and into the barrel-collision test.
  **A real bug was caught in review**: `export type *` looked right for these mostly-type modules and kept
  `tsc --noEmit` green, while silently dropping all 433 runtime exports from the package root — the break would
  only have surfaced at a consumer as "X is not exported". Verified the plain form is safe by scanning for
  collisions, and added a **named** guard to the barrel spec so it cannot recur silently.
  Also `'hosting'` appended to `CREDIT_PRICE_GROUPS`, which APW-10 T50 and ACC-10-55 need.
  Verified: contracts **3221 tests passed / 79 files**, `Type Errors no errors`, type-check exit 0, prettier clean,
  and `@ever-works/agent` type-check still exit 0 with the new barrel.
- **2026-09-18 · `f38d62deb` — the checks job gains its tracked-branch leg.** APW-08 FR-76 requires the
  `Ever Works check: {name}` legs on a same-repository pull request **and** on the tracked branch, so a change that
  lands by merge commit without an intervening pull request is still checked; APW-05's job was pull-request-only.
  The pinned golden workflow is updated to match, including its concurrency group.
- **2026-09-18 · `3cd65ef0c` — the tool description no longer lies to the model.** Both the `commitToRepo`
  JSON-schema description and the facade contract still said the branch "Defaults to the Work's main branch".
  After Wave 0 that default is _protected_, so omitting the branch now resolves it and then **refuses** — a model
  following the old text walks into a refusal every time. Both now say: pass a feature branch.
- **2026-09-18 · `af599d792` — the catalog-repo contradiction is resolved** (`ever-works/templates` is the default,
  `ever-works/apps` stays accepted) and `docs/**` passes `prettier --check` wholesale.

- **2026-09-17 · `85fef39ed` — Wave 0 landed, and the spec tree is CLEAN at 548/548.** Both Wave 0 PRs are
  implemented, tested and pushed; the 100 missing acceptance ids were indexed; five new programme documents arrived
  (THREAT-MODEL, GITHUB-PERMISSIONS, CLARIFICATIONS, JIRA-DRAFT, CONFIGURATION); resolutions continue to R-39; the
  golden expected-outputs tree and its negative controls land with a non-vacuous checker. **Two files a generator had
  deleted were restored rather than accepting the deletion.** Tests: plugin 419, github-plugin 172, git.facade 103,
  template-catalog 119, regression sweep 1208; type-check exit 0 for plugin/github-plugin/agent.
- **2026-09-17 · `2895456f3` — APW-06/07/10 blockers closed**, including the single reconciled ordering for the
  namespace↔dependency cycle and the SMTP relay that leaves LG-08 (ports 25/465/587) untouched.
- **2026-09-17 · `662851875` — APW-01/02/03/04/05/13 blockers closed**, including `XC-01` (PR/verify builds no longer
  get every `EW_` build secret) and `XC-02` (a workflow diff can no longer ride an upstream sync unconfirmed).
- **2026-09-17 · the three repaired Blueprint specs are LIVE.** Verified byte-for-byte: `cal-diy-template`
  22238 bytes, `umami-template` 9304, `app-fixture-hello-template` 6770 — local and remote sizes match. Until now the
  fixes existed only in the programme's spec tree, so the repositories the platform actually reads were still wrong.
- **2026-09-17 · the worktree was reconciled against the additive-only rule.** A generator had deleted two golden
  manifests; both were restored from `HEAD` rather than accepting the deletion, and the branch now reports **zero
  deleted files**.

- **2026-09-17 · 🔴 fleet incident found and escalated (read-only).** The on-site Ceph RGW is down; WAL archiving to
  `s3://pg-backups` has failed since 13:50Z. Confirmed from both sides of the network, recorded on the fleet board
  (`ever-co/homelab` commit `2f06199`). **Nothing was changed by me**; radosgw on the PVE hosts needs host access I
  do not have. This trips the programme's own backups-first precondition for adding the Ever ID database.
- **2026-09-17 · test estate done.** Two Ever Works **organizations** created (`app-works-dev`, `app-works-stage`)
  because a `Tenant` has no create API — isolation proven with a 404 negative control. Full record, the env/secret
  names the lanes need, and four estate gaps: `docs/internal/app-works-test-estate.md`.
- **2026-09-17 · APW-05 complete (interim report received).** All 26 APW-05 rows addressed. **`XC-01` verified real
  and fixed additively**: PR/verification builds no longer receive every `EW_` build secret, tracked-branch builds are
  unchanged, and two new Work-scope settings (`allowBuildValuesOnPullRequests` default `false`,
  `verificationPromptedValuesRequireApproval` default `true`) let an owner opt back in — no secret, path or capability
  removed. `GAP-07` reconciled with `APW05-G01` and solved once, in APW-05. New FR-71/FR-72, S32, T46, ACC-05-31/32.
- **2026-09-17 · three cross-agent defects routed to their owners** rather than fixed across folder boundaries: a
  broken `./APW-05-builds/plan.md` link in APW-08, a stale validator fixture-registry row in the APW-03 schema
  bundle (one missing accepted warning makes a valid spec fail), and a stale `catalog.md:265` that contradicts the
  corrected `schema.md` §3 — with an explicit warning not to apply `GAP-01`'s removal half, which would break the
  additive-only rule.
- **2026-09-17 · Wave 0 PR 0.1 in flight** — agent git tools (provider/owner/repo resolution, `branch` honoured,
  protected branches refused with `main`/`master`/`stage` as a non-configurable floor unioned with the Work's
  effective merge policy, fail-closed). 393 lines of tests written first.
- **2026-09-17 · Wave 0 PR 0.2 in flight** — checkout keys unique/case-preserving/provider-scoped; no silent
  `git init` when a repository is expected; non-blocking fork request that reuses an existing fork.
- **2026-09-17 · five spec agents in flight** — blockers + confirmed high/medium gaps for
  APW-01/02/03 · APW-04/05/13 · APW-06/07/10 · APW-08/09/11/12 (+ sole owner of README/CONTRACTS/ACCEPTANCE/TRACKER),
  plus the golden-outputs artifact.
- **2026-09-17 · Ever ID stood up as far as it can be without secrets.** `auth.ever.co` **DNS is live** (proxied
  CNAME to the cloudflared tunnel; answers 404 from nginx, the correct pre-deploy state). Full ZITADEL manifest set
  authored in `ever-co/k8s-gitops` → **PR #56** (`apps/ever-id-prod` + `apps/databases/database-zitadel.yaml` +
  the ArgoCD Application), pinned `v4.17.3`, API and login UI v2 in one pod sharing the bootstrap PAT over an
  `emptyDir`, `ExternalPort 443` with TLS disabled because Cloudflare terminates TLS and the tunnel speaks plain
  HTTP to nginx. Validated: JSON parses, `kustomize` builds, client-side strict dry-run creates all seven objects.
  **Not deployed** — it needs the OpenBao path `ever/id/prod/zitadel`, a `zitadel` LOGIN role on the CNPG primary,
  and the PR merged. Claimed on the homelab `MAINTENANCE.md` board first (commit `3a0c983`).
- **2026-09-17 · branch created.** `feat/app-works-implementation` cut from `plan/any-repo-as-work` @ `a183ecd70`.
  Baseline verified clean. Gap register copied into the branch. Four blockers already discharged by the artifact
  work: `EXT-01`, `GAP-01`, `EXT-02`, `EXT-03`.
