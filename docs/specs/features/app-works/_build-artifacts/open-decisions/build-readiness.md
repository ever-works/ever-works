# App Works — can we start building?

**Short answer: yes for Wave 0 — start today. Wave 1 needs three approvals first, and only one of them is a
real design decision.**

**Prepared:** 2026-09-17, `plan/any-repo-as-work` worktree. **No existing file was modified.**
**Companion documents:** `decision-sheet.md` (all 66 + surrounding open items, one row each) ·
`contradictions.md` (the stale text the owner's answers left behind) · `jira-tickets.md` (ready-to-file drafts).

---

## 1. Wave 0 is not blocked by anything on this list

Wave 0 is two small, independent PRs (`TRACKER.md:30`, `implementation-plan.md:57-62`):

| PR      | Scope                                                                                                                                                                       | Open items that touch it |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **0.1** | Agent git tools: `commitToRepo` / `openPullRequest` resolve provider/owner/repo from the Work's repository, honour `branch`, refuse protected branches — tests first        | **none**                 |
| **0.2** | Checkout directory keys unique / case-preserving / provider-scoped; no silent `git init` when a repository is expected; non-blocking fork request with existing-fork lookup | **none**                 |

I checked each of the 66 `[NEEDS CLARIFICATION]` items against Wave 0: **not one of them is on the critical
path.** Both PRs are bug fixes in code that already ships, both have failing-test-first proofs named in
`implementation-plan.md:61-62`, and both are documented to the line in `APW-08-evolve-loop/plan.md:60-83` and by
direct reading of the source. **Wave 0 can start before the owner reads this sheet.**

**Wave 0 is real and worth doing first — verified:**

- `packages/agent/src/agents/agent-git-facade.ts:71-76` declares `AgentGitFacade`; `branch?: string` at `:38`.
- `packages/agent/src/agents/agent-tool.service.ts:1276-1280` advertises `branch` in the tool schema and forwards
  it at `:1305` — **but the adapter never uses it**: `apps/api/src/agents/agents.module.ts:686-689` commits with
  `git.commit(providerId, dir, message, …)` (no branch) and `:690-691` pushes with no refspec; `:700` merely
  **echoes** `branch: branch ?? 'main'` back to the caller. So an agent that names a branch is told it committed
  there and did not.
- `apps/api/src/agents/agents.module.ts:730-739` opens pull requests with `owner: ''`, `repo: ''` — nothing
  re-derives them, and `packages/plugins/github/src/github-api.service.ts:638-646` sends them straight to
  `octokit.rest.pulls.create`.
- `:685` and `:706` hard-code `providerId = 'github'`; `:626-630` passes `providerId: ''`, which survives
  `?? work.gitProvider` (`packages/agent/src/facades/git.facade.ts:1515`) and makes `getPluginSync('')` fall back
  to "first loaded git plugin" (`:1583-1594`).
- `packages/plugin/src/git/git-operations.ts:306-308` keys the checkout directory on
  `slugifyText(\`${owner}-${repo}\`)`— case-folded, hyphen-ambiguous, **no provider component**; and`:113-125`**silently`git init`s an empty repository** when a clone fails with `NotFoundError` or "empty".
- The workspace provider has a _second_, different key: pool = `repoKey(spec.repoUrl)` and worktree =
  `sanitizeSegment(spec.bindingKey)` where `bindingKey` is the **bare Task id**
  (`packages/plugins/local-workspace/src/local-workspace.plugin.ts:232-233`, `:1580-1586`;
  `packages/agent/src/tasks-domain/task-workspace.service.ts:249`).

## 2. What genuinely blocks Wave 1

Three things. Nothing else on the 66-item list stops Wave 1 code from starting.

### Blocker 1 — the App Work's repository role is self-contradictory (a real decision)

`APW-01-app-work-kind/plan.md:262` writes the new `app` capability set as
`repos: { data: true, work: false, website: false }` and `:222` records the fork under
`relatedRepositories: { data: { owner, repo } }` — while `README.md:89-91` and `CONTRACTS.md:224-231` (both
edited on 2026-09-17) say the app-code repository is the **Work Repository, the `website` role, never `data`**.

It cannot be flipped on its own. Verified: `packages/agent/src/entities/work.entity.ts:831` is
`getRepoOwner(type: RepositoryRole = 'data')` — **`data` is the default** — and APW-08's own plan says the
repo-kind precedent writes under `data` _"which is what `TaskWorkspaceService.provisionForRun` clones"_
(`APW-08-evolve-loop/plan.md:28`), and that `EXISTING-SUBSTRATE.md` records `taskIsolationTargetRepo` as
_"declared but not consumed"_ with `task-workspace.service.ts:219-220` hard-coding `getRepoOwner()` /
`getDataRepo()`.

**Why it blocks:** APW-01 P1.1 (contracts) and P1.3 (services) cannot be written until the role is fixed, and
APW-05, APW-06 and APW-08 all read the same repository through the same accessors. This is the first PR of the
Wave 1 creation lane (`implementation-plan.md:75`).

**Decision needed (one sentence):** does an App Work's app-code fork occupy the persisted **`data`** role (keep
the plan's mechanics, re-word the vocabulary note — the smallest change) or the **`website`** role (teach five
call sites the App-Work case)? Full analysis at `decision-sheet.md` **C-09** and `contradictions.md` **C-1**.

### Blocker 2 — the owner actions Wave 1 cannot finish without

Two of these are repository/estate creation; neither is a design question, and neither can be done by an agent
acting alone (org ownership and a machine user are involved).

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                       | Why it blocks                                                                                                                                     | Source                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 2a  | Create the catalog + template repositories: `ever-works/apps` (machine Apps catalog + `licenses.yml` + `schema/`), `ever-works/{cal-diy,umami,app-fixture-hello}-template`, `ever-works/app-fixture-hello` (the fixture's **source**, a different repo from its `-template`), plus `ever-works/agents`, `ever-works/skills`, `ever-works/missions`, `ever-works/platforms`                                                   | **APW-03 P1** (the whole catalog + licence gate) and **APW-13 P1** (fixtures, Blueprints)                                                         | `implementation-plan.md:47`; `CONTRACTS.md:430-437`; `TRACKER.md:16-17`                                               |
| 2b  | Create the GitHub test estate: `<e2e-upstream-org>`, `<e2e-fork-org>`, the `<e2e-user>` machine user (read-only on the upstream org), the test cluster(s), the canary sink, the test DNS zone, the dedicated model-spend budget, and the `app-works-dev` / `app-works-stage` environments with the secrets and variables of `ACCEPTANCE.md` §0.4; plus one person-created fork each of Umami and Cal.diy in `<e2e-fork-org>` | **APW-13's nightly and golden-path lanes** — which are the **Wave 1 exit gate** (`implementation-plan.md:82-84`), and the `Test` lines of T20/T21 | `APW-13-golden-paths/tasks.md:221-237`; `ACCEPTANCE.md:80-123`; `implementation-plan.md:48`; `decision-sheet.md` J-08 |

> **On `ever-works/templates`:** `implementation-plan.md:47` now records the owner's answer that the _human
> listing repo_ is `ever-works/templates`. **I could not find that repository, or any reference to it, in the
> code or in any App Works doc.** The suffix scan the owner describes **is** shipped — but it scans the whole
> `ever-works` org for `*template` repos (`packages/agent/src/template-catalog/template-catalog.service.ts:1047-1049`
> with `packages/agent/src/config/index.ts:885-887`), and the machine catalog is read from `ever-works/apps`
> (`CONTRACTS.md:401`). **Confirm what `ever-works/templates` is before creating it** — see
> `contradictions.md` E-2. It does not block Wave 0 or the Wave 1 lanes.

### Blocker 3 — the Wave 1 parallel lane has a declared circular dependency

`APW-06-app-runtime/spec.md:14` depends on APW-07 and `APW-07-app-env-and-dependencies/spec.md:13-14` depends on
APW-06, yet `implementation-plan.md:74` puts **both** in Wave 1's first parallel step. `TRACKER.md:38-44` records
this and recommends the fix — _"APW-07 owns the env/dependency contracts and lands first; APW-06 consumes them …
APW-07's stated dependency on APW-06 becomes a dependency on APW-06's ports/interfaces only"_. **Apply that
one-line softening to `APW-07/spec.md:13-14` and the lane runs.** Not an owner decision; an editor's five-minute
job.

## 3. What can proceed in parallel, starting now

| Lane                                                              | Can start                                                                              | Why it is unblocked                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wave 0 · PR 0.1** — agent git tools                             | **today**                                                                              | No open item touches it; failing-test-first proof named                                                                                                                      |
| **Wave 0 · PR 0.2** — checkout keys, fork readiness               | **today**                                                                              | Same                                                                                                                                                                         |
| **APW-03 P1** App spec schema + validator + `WorkAppSpecState`    | after 2a (needs `ever-works/apps` to read; the schema itself can be written before it) | Its three §9 items are all resolvable from the plan's own defaults — `decision-sheet.md` D-01…D-03, all "plan already implies"                                               |
| **APW-02 P1** fork lifecycle + `WorkUpstreamState` + Upstream tab | **today**                                                                              | All three §9 items are plan-implied (C-05, C-06, C-07)                                                                                                                       |
| **APW-07 P1** env store + in-cluster dependency providers         | **today**                                                                              | All six §9 items plan-implied (B-12…B-17); the Postgres half reuses a shipped provisioner (`packages/agent/src/ever-works-providers/ever-works-db-provision.service.ts:101`) |
| **APW-11 P1** App Launcher inside Ever Works                      | **today**                                                                              | All six §9 items plan-implied (I-01…I-06); reads the already-shipped `ever-works/works` catalog pattern                                                                      |
| **APW-01 P1**                                                     | **after Blocker 1**                                                                    | C-09 decides the contract                                                                                                                                                    |
| **APW-05 P1 → APW-06 P1 → APW-04 P1**                             | after Blocker 1 and the APW-06↔APW-07 softening                                        | —                                                                                                                                                                            |
| **Wave 2 work (APW-10 P1, APW-12 P0–P1)**                         | after §4 items 1 and 3                                                                 | APW-12's decisions are ready to be written down the moment the owner confirms `auth.ever.co`                                                                                 |
| **Owner actions (2a, 2b) and filing the Jira tickets**            | **today, in parallel with 0.1/0.2**                                                    | They are the longest-lead items in the program; the tickets are drafted and waiting                                                                                          |

## 4. The three things the owner must approve first

**1 · The isolation claim is re-scoped per deploy shape — nothing is deleted, and the scope EXPANDS.**
_(Revised 2026-09-17 after the owner's follow-up, which was unambiguous: "I don't know why this again and again
cause issues, please do full review etc. We do NOT change anything here or remove, we may EXPAND only!" The first
draft of this section proposed **replacing** LG-01/LG-03/LG-16's wording; that proposal is **void**, because it
framed a family of deploy shapes as a conflict.)_ The platform already deploys to more than one place and the plan
had been written as though it did not: the **Ever Works shared customer cluster** (`k8s-works-shared`), the
**internal admin cluster** (`k8s-works`), a **customer kubeconfig** (`custom-kubeconfig`), the **Vercel** plugin
(`deployment` capability), plus **Fleet agent enrollment** — which is exactly the "install and connect Agents on
such other machines" path the owner named, and which is already shipped substrate
(`packages/contracts/src/fleet/fleet-node.types.ts:45-51,432-446`). So: **LG-01, LG-03 and LG-16 stay as gate items
and each gains a per-shape attestation** (namespace + quota + LimitRange + NetworkPolicy + dedicated egress
identity + a distinct ingress for the shared zone; the equivalent properties attested for a connected node or a
customer cluster), and the shapes are written down in full — shipped versus extension point, honestly labelled —
in [`APW-06-app-runtime/deploy-shapes.md`](../../APW-06-app-runtime/deploy-shapes.md), now Resolution **R-27**. An
item a shape genuinely cannot satisfy is recorded **`Failed` with its reason**, which the gate board already
supports — never marked "not applicable". This also settles APW-12's D3, which needs the same namespace +
network-policy separation rather than separate hardware. Full row: `decision-sheet.md` **B-01** (now `PLAN`).

**2 · The Public Suffix List apex is KEPT; the platform domain becomes the default — additive, nothing deleted.**
_(Revised 2026-09-17 after the owner's follow-up: "please don't remove anything, just make sure we support
sub-domains / custom domains etc etc." The first draft of this section proposed deleting the PSL path and its
probes; that proposal is **void** and is left below only as the record of why the reconciliation was needed.)_
Three shapes now coexist and all three ship: **(a)** `<slug>.<EVER_WORKS_APPS_DOMAIN>`, which **defaults to
`EVER_WORKS_DOMAIN`**, so a template install simply works as `my-cool-company-gauzy.ever.works`; **(b)** the
tenant's custom domain and per-App-Work subdomains under it, through the shipped add/verify flow; **(c)** the
original dedicated apex — outside every platform domain and **listed on the Public Suffix List** — still
operator-selectable, still the only shape giving hard cookie isolation, with **LG-15 and its
`APEX_UNDER_PLATFORM_DOMAIN` / `APEX_NOT_ON_PSL` / `PSL_UNREACHABLE` probes intact** and simply not exercised unless
an operator configures such an apex. Where shape (a) is used, the compensating control is **mandatory**: host-only
`__Host-`-prefixed `Secure` session cookies on dashboard and app hosts, no platform session cookie on app hosts,
and app hosts that never serve platform pages. Note the PSL itself remains consumed by nothing in the platform
today (`packages/contracts/src/release/deployment-verification.types.ts:243-253`) — which is precisely why keeping
the check costs nothing until someone configures the dedicated apex. Full row: `decision-sheet.md` **B-02**;
landed across D10, R-16, ACC-06-27, ACC-13-20, APW-06 S33/FR-40/FR-41/ACC-06-47, APW-10 LG-15 + its board row and
open question, APW-13 FR-52/ACC-13-20 + plan §8.4 + T34/T60, README Q2 and the env table.

**3 · Fix the App Work repository role, then the Wave 1 lane opens.**
One sentence: for an App Work, does the app-code fork occupy the persisted **`data`** role (recommended — it is
what `GitFacadeService.getRepoDir` clones and what every Task path resolves, and the `-website`/`-app` suffix the
owner approved is a _name_, not a role — `packages/agent/src/entities/work.entity.ts:831`, `:815-824`) or the
**`website`** role (which needs five call sites taught the App-Work case)? This is Blocker 1 above. Full row:
`decision-sheet.md` **C-09**.

**Also worth approving in the same pass, because they are cheap and they unblock long-lead work:** the owner
actions in §2 (Blocker 2 — create the repositories and the test estate; they have the longest lead time of
anything in the program), filing the Jira epic + 13 stories (`decision-sheet.md` K-01, drafts in
`jira-tickets.md`), and writing `auth.ever.co` into the four places that still call the Ever ID domain open
(`contradictions.md` E-3).

## 5. What is _not_ blocking, despite looking like it

- **The `[NEEDS CLARIFICATION]` items themselves.** I read every epic's §9 rather than trusting the count, and
  the count was exactly right at the time — **66**, in the per-epic split given (APW-01 4, APW-02 3, APW-03 3,
  APW-04 5, APW-05 6, APW-06 5, APW-07 6, APW-08 5, APW-09 4, APW-10 6, APW-11 6, APW-12 6, APW-13 7).
  **Since the owner's 2026-09-17 answers the epic count is 65** — APW-10's "which apex domain?" is answered in
  place and now reads `[ANSWERED 2026-09-17 — which apex domain?]` — and the other five APW-10 items are
  untouched. **Fifty-six of them already carry a `_Default:_` that the plan and the code both support** — they
  are write-downs, not decisions (`decision-sheet.md` §0). Three of the remaining nine are owner _actions_, not
  choices.
- **APW-12's Ever ID.** The provider is decided and the integration constraints are written down
  (`idp-options.md` §6–§7). Only the **domain** was missing, and the owner has now given it. Nothing in Wave 0 or
  Wave 1 depends on Ever ID (it is Wave 2, `TRACKER.md:25`).
- **APW-10's prices** (`decision-sheet.md` B-03). No Wave 1 or Wave 2 code needs a number; only the Admin board's
  copy does. Decide it before the tier opens to users, not before Wave 1.
- **The Blueprints' "Unverified" lists** (`blueprints/cal-diy/README.md:51-60`, `blueprints/umami/README.md:39-47`).
  Thirteen items, every one a _measurement to take on the first verification run_, not a decision
  (`decision-sheet.md` J-10). **There is exactly one literal `TODO(verify)` marker in the whole program** —
  `APW-13-golden-paths/plan.md:311` (`TODO(verify, APW-06)`, the Umami smoke-with-a-body item) — not "several".
- **The request-body smoke question.** Already settled by reading the code: the only post-deploy checks that
  exist are GET-only — `apps/node/src/core/executors/browser-check.ts:219` navigates and dumps the DOM
  (payload `{url, headed?, expectText?, timeoutSec?}`, `packages/contracts/src/fleet/fleet-jobs.types.ts:1460`),
  and the Work health poll is a GET `/api/health` (`packages/agent/src/services/deploy-ready-poller.service.ts:23,116`).
  Adding bodies is new capability; the verification lane asserting it itself is the smallest consistent thing
  (`decision-sheet.md` J-06, J-09).
- **The managed tier's existence.** It is **100% new**: `AppsTierPolicy`, an `apps-tier` capability, an
  `ever-works-apps` plugin, `EVER_WORKS_APPS_MANAGED_ENABLED` and the `Work` CRD have **zero matches** under
  `apps/` or `packages/` — they live only in the specs. That is expected (Wave 2), but it means "we already have
  most of it" is false for the tier, and true for the deploy substrate it will sit on
  (`packages/plugins/k8s/src/k8s.plugin.ts:673` applies namespace/secret/Deployment/Service/Ingress;
  `packages/plugins/k8s/src/types.ts:83` already has the three cluster sources).

## 6. Start order, in one line

**Today:** Wave 0 PR 0.1 and PR 0.2 · owner creates the repositories and the test estate · file the Jira epic and
13 stories.
**On the owner's three approvals:** the four Wave 1 foundations lanes (APW-03, APW-02, APW-07, APW-11 P1), with
the APW-06↔APW-07 dependency softened.
**Then:** APW-01 P1 → APW-05 P1 → APW-06 P1 → APW-04 P1 → APW-08 P1 → APW-13 P1, which is the point at which the
owner's Cal.diy example runs end to end on a user cluster.
