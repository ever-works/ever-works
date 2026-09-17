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

| Building block                                                                  | Evidence                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GitHub fork API call (`forkRepository`), template fork flow with owner picker   | `packages/agent` 54 suites / 856 tests green (fork facade, template catalog)  |
| Repository Work kind (`repo`) — URL parser, access probe, refusal guard         | same run                                                                      |
| Task → isolated workspace → checks → PR → merge policy; Fleet                   | same run (task workspace PR/merge-gate suites)                                |
| k8s deploy plugin: manifest renderer, server-side apply, user kubeconfig matrix | `packages/plugins/k8s` 10 files / 184 tests; `apps/api` **15 suites / 529 tests** (11 passed in the first run + 4 of the 9 that failed to start, re-run — **5 suites were never re-run**; see ACCEPTANCE §6.1) |
| Managed subdomains, custom domains, per-Work Postgres, deployment verifier      | `apps/api` + `packages/agent` runs above                                      |
| Runtime-loaded Blueprint catalog (`ever-works/works`)                           | `apps/api` catalog service suite                                              |
| GitHub plugin API surface                                                       | `packages/plugins/github` 8 files / 164 tests                                 |

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

## 2. Decisions the owner must make before Wave 1 starts

| #   | Decision                                                                                                                           | Default the specs assume                                   | Blocks              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------- |
| 1   | File Jira epic + 13 stories (APW-01…13)                                                                                            | `EW-TBD` placeholders                                      | tracking only       |
| 2   | Create the template repos — **answered (owner, 2026-09-17)**: the human listing repo is **`ever-works/templates`** (not `ever-works/apps`), and each template is its own `-template` repo: `ever-works/{cal-diy,umami,app-fixture-hello}-template` plus the fixture's **application source** repo `ever-works/app-fixture-hello` (a different repository from its `-template` — an earlier list conflated the two) | as specified in APW-03 `catalog.md`, APW-13                | APW-03, APW-13      |
| 3   | GitHub test organization + test user for the acceptance lanes                                                                      | placeholders in ACCEPTANCE.md §0.3                         | APW-13 lanes        |
| 4   | ~~User-apps apex domain (Public Suffix List submission takes weeks)~~ — **answered (owner, 2026-09-17): no new apex.** User apps run on `<slug>.ever.works` or as `<slug>.<tenant-custom-domain>`; the PSL/`<apps-domain>` work is dropped and D10's cookie-isolation premise must be re-stated, not silently kept | the existing subdomain mechanism                           | APW-06, APW-10      |
| 5   | Where the managed Apps tier runs — **answered (owner, 2026-09-17): the same way Works run today** — our own shared k8s with namespace-level isolation, **plus connected customer nodes** and customer k8s clusters. This replaces "rented, isolated capacity" and re-scopes APW-10's launch gate away from "own hosts/network/egress identity" | shared k8s + isolation, customer nodes optional            | Wave 2              |
| 6   | Ever ID identity provider + domain                                                                                                 | **provider answered: ZITADEL**, self-hosted as-is, additive only (owner, 2026-09-17 — `idp-options.md` §6–§7); domain still open | Wave 2 Ever ID      |
| 7   | Publishing home of the App Launcher web component and platform catalog                                                             | public catalog repo; component package home TBD            | APW-11 P2           |
| 8   | Legal review of `licenses.yml` classes                                                                                             | green / amber / red per CONTRACTS R-3                      | managed hosting     |

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
| 6    | **APW-08 P1** evolve loop: Task on the **Work Repository** (the app-code fork — see the repository-role note in the program README §1; *not* the `data` role), delivery chain PR → Build → Deployment, Goals/Missions scoped to App Works | "chat → change → live"                                             |
| 7    | **APW-13 P1** fixture app + Umami + Cal.diy Blueprints, acceptance lanes; run ACC-E2E-01…07, **09, 10(a)**, 11, 12, 14                                                                                                                              | **Wave 1 exit: the Cal.diy example green on a user cluster**       |

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
  touch Ever Gauzy production (`ever-gauzy-prod`); the managed Apps tier must not share hosts, network,
  data servers or edge with it (APW-10 launch gate).
- **Specs win over memory**: re-read the epic's `plan.md` + CONTRACTS §0 before coding; if `develop` moved,
  re-verify cited paths (a "we already have this" claim does not decay; "we don't have this" does).
- **Tests before code** for every epic task; a PR is done when its tasks' "Done when" lines are observable,
  its ACC ids pass in their lane, and TRACKER.md is updated.
- **Promote develop → stage → main** by the normal cascade; no cherry-picks.
- **Keep this repository public-safe**: no competitor names, no infrastructure specifics, no unfixed-defect
  reproductions (those live in the private operations repository).
