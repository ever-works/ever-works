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

| Source | What it gives | Location |
| --- | --- | --- |
| Programme spec | 13 epics `APW-01`…`APW-13` + README, CONTRACTS (R-1…R-27), ACCEPTANCE (445 ids), TRACKER, EXISTING-SUBSTRATE, BUILD-READINESS | `docs/specs/features/app-works/` |
| Implementation plan | Wave 0…3 order, the eight decisions, operator notes | `docs/internal/app-works-implementation-plan.md` |
| **Gap register** | **455 rows** — 24 blockers, 158 high, 200 medium, 73 low; **119 adversarially confirmed**, 2 refuted, 334 unverified | copy in the branch root: `.app-works-gaps.json`; blockers also as `.app-works-blockers.json` (source: `ever-works/workspace` `knowledge/notes/2026-09-17-app-works/completeness/`) |
| Build artifacts | schema + validator + 42 fixtures, catalog design, fixture app, golden manifests, decision artifacts | `docs/specs/features/app-works/_build-artifacts/` |
| The spec tree's own checker | links + acceptance ids | `node docs/specs/features/app-works/tools/verify-spec-tree.mjs` |

**Baseline at branch creation:** spec tree **CLEAN** — 84 files, 935 relative links, 0 broken; **445 acceptance ids
defined, 445 indexed, 0 orphaned**, exit 0.

---

## 1. Track A — close the gap register

### A1. Blockers (24)

| # | Gap | Area | Confirmed | Status |
| --- | --- | --- | --- | --- |
| 1 | `APW01-G01` prerequisites/merge order omit tasks APW-01 P1 compiles against | APW-01 | yes | `[ ]` |
| 2 | `XC-02` new upstream workflows run before Actions hygiene, can read `EW_` secrets | APW-02 | unverified | `[ ]` |
| 3 | `APW03-G01` APW-03 P2 ↔ APW-01/APW-06 dependency loop | APW-03 | yes | `[ ]` |
| 4 | `EXT-01` `ever-works/apps` catalog repository does not exist | APW-03 | unverified | `[x]` **resolved** — `ever-works/templates` created and seeded 2026-09-17 |
| 5 | `APW04-G01` no execution path puts a provisioning run in the restricted sandbox | APW-04 | yes | `[ ]` |
| 6 | `APW05-G01` push/PR runs never discovered without a webhook | APW-05 | yes | `[ ]` |
| 7 | `APW05-G02` verification Build cannot run — no workflow, verify mode builds no image | APW-05 | yes | `[ ]` |
| 8 | `APW05-G03` push-started Builds can never be deployable; no preparation state | APW-05 | yes | `[ ]` |
| 9 | `XC-01` PR and verification builds hand every `EW_` secret to unreviewed code | APW-05 | unverified | `[ ]` |
| 10 | `GAP-07` push/PR Builds discovered only from webhooks; no epic installs one | APW-05 | unverified | `[ ]` |
| 11 | `APW06-G01` kubeconfig save path dials the user cluster from the API process | APW-06 | yes | `[ ]` |
| 12 | `APW06-G02` the Trigger worker cannot host `app-deploy` as planned | APW-06 | yes | `[ ]` |
| 13 | `GAP-06` namespace policies ↔ dependency ordering circularity | APW-06 | unverified | `[ ]` |
| 14 | `APW07-G01` first-Deployment deadlock between providers and namespace | APW-07 | yes | `[ ]` |
| 15 | `APW10-G01` in-zone dependency provisioning contracted to APW-10, no task builds it | APW-10 | unverified | `[ ]` |
| 16 | `GAP-22` no SMTP dependency can work on the tier; both Blueprints need one | APW-10 | unverified | `[ ]` |
| 17 | `APW13-G01` no working mechanism gives a throwaway test user a GitHub connection | APW-13 | unverified | `[ ]` |
| 18 | `APW13-G02` PR lanes start no background job runtime | APW-13 | unverified | `[ ]` |
| 19 | `GAP-01` all three Blueprint drafts fail blueprint-mode validation | APW-13 | unverified | `[x]` **resolved** — drafts fixed and validator green on 42 fixtures (`_build-artifacts/apw-03-schema/`) |
| 20 | `EXT-02` Blueprint drafts are not valid Blueprint repositories (catalog C4) | APW-13 | unverified | `[x]` **resolved** — repos created with `ever-works-app-blueprint` topic + valid specs |
| 21 | `EXT-03` fixture application has no source, image or CI | APW-13 | unverified | `[x]` **resolved** — `ever-works/app-fixture-hello` created and seeded (54 files) |
| 22 | `EXT-04` test estate does not exist | APW-13 | unverified | `[~]` owner decided: **an Ever Works tenant**, not a GitHub test org; repos exist, tenant remaining |
| 23 | `APW13-UF-01` Umami image switches to a user by NAME; refused under `runAsNonRoot` | APW-13 | unverified | `[ ]` |
| 24 | `APW13-UF-02` Cal.diy image runs as root and writes into its own files at boot | APW-13 | unverified | `[ ]` |

### A2. Confirmed non-blocker gaps (110)

52 high + 58 medium, all adversarially confirmed. Worked per area, below.

### A3. Unverified gaps (334)

Triage adversarially before acting: open the cited files first; **an agent failure is not a refutation.**

---

## 2. Track B — implement the waves

Per `docs/internal/app-works-implementation-plan.md` §3–§6.

### Wave 0 — independent fixes (ship first)

| PR | Scope | Status |
| --- | --- | --- |
| 0.1 | Agent git tools resolve provider/owner/repo from the Work's repository, honour `branch`, refuse protected branches — **tests first** | `[ ]` |
| 0.2 | Checkout directory keys unique/case-preserving/provider-scoped; no silent `git init`; non-blocking fork request with existing-fork lookup | `[ ]` |

Verified defect premises at `origin/develop @ 653449ad3`:
`apps/api/src/agents/agents.module.ts:685` and `:706` hard-code `providerId = 'github'`; `:700` returns
`branch: branch ?? 'main'` that nothing uses; `:732-733` pass `owner: ''` / `repo: ''`;
`packages/plugin/src/git/git-operations.ts:306-308` keys the checkout by `slugifyText(owner-repo)`; `:113-125`
silently `git init`s when the remote is missing.

### Waves 1–3

Mirrors the plan's step tables. Tracked per epic in §3.

---

## 3. Track C — per-epic status

| Epic | Spec | Gaps closed | Implemented | Tested | Notes |
| --- | --- | --- | --- | --- | --- |
| APW-01 app Work kind | ready | | | | |
| APW-02 fork lifecycle | ready | | | | |
| APW-03 App spec + catalog | ready | | | | |
| APW-04 App Provisioner | ready | | | | |
| APW-05 builds | ready | | | | |
| APW-06 app runtime | ready | | | | |
| APW-07 app env + dependencies | ready | | | | |
| APW-08 evolve loop | ready | | | | |
| APW-09 upstream pull requests | ready | | | | |
| APW-10 apps hosting tier | ready | | | | |
| APW-11 app launcher | ready | | | | |
| APW-12 Ever ID | ready | | | | |
| APW-13 golden paths | ready | | | | |

---

## 4. Track D — external / operator work

| Item | Status | Evidence |
| --- | --- | --- |
| `ever-works/templates` (public), `app-fixture-hello`, `app-fixture-hello-template`, `cal-diy-template`, `umami-template`, `platforms` | `[x]` created + seeded 2026-09-17 | `gh api repos/ever-works/<r>` |
| `auth.ever.co` — ZITADEL stand-up | `[ ]` | `ever.co` zone verified free |
| Ever Works test tenant for the acceptance lanes | `[ ]` | owner decision J-08 |
| PR to `ever-co/ever-teams` / `ever-co/ever-gauzy` for Ever ID | `[ ]` | owner authorised |
| Existing `repo`-kind regression suites stay green | `[ ]` | every change is additive |

---

## 5. Log

Newest first. One line per meaningful step, with the commit sha when pushed.

- **2026-09-17 · branch created.** `feat/app-works-implementation` cut from `plan/any-repo-as-work` @ `a183ecd70`.
  Baseline verified clean. Gap register copied into the branch for reference. Four blockers already discharged by
  the artifact work `EXT-01`, `GAP-01`, `EXT-02`, `EXT-03`.
