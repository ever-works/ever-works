# App Works — build readiness

**Prepared:** 2026-09-17 · **Branch:** `plan/any-repo-as-work` · **Scope:** the whole App Works program
(13 epics `APW-01`…`APW-13`) · **Entry point for anyone starting work on it.**

This is the single record of where the program stands: what is decided, what is fixed, what is built as an
artifact, what is still missing, and what the owner must approve before Wave 1 code starts. It reflects the plan
**as edited on 2026-09-17** (uncommitted on the branch at the time of writing — see §7).

**Short answer: Wave 0 can start today. Wave 1 starts when three approvals land — one of them a real design
decision that is already resolved in the plan and needs a yes.**

---

## 1. Where things live

| What | Path |
|---|---|
| The plan (13 epics, contracts, acceptance) | `docs/specs/features/app-works/` |
| Build order and owner decisions | [`../../../internal/app-works-implementation-plan.md`](../../../internal/app-works-implementation-plan.md) |
| **Build artifacts produced 2026-09-17** | [`_build-artifacts/`](./_build-artifacts/) — see §4 |
| Decision sheet for every open question | [`_build-artifacts/open-decisions/decision-sheet.md`](./_build-artifacts/open-decisions/decision-sheet.md) |
| Stale text the owner's answers left behind | [`_build-artifacts/open-decisions/contradictions.md`](./_build-artifacts/open-decisions/contradictions.md) |
| Ready-to-file Jira epic + 13 stories | [`_build-artifacts/open-decisions/jira-tickets.md`](./_build-artifacts/open-decisions/jira-tickets.md) |
| Template/catalog decisions and the resolver | [`_build-artifacts/templates-catalog/`](./_build-artifacts/templates-catalog/) |

---

## 2. Owner decisions applied (2026-09-17)

| Decision | Applied where |
|---|---|
| **Ever ID = ZITADEL**, self-hosted **as-is and unmodified**, one instance at **`auth.ever.co`** for every platform | `APW-12/idp-options.md` §6/§7 (status `Decided`, D1 = ZITADEL; Keycloak kept as the documented alternative); `cross-platform.md`; program README §8; implementation plan §2 |
| **Pure addition** — every platform keeps its own authentication and its own user database; duplicated profiles accepted; no existing sign-in flow changes | `idp-options.md` §7 (binding constraints), `cross-platform.md` §1.1 |
| **Provider plugins, one per provider** — `zitadel`, `keycloak`, `supertokens`, `auth0`; Gauzy integration is a plugin, **not core**; existing Keycloak core code moves into a plugin | `cross-platform.md` §5 + §3.1 (blast radius mapped in `idp-options.md` §7.3) |
| **Three repository roles**: Data (`data`) · **Work Repository** (`website`, app code, optional `-app`/`-website` suffix) · GitHub generated output (`work`, never deployed) | README §1 repository-role note; `APW-01/plan.md` §3.1; `APW-08/tasks.md` T11; CONTRACTS §2 |
| **Template provenance** — "Created from [public/private icon] Template Repo" in the Work Information block | README §1 note; `_build-artifacts/templates-catalog/plan-changes.md` C-2.4 |
| **`ever-works/templates`** is the human listing; templates are `-template` repos found by the existing GitHub suffix scan; a template may be **code-bearing** or **metadata-only**; the user forks **both** when the source is separate | README **D4 rewritten**; `templates-catalog/resolution-spec.md` |
| **Managed Apps tier runs like Works do today** — our own shared k8s with namespace isolation, plus connected customer nodes and customer clusters | implementation plan §2 row 5 (gate re-wording still to do — §6) |
| **No new PSL apex domain** — `<slug>.ever.works` or the tenant's custom domain | implementation plan §2 row 4 (D10/LG-15 re-wording still to do — §6) |
| Legal review of the licence classes: **yes, 100%**; Cal.diy: use the MIT community edition | `APW-13` unchanged; D13 confirmed |

---

## 3. Defects closed (verified)

**Blockers**

1. **The flagship Blueprints violated the spec's own reserved-name rule.** Cal.diy and Umami declared
   `EVER_WORKS_*` env entries, which `CONTRACTS.md:27` and `schema.md` R23 forbid. Renamed to `APP_*` with a
   comment explaining why. **Verified by execution** (§5): the working-tree Blueprints now pass the schema; the
   same files at `HEAD` fail with `reserved_env_name`, and the fixture Blueprint passes in both revisions as a
   control.
2. **The create-time deploy target was never derived.** `APW-01` persisted the choice and handed the requirement
   to `APW-06`, which never picked it up — so a Work created for **Your cluster** would read as **None** and refuse
   to deploy. Added **FR-63** to `APW-06/spec.md` and amended **T17** so `getOrCreate` derives the target.

**Wrong substrate claims** (the direction the docs' own rule calls dangerous — a false "we already have this")

3. `EXISTING-SUBSTRATE.md` said *nothing reads* `tasks.checks`; it is read **and executed** (repository-declared
   commands, allowlist-gated), and only `tasks.base_branch` is unread.
4. The agent-template row described a repo layout that does not exist (the shipped templates are an **in-code**
   catalog; the `ever-works/agents` reader fetches `manifest.json` only).
5. `taskIsolationTargetRepo` was listed as shipping; it is **declared but unconsumed**.
6. `CONTRACTS.md` cited a non-existent route (`POST /api/works/:id/deploy`; the real one is
   `POST /api/deploy/works/:id`), pinned the dispatcher arity at 13 (it is 14), and named the safety category
   `publish` where the closed vocabulary is `publish.external`.
7. The "existing unit suites are green" claim for `apps/api` was a **selected sum**: 11 suites passed, 9 failed to
   start, only 4 were re-run — 5 were never seen green, two of which ACCEPTANCE cites as evidence. Restated
   honestly in `ACCEPTANCE.md` §6.1 and the implementation plan.

**Contract gaps** (a declared setting or promise with no reader)

8. `upstreamPullRequests.maxOpen` had no reader (APW-09 hard-coded 2); `upstreamSync.enabled`/`branch`/`mode` had
   no reader, so `enabled: false` would have kept syncing on a timer. Both now read, both tasked.
9. The managed tier had **no log path** although `APW-06` FR-7/FR-48 route logs through it — `getAppLogs` is now a
   required P2 member of `IAppsTierProvider`.
10. `spec.agents.requireHumanMergePaths` was declared in CONTRACTS as "schema owned by APW-03" and appeared in no
    APW-03 document; `diffGuardedSpecBlocks`' field list contradicted its own note. Both fixed.
11. The verification namespace had **two names** (`<ns>-v<attempt>` vs `ewv-<work short id>-<attempt>`) — APW-04
    would have destroyed a namespace APW-06 never created, leaking one per attempt. One owner now.
12. `isolation_not_enforced` was attributed to APW-10 but absent from its refusal list; `Cancelled — quarantined`
    existed only in APW-10's rendering. Both now in APW-06/APW-10 respectively.
13. **The repository-role contradiction (C-09).** `APW-01` wrote the app-code fork under `relatedRepositories.data`
    and set `repos: { data: true, website: false }`, while the confirmed model says app code is the **Work
    Repository** (`website`). Fixed in `APW-01/plan.md` §3.1, and **`APW-08` T11** now sets
    `taskIsolationTargetRepo = 'website'` **and consumes the field** (the clone, build, deploy and `getRepoDir`
    must all resolve it — `getRepoOwner()` defaults to `data` and `provisionForRun` hard-codes `getDataRepo()`).
    Without that second half, every Task on an App Work would target a `<slug>-data` repository that never exists.
14. **Ten defects found by running the artifacts** (§5): cal-diy's password `validate.pattern` used look-around,
    which RE2 cannot compile (`pattern_unsupported`) — replaced with `minLength`; CONTRACTS §1's example referenced
    an undeclared `CRON_API_KEY`; and the same example passed `CALENDSO_ENCRYPTION_KEY` as a **build argument**,
    which the real Cal.diy Blueprint explicitly refuses because a build-arg secret can leak into logs and image
    metadata.
15. Nine of APW-09's 23 refusal codes had **no user-facing copy**, making its "one locale key per code" task
    unsatisfiable. All 23 now have copy.
16. **The fixture Blueprint could not validate at all** — its worker declared `memory: 48Mi`, below APW-03's own
    `MemQuantity` floor of `64Mi` (`schema.md:28`), which is an `out_of_range` error, and a spec with an error
    deploys nothing. ACC-E2E-05 and the ACC-13-* lanes could never have run. Raised to `64Mi`. **Re-verified by
    execution:** the validator now reports *"All 42 fixtures matched their recorded expectation"*.
17. **No APW-13 Blueprint could pass catalog CI.** `schema.md` §3 forbade `source` and `blueprint` in
    **blueprint mode** (`blueprint_mode_forbidden_key`) while catalog CI check C4 requires zero errors — and all
    three Blueprints declare both, because a Blueprint's file *becomes* the App Work's spec, where both are
    present. §3 now allows them and the rule that applies instead is that `blueprint.repo` names the repository
    the file lives in. The artifact's validator was corrected in step, so the deleted rule cannot propagate into
    `app-spec.rules.ts`.
18. **An acceptance scenario asserted a code that did not exist.** `ACC-03-36` expects `sourceOfferMissing` for a
    missing `license.sourceOfferUrl`, but that code appeared in no rule table and no code list. Added **R27**:
    `sourceOfferUrl` is required whenever the Work Repository is not public.
19. **A dangling section reference.** `schema.md` §4's table and three epics cite "§10" for `components`, but §9
    ran straight into the components table — there was no `## 10.`. Heading added.
20. **The plan forbade exactly what the owner asked for.** `R-16`, `ACC-06-27`, `ACC-13-20` and APW-06's domain
    section all said user apps must **never** live under the platform's own domain — while the owner's answer is
    `my-app.ever.works`. All four now allow it and forbid only a subdomain of **another Ever product's** domain;
    `EVER_WORKS_APPS_DOMAIN` now defaults to `EVER_WORKS_DOMAIN`; and **D10 was re-stated rather than silently
    kept**: the cookie-isolation argument that motivated a separate, PSL-listed apex is now an explicit
    implementation obligation (host-only `__Host-` Secure cookies on platform routes, no platform session cookie
    on app hosts, app hosts never serving platform pages).

---

## 3A. The "data repository" wording — **done** (2026-09-17)

**The reviewed pass is complete: 78 lines renamed across 24 files**, and it was a review, not a substitution.

The rule is stated once in [README §1](./README.md)'s repository-role note and once in
[CONTRACTS §2](./CONTRACTS.md): *where an epic writes "the data repository" to mean app code, read "the Work
Repository"*. **Nine instances were deliberately left**, and each is one of three legitimate kinds:

- **Real identifiers** — `WorkLifecycleService.syncFromDataRepository` (`APW-01/plan.md:536`), the persisted
  `dataOwner` / `dataRepo` columns (`APW-02/plan.md:204`), `delete_data_repository` in the delete request
  (`APW-01/plan.md:537`). All verified intact after the pass (`syncFromDataRepository` ×4,
  `delete_data_repository` ×7, `dataRepo` ×33, `dataOwner` ×3).
- **The `data` role itself** — `APW-01/plan.md:223` ("A Data Repository is optional for `app`") and the two
  vocabulary notes that define the rule.
- **One prose case worth a second look** — `APW-04/plan.md:135` ("Public data repositories mount tokenlessly"),
  which reads as the platform's general data-repository concept rather than the app-code fork. Left as written;
  if it means the App Work's code fork, rename it there.

---

## 4. Build artifacts produced (all under `_build-artifacts/`)

| Stream | Delivered | Evidence |
|---|---|---|
| `apw-03-schema/` | **`app-spec.schema.json`** — a real JSON Schema (draft 2020-12, 42 `$defs`) for the `app` kind spec, plus `validator-rules.md` mapping every `schema.md` rule to a schema construct or a named validator check | `evidence/validate.mjs` + **42 fixtures** (3 real Blueprints, the CONTRACTS examples, 18 negative fixtures, HEAD-revision controls) — **42/42 expectations met**, transcript included |
| `templates-catalog/` | The **`ever-works/templates` listing seed** (`manifest.json`, JSON Schema, `licenses.yml`, README) and the **resolution spec** (suffix scan with its real limits, classification, fallback order, fork plan, the two shapes, roles, provenance) | manifest validated with ajv against a 13-case matrix; 12/12 links resolve; every code claim cites `file:line` |
| `fixture-app/` | The **fixture application's source** — Dockerfile, `src/*.mjs`, migrations, `public/`, `test/` (7 files + helpers), `tools/` (incl. an in-process Postgres wire-protocol stub), `profiles/` (**5 App specs + a generator that validates them against the schema**), `.github/workflows/` (CI + the scheduled inherited-workflow marker), `VARIANTS.md` | **Executed, not asserted:** `npm run smoke` boots the app and calls every route — **18/18 checks pass**, including every App-spec observable (build-phase value in the image, no `localhost` in `/marker`, migration list, fresh worker heartbeat, `cronTicks` after an authorised tick, secret fingerprint only, volume writable, cron refuses anonymous, mail 503 without SMTP). `npm test`: **56/64 pass**. `profiles/`: **5/5 schema PASS**. Full transcripts and the honest gap list in [`fixture-app/evidence/proof.txt`](./_build-artifacts/fixture-app/evidence/proof.txt) |
| `expected-outputs/` | The **build workflow** the APW-05 plugin writes (with a README of all 44 interpolation points and the exact canonical-JSON bytes behind the fingerprint) and **golden rendered manifests** for Cal.diy and the fixture — 24 and 19 objects for `your-cluster`, plus a managed overlay each | 29 YAML / 53 objects parse; **940 assertions, 0 failures**; no secret value, real hostname or cluster address (verified by grep) |
| `open-decisions/` | **85-row decision sheet** (66 `[NEEDS CLARIFICATION]` markers + 19 items found by reading the code), the contradictions list, and **Jira drafts** (`EW-817`…`EW-830`) | every row cites `file:line`; 11 rows need the owner, 73 are plan-implied |

### 4.1 Conflicts the artifacts found that an implementer must be briefed on

- `expected-outputs/contradictions.md` — **14 code-vs-contract conflicts (`K-n`)** and **15 epic-vs-epic conflicts
  (`X-n`)**. The sharpest: the existing plugin cannot address an image **by digest** (`sanitiseDockerTag` strips
  `@` and truncates the tag to 12) and `CONTAINER_PORT = 3000` is a module constant; `k8s-api.service.ts` has **no**
  delete/scale/log/Job/PVC/policy/access-review method at all, so six APW-06 plugin methods have no implementation
  surface until T10; `envFrom` optionality and `imagePullPolicy` both default **inverted** against APW-06's stated
  intent; and `enableDeploymentWorkflows` disables every workflow not in `ACTIVE_WORKFLOW_NAMES`/`_FILES`, which
  does **not** contain `ever-works-build.yml` — so the existing Actions-hygiene path would disable the build
  workflow the plan generates (`E-7`; APW-02's `setActionsPermissions?` allowlist is the competing mechanism and
  nothing says which wins).
- **The managed tier's `Work` CRD cannot express much of the App spec** (`X-9`, `X-10`): no `smoke`, no
  `authScheme`, no `cron[].expect`/`component`/`concurrency`, no `cpuLimit`, and caps of 8 components / 10 cron /
  4 volumes against the schema's 10 / 20 / 5. Concretely, three of Cal.diy's cron entries use `authScheme: raw` and
  would be rendered `bearer` on the tier, breaking the routes the Blueprint says compare the raw header. **This is
  a design gap to close before APW-10 P2**, not a typo.
- The managed overlays in `expected-outputs/manifests/*/managed-overlay.yaml` use APW-06's quota numbers; they must
  be regenerated against APW-10's fixed profile once FR-47's values are settled (open question `Q-7`).
- **`components[].target` needs a per-component build, which APW-05 declares out of scope** ("build matrices (one
  App spec, one image)", `APW-05/spec.md` §7). Either the field goes, or APW-05 states that `target` selects a
  *stage within the one image*. No fixture uses it today.
- Two App-spec shapes the artifact accepts but recommends rejecting (`apw-03-schema/gaps-and-contradictions.md`
  Q3/Q5): `build.strategy: none` together with `components`, and `build.image` with a non-`image` strategy.
- Wiring the schema in needs an **`APP_SPEC_VERSION` constant** beside `WORKS_CONFIG_SCHEMA_VERSION`
  (`works-config.schema.ts:44`) so a newer `appSpecVersion` can downgrade unknown-key errors to warnings.
- **The three fixture defects found by running it are FIXED** (they were one bug, in the test stub):
  **only the first statement on a connection returned rows**, so `/readyz` (which pinged first), and `/state`'s
  heartbeat and cron reads (the 2nd and 3rd statements on its connection) all saw empty results. Reproduced
  directly (`store.schema_migrations.rows.length === 3` while the same query returned 0 as a second statement).
  Each read now runs as the first statement on its own connection — and since the fixture implements **no
  connection pooling by design**, that is also correct against real PostgreSQL. **Verified: smoke went 15/18 →
  18/18, tests 53 → 56 passing.**
- **What is still red in the fixture's own suite (unrelated to the above):** migration idempotency, the
  `variant/bad-migration` exit code, the `--label` observable, the bootstrap job's internal/public record,
  `test/mail.test.mjs` failing to load, two `pg.test.mjs` protocol cases, and `a wrong password is refused`
  (trips the 30 s timeout because the stub's SCRAM path does not answer a failed authentication). This is
  **stub-fidelity work** — statement handling, the auth path, one test's import — not app logic, and it is the
  honest remaining gap before the fixture is trustworthy in a lane.
- Also note `npm run smoke` **crashes at teardown on Windows** (a libuv double-close after all 18 checks have
  printed) — valid results, unusable exit code; re-run it on Linux before trusting the exit status.

---

## 5. Verification performed (not asserted)

- **The schema was executed**, not just written: it compiles with the repository's own ajv 8 draft-2020 build
  (`strict:false, allErrors:true`, as `packages/agent-plugins/src/schema-validator.ts:53` does) over 42 fixtures,
  and the run ends **"All 42 fixtures matched their recorded expectation"**. Working-tree Blueprints pass; `HEAD`
  Blueprints fail with `reserved_env_name`; the control passes in both. Running it is what found the RE2-illegal
  password pattern, the undeclared `CRON_API_KEY` reference, the secret-in-build-arg example, and the fixture's
  below-floor memory — four defects no amount of reading had surfaced.
- **All three Blueprints parse as YAML** with `kind: app` after every edit (23 / 8 / 14 env entries).
- **`auth.ever.co` is free** — verified against the live `ever.co` Cloudflare zone (79 records, no
  `auth.`/`zitadel.`/`sso.`/`id.`/`login.` host). This closes `idp-options.md` **D2**.
- **The Wave 0 defect claims were confirmed in source**: PRs opened with `owner: ''`/`repo: ''`, commits with no
  branch while the tool advertises one, `providerId='github'` hard-coded, the checkout-key collision, and the
  silent `git init` on a missing remote.
- **A live catalog bug, found by reading the real repos**: `ever-works/ever-works-website-template` **redirects to
  `ever-works/directory-web-template`** (same repository id 912916449), so the `ever-works/works` listing's
  `marketing-site` and `directory` blueprints currently fork **one** repository — while a proper
  `ever-works/web-template` exists. One-line data fix in `ever-works/works` (owner's call).

---

## 6. What still needs the owner

**Wave 1 approvals** (from the decision sheet's 11 `OWNER` rows; the count below is after the two already resolved):

1. **The repository role (C-09) — resolved in the plan, needs a yes.** App code is the Work Repository
   (`website` role). The alternative the audit preferred (keep `data` mechanically) would show Cal.com's source
   under the label "Data Repository" and leave an App Work no room for a real data repository. Reverting is a
   two-line change if you disagree.
2. **The managed-tier gate wording (B-01).** Your shared-cluster answer contradicts LG-01, LG-03 and LG-16 — all
   *operator-attested* items asserting separate hosts/network/egress identity — and D15. Approve replacement
   wording, or decide the tier gets its own hosts. **"Connected customer nodes" appears nowhere in the plan or the
   code**: it is genuinely new scope and needs its own epic or an explicit deferral.
3. **The PSL apex decision's remaining tail (B-02).** The domain reconciliation itself is **done** (D10 re-stated,
   R-16 / ACC-06-27 / ACC-13-20 / APW-06 aligned, `EVER_WORKS_APPS_DOMAIN` defaulting to `ever.works`). What still
   needs you: **LG-15** in APW-10's launch gate requires a PSL-listed apex and carries `APEX_NOT_ON_PSL` /
   `PSL_UNREACHABLE` probes — confirm they are marked *not applicable (owner decision 2026-09-17)* rather than
   deleted (no-removal rule), and confirm the compensating control in D10 (`__Host-` cookies) is the one you want
   rather than a future dedicated apex.
4. **Create the repositories (D-04):** `ever-works/templates`, `ever-works/{cal-diy,umami,app-fixture-hello}-template`,
   `ever-works/app-fixture-hello` (the fixture's source, a different repository from its `-template`), and
   `ever-works/platforms` (APW-11 P2). All are 404 today.
5. **The GitHub test estate (J-08):** the acceptance lanes need a test organization, a machine user and per-run
   throwaway upstreams (`ACCEPTANCE.md` §0.3).
6. **APW-06 ↔ APW-07** declare each other as dependencies. Recommended: **APW-07 owns the env/dependency contracts
   and lands first**; its dependency on APW-06 narrows to APW-06's ports/interfaces only (already written into
   `TRACKER.md`).
7. **Name a budget owner**, the abuse rota, **one retention number** (asked three times as B-09/B-14/B-15), and
   whether to file the Jira tickets now. Prices are not urgent.

**Also outstanding from earlier:** whether to commit this work, and the Jira project key.

---

## 7. State of the branch

**⚠️ Whoever commits must include the Blueprint fixes.** The two blocker fixes in the Blueprints (the `EVER_WORKS_*`
rename, the RE2-illegal password pattern and the fixture's below-floor memory) are **uncommitted edits in this
worktree**. If they are left out, catalog CI's reserved-name check fails again and the fixture stops validating —
the "known issue" would reappear as a regression. Commit the tracked changes as a set (`git status` lists them),
then decide separately about `_build-artifacts/`.

Everything in this report is **uncommitted** on `plan/any-repo-as-work` (the branch is not pushed; its base is
`873274c9f`, and `origin/develop` has since moved three commits further). The 2026-09-17 work comprises
**~26 modified plan files** and **~124 new artifact files** under `_build-artifacts/`.

Suggested first commit: the plan fixes and this report. For `_build-artifacts/`, decide where it belongs before
proposing the branch — it is five streams of build scratch (schemas, golden manifests, a fixture application,
decision sheets) and **probably should not reach the platform repository's PR**; the private Workspace mirror is
the natural home, and nothing in it is secret (all hosts are RFC 2606 placeholders, all digests synthetic, every
secret value the literal `<redacted>`). If it stays, add a `.gitignore` entry or keep it out of the PR explicitly.

---

## 8. Build order (unchanged, now unblocked)

1. **Wave 0 — start now.** `APW-08` P0 (agent git tools: provider/owner/repo resolution, `branch`, protected
   branches) and `APW-02` P0 (checkout keys, non-blocking fork request). Independent, small, tests-first, and
   **not touched by a single open question**.
2. **Wave 1 foundations (parallel):** `APW-03` P1 · `APW-02` P1 · `APW-07` P1 · `APW-11` P1 · `APW-09` P1.
3. **Wave 1 creation and running:** `APW-01` P1 → `APW-05` P1 → `APW-06` P1 → `APW-04` P1.
4. **Wave 1 loop:** `APW-08` P1 → `APW-13` P1 — the owner's Cal.diy example green on a user cluster.
   Wave-1 exit set: ACC-E2E-01…07, 09, 10(a), 11, 12, 14 plus the Wave 0/1 negatives.

Wave 2 (the managed tier for verified Blueprints, upstream PRs, Ever ID on Ever Works) and Wave 3 (any App Work
on the managed tier, cross-platform Ever ID) are unchanged — see [`TRACKER.md`](./TRACKER.md).
