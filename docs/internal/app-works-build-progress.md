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

| Task      | Deliverable                                                                                                                | Test evidence                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| contracts | `packages/contracts/src/apps/` — 10 modules, 3 specs                                                                       | contracts **3332 / 80 files**, 0 collisions                                                                            |
| **T1**    | `app-runtime.ts` — 84 exports (12 unions, 38 precondition + 18 failure codes, 52 numbers)                                  | +111 tests, pins proven by 3 perturbations                                                                             |
| **T4/T5** | `app-names.ts` + `app-security.ts` — every name/label of plan §4.1, the whole §4.4 table                                   | k8s plugin **242 / 12 files** (was 184/10), one test per §4.4 cell                                                     |
| **T2**    | `app-deployment.types.ts` (29 types) + the ten **optional** `IDeploymentPlugin` members + `isAppDeploymentPlugin`          | plugin **458 / 32 files** (was 419/31); **vercel 51/2 IDENTICAL** and still builds — no existing plugin needed an edit |
| **T3**    | `packages/agent/src/app-runtime/{ports,default-ports,index}.ts` — every interface of plan §9.6 + five fail-closed bindings | agent **16 tests**; the `./app-runtime` subpath resolves after a build                                                 |
| T6/T7     | `app-manifest.renderer.ts` + `app-network-policy.renderer.ts`                                                              | running                                                                                                                |
| APW-11 T1 | `app-launcher.ts`                                                                                                          | running                                                                                                                |

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

For scale: this branch has completed **Wave 0's 2 tasks** and **4 of Wave 1's foundation tasks** (T1, T4, T5, plus
the contracts surface that T2/T3/T6 all compile against). Anyone reading this should treat "all waves end to end" as
a multi-month engineering programme with a team, not a single session — the point of this file is that every step
taken is _verified_, not that the whole thing is near done.

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

| Item                                                                                                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ever-works/templates` (public), `app-fixture-hello`, `app-fixture-hello-template`, `cal-diy-template`, `umami-template`, `platforms` | `[x]` created + seeded 2026-09-17                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `gh api repos/ever-works/<r>`                                                 |
| **`auth.ever.co` DNS**                                                                                                                | `[x]` **live** — proxied `CNAME` → `5a1c27a6-…cfargotunnel.com` in the `ever.co` zone, record id `506584f8c80e91b9f5f589109b46afbf`. Resolves through Cloudflare and answers **404 from nginx**, which is the correct pre-deploy state (the tunnel reaches the cluster; nothing claims the host yet).                                                                                                                                                                                               | `Invoke-RestMethod` create + `Resolve-DnsName` + `HEAD https://auth.ever.co/` |
| **`auth.ever.co` — ZITADEL stand-up**                                                                                                 | `[~]` **manifests done and in review**; **not deployed**. New `ever-id-prod` app in `ever-co/k8s-gitops` on branch `feat/ever-id-zitadel` → **PR [#56](https://github.com/ever-co/k8s-gitops/pull/56)**. Also a new `Database/zitadel` on the shared CNPG cluster. Verified: all JSON parses, `kubectl kustomize` builds, `--dry-run=client --validate=strict` creates all 7 objects. Secrets come from OpenBao at `ever/id/prod/zitadel` and are **not** provisioned yet, so the pod cannot start. | `gh pr view 56 --repo ever-co/k8s-gitops`                                     |
| Ever Works test tenant for the acceptance lanes                                                                                       | `[x]` **done** — see the box below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `docs/internal/app-works-test-estate.md`                                      |
| PR to `ever-co/ever-teams` / `ever-co/ever-gauzy` for Ever ID                                                                         | `[ ]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | owner authorised                                                              |
| Existing `repo`-kind regression suites stay green                                                                                     | `[ ]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | every change is additive                                                      |

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
