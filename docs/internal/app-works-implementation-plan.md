# App Works — implementation plan (internal)

**Created:** 2026-09-17 · **Verified against:** `develop` @ `e5f43f44d` (2026-09-17) · **Program:**
[`docs/specs/features/app-works/`](../specs/features/app-works/README.md) · **Status:** plan only — nothing
implemented, nothing pushed.

This is the build order for the App Works program ("any GitHub repository as a Work"): which pull requests
to open, in what order, what can run in parallel, what the owner must decide first, and how we prove each
step works. The binding details live in the Spec Kit program — README (decisions D1–D15), CONTRACTS.md
(shared names + audit resolutions R-1…R-25), each epic's `spec.md` / `plan.md` / `tasks.md`, and
ACCEPTANCE.md (the executable acceptance suite).

---

## 1. What already exists (so we don't rebuild it)

Verified 2026-09-17 by reading code and by running the existing unit suites on a clean `develop` checkout:

| Building block                                                                  | Evidence                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub fork API call (`forkRepository`), template fork flow with owner picker   | `packages/agent` 54 suites / 856 tests green (fork facade, template catalog)                                                                                                                                   |
| Repository Work kind (`repo`) — URL parser, access probe, refusal guard         | same run                                                                                                                                                                                                       |
| Task → isolated workspace → checks → PR → merge policy; Fleet                   | same run (task workspace PR/merge-gate suites)                                                                                                                                                                 |
| k8s deploy plugin: manifest renderer, server-side apply, user kubeconfig matrix | `packages/plugins/k8s` 10 files / 184 tests; `apps/api` **15 suites / 529 tests** (11 passed in the first run + 4 of the 9 that failed to start, re-run — **5 suites were never re-run**; see ACCEPTANCE §6.1) |
| Managed subdomains, custom domains, per-Work Postgres, deployment verifier      | `apps/api` + `packages/agent` runs above                                                                                                                                                                       |
| Runtime-loaded Blueprint catalog (`ever-works/works`)                           | `apps/api` catalog service suite                                                                                                                                                                               |
| GitHub plugin API surface                                                       | `packages/plugins/github` 8 files / 164 tests                                                                                                                                                                  |

Live GitHub probe (throwaway fork of GitHub's public fork-demo repository): fork usable ~6 s after the
request; a second fork request returns the existing fork; **Actions report enabled on a new fork** (inherited
workflows must be disabled explicitly); merge-upstream returns `merge_type` and compares against the upstream
default branch; cross-fork compare returns ahead/behind.

What does **not** exist: create-from-any-URL, a fork lifecycle (readiness, sync, divergence), an App spec,
builds of arbitrary repositories, multi-component runtime, schema-driven env and dependencies, upstream pull
requests, an App Launcher, Ever ID, and a hosting tier safe for user-controlled code. Two existing defects
block the loop and are fixed first (Wave 0): the agent git tools (`commitToRepo` / `openPullRequest`
bindings) and checkout-directory key uniqueness.

---

## 2. Decisions the owner must make before Wave 1 starts — **all answered 2026-09-17**

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Answer (owner, 2026-09-17)                                                                                                                                                                      | Blocks                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | File Jira epic + 13 stories (APW-01…13)                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **No — tracking docs are enough.** `TRACKER.md` is the system of record; the Jira export stays as a ready-to-import draft and is **not** filed                                                  | nothing                |
| 2   | Create the template repos — the human listing repo is **`ever-works/templates`** (**public 100%**); each template is its own `-template` repo: `ever-works/{cal-diy,umami,app-fixture-hello}-template` plus the fixture's **application source** repo `ever-works/app-fixture-hello` (a different repository from its `-template`); `ever-works/platforms` for the launcher catalog                                                                                                        | **Yes — create them all, private preferred**, except `ever-works/templates` which is public                                                                                                     | APW-03, APW-11, APW-13 |
| 3   | GitHub test organization + test user for the acceptance lanes                                                                                                                                                                                                                                                                                                                                                                                                                              | **Use an Ever Works tenant, not a test GitHub org** — the lanes provision their own tenant; `ACCEPTANCE.md` §0.3's org/machine-user names become one tenant plus the GitHub account it connects | APW-13 lanes           |
| 4   | User-apps apex domain — **answered and corrected the same day: no new apex is _registered_, and the dedicated PSL apex is KEPT.** Managed addresses default to the platform's own domain (`<slug>.ever.works`); the tenant's custom domain and its subdomains work through the shipped flow; a dedicated **PSL-listed** apex stays an operator-selectable configuration with LG-15 and its probes intact. Where the shared default is used, R-16's `__Host-` cookie controls are mandatory | three coexisting shapes (D10, R-16)                                                                                                                                                             | APW-06, APW-10         |
| 5   | Where the managed Apps tier runs — **answered: the same way Works run today, and the scope EXPANDS.** Our own shared k8s with namespace-level isolation **plus connected customer nodes and customer k8s clusters** — and, additively, a host reached over SSH or any further `deployment` plugin. This does **not** replace "own hosts/network/egress identity": LG-01/LG-03/LG-16 are kept and now carry a **per-shape attestation** (R-27, `APW-06-app-runtime/deploy-shapes.md`)       | shared k8s + connected nodes + customer clusters + plugins                                                                                                                                      | Wave 2                 |
| 6   | Ever ID identity provider + domain                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **ZITADEL**, self-hosted as-is at **`auth.ever.co`** (`ever.co` zone verified free), additive only, one instance for all platforms (`idp-options.md` §6–§7)                                     | Wave 2 Ever ID         |
| 7   | Publishing home of the App Launcher web component and platform catalog                                                                                                                                                                                                                                                                                                                                                                                                                     | catalog: `ever-works/platforms` (**create it**); component package home still open — `ever-co` at P2 per I-02                                                                                   | APW-11 P2              |
| 8   | Legal review of `licenses.yml` classes                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Yes, 100%** — reviewed before launch; Cal.diy uses the MIT community edition                                                                                                                  | managed hosting        |

**Follow-up to decision 2 (owner decisions, measured 2026-09-26).** The Cal Blueprint repository is
**`ever-works/cal-template`** (formerly `cal-diy-template`; Blueprint id `cal`, upstream `calcom/cal.diy`), and Umami's is
**`ever-works/umami-template`** (id `umami`). Both are **public**, not private, with the topic
`ever-works-app-blueprint`, and each keeps its App spec at `.works/works.yml`. The fixture's
`ever-works/app-fixture-hello-template` stays **private** and is not part of the catalog. `ever-works/templates` is a
pure listing — `manifest.json`, its schemas, `licenses.yml` and a validator that fetches each app row's own
`.works/works.yml` — and holds no per-template folders
([templates PR #1](https://github.com/ever-works/templates/pull/1)). Row 2 above and §4's step 7 keep their
2026-09-17 wording as the record of what was decided then.

---

## 3. Wave 0 — independent fixes (ship first, small PRs)

| PR  | Scope                                                                                                                                                                     | Epic phase | Proof                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------- |
| 0.1 | Agent git tools resolve provider/owner/repo from the Work's data repository, honour `branch`, refuse protected branches — **tests first** (they fail on `develop`)        | APW-08 P0  | new `agents.module` specs red → green |
| 0.2 | Checkout directory keys unique, case-preserving, provider-scoped; no silent `git init` when a repository is expected; non-blocking fork request with existing-fork lookup | APW-02 P0  | `git-operations` + facade specs       |

---

## 4. Wave 1 — the owner's example on a user cluster (ASAP path)

Order respects dependencies; items on the same line can run in parallel lanes (separate worktrees under
`E:\Coding\Worktrees\`, one PR each). Every PR carries its epic's migrations (reserved `1792…` block,
re-stamped before merge), i18n in all locales, and the tests its tasks name.

| Step | Parallel PRs                                                                                                                                                                                                                                       | Unlocks                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | **APW-03 P1** App spec schema + validation + `WorkAppSpecState` · **APW-02 P1** fork lifecycle + `WorkUpstreamState` + Upstream tab · **APW-07 P1** App env store + in-cluster dependency providers · **APW-11 P1** App Launcher inside Ever Works | shared contracts for everything else                               |
| 2    | **APW-01 P1** `app` kind, inspect endpoint, create (link / fork / private copy), capability flags, delete semantics                                                                                                                                | App Works can be created (flag `works-app` + API gate off in prod) |
| 3    | **APW-05 P1** `build` capability + GitHub Actions build plugin (+ checks matrix, verification builds)                                                                                                                                              | images by digest                                                   |
| 4    | **APW-06 P1** App renderer, Your-cluster target, isolated cluster worker, smoke tests, health, deletion                                                                                                                                            | the app is live                                                    |
| 5    | **APW-04 P1** App Provisioner agent template + Skill + verification loop (repos without a Blueprint)                                                                                                                                               | "AI decides how to run it"                                         |
| 6    | **APW-08 P1** evolve loop: Task on the **Work Repository** (the app-code fork — see the repository-role note in the program README §1; _not_ the `data` role), delivery chain PR → Build → Deployment, Goals/Missions scoped to App Works          | "chat → change → live"                                             |
| 7    | **APW-13 P1** fixture app + Umami + Cal.diy Blueprints, acceptance lanes; run ACC-E2E-01…07, **09, 10(a)**, 11, 12, 14                                                                                                                             | **Wave 1 exit: the Cal.diy example green on a user cluster**       |

Wave 1 exit criteria (from ACCEPTANCE.md): ACC-E2E-01, 02, 03, 04, 05, 06, 07, 09, **10(a)**, 11, 12 and 14 green in their
lanes, plus the Wave 0/1 negative scenarios. Only then flip `works-app` / `EVER_WORKS_APP_WORKS_ENABLED` on
for production users.

## 5. Wave 2 — managed hosting for verified Blueprints, upstream PRs, Ever ID for Ever Works

| Step | PRs / work                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **APW-10 P1** launch-gate definition, self-check endpoint, controller contract (`Work` resource) — in parallel: operations work from the private infra plan (isolated zone, sandboxed runtime, tenant data servers, edge, abuse controls) |
| 2    | **APW-10 P2** tier opens for verified Blueprints only (self-check green < 24 h) · **APW-06 P2** managed target via `apps-tier` · **APW-07 P2** tenant-only dependency providers                                                           |
| 3    | **APW-09 P2** Upstream pull requests (approval-gated, rate-limited)                                                                                                                                                                       |
| 4    | **APW-12 P0–P1** Ever ID decision + "Sign in with Ever ID" on Ever Works                                                                                                                                                                  |
| 5    | **APW-13 P2** managed-tier lanes; run ACC-E2E-08, 10, 13(a)                                                                                                                                                                               |

## 6. Wave 3 — any App Work on the managed tier, cross-platform

APW-05 P3 sandboxed in-zone builds · APW-06 P3 any App Work + preview Deployments · APW-10 P3 · APW-11 P2
web component for Gauzy/Teams with delegated `apps:read` · APW-12 P2 (Teams) → P3 (Gauzy production last,
behind an off-by-default flag, existing sign-ins kept).

---

## 7. Rules for whoever implements this

- **Claim live changes** on the shared board before any infra change (Wave 2 operations work), and never
  touch Ever Gauzy production (`ever-gauzy-prod`) — no tier workload, credential or egress identity may
  touch its namespace, its nodes' data plane, its data servers or its edge. **Everything else is per-shape and
  additive (R-27, `APW-06-app-runtime/deploy-shapes.md`)**: the tier may run on the **Ever Works shared customer
  cluster** in its own namespace + node pool + egress identity + ingress, **and** on a machine the owner connects
  to Ever Works, a customer-owned cluster, a host reached over SSH, or any provider published as a `deployment`
  plugin. Adding a shape never narrows an existing one — the earlier "must not share hosts, network, data servers
  or edge" wording is superseded by the per-shape attestations in APW-10's gate (LG-01/LG-03/LG-16), which locate
  the requirement on whichever shape a tenant actually runs on instead of removing it.
- **Specs win over memory**: re-read the epic's `plan.md` + CONTRACTS §0 before coding; if `develop` moved,
  re-verify cited paths (a "we already have this" claim does not decay; "we don't have this" does).
- **Tests before code** for every epic task; a PR is done when its tasks' "Done when" lines are observable,
  its ACC ids pass in their lane, and TRACKER.md is updated.
- **Promote develop → stage → main** by the normal cascade; no cherry-picks.
- **Keep this repository public-safe**: no competitor names, no infrastructure specifics, no unfixed-defect
  reproductions (those live in the private operations repository).
