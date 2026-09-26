# App Works — contradictions between the owner's 2026-09-17 answers and text still in the plan

**Status:** analysis only. **No existing file was modified** — every fix below is proposed, not applied.
**Prepared:** 2026-09-17 in the `plan/any-repo-as-work` worktree.

**How to read this.** Each entry quotes the **stale sentence verbatim** and gives the mechanical fix. Fixes are
supposed to be find-and-replace, not re-design: where a fix would change meaning, it says so and points at the
matching row of `decision-sheet.md`.

> ⚠️ **Moving target.** Another agent was writing the owner's answers into `README.md`, `CONTRACTS.md`,
> `TRACKER.md`, `ACCEPTANCE.md`, `EXISTING-SUBSTRATE.md`, the implementation plan and eleven epic files while
> this file was being written (`git diff --stat` showed 22 dirty files under `docs/` at the time of writing; no
> `apps/**` or `packages/**` source file was dirty). **Every line number below was read from the working tree at
> that moment.** Re-grep the quoted sentence before editing — the quote is the anchor, the number is a hint.
> Entries already fixed by that concurrent pass are marked ✅ **FIXED WHILE WRITING**.

---

## A. Owner answer 1 — "no separate PSL-listed user-apps domain"

> **⚠️ SUPERSEDED 2026-09-17 (later the same day) — read [`../../BUILD-READINESS.md`](../../BUILD-READINESS.md) §2/§6 and
> `README.md` D10 before acting on anything below.** The owner's follow-up was explicit: _"please don't remove
> anything, just make sure we support sub-domains / custom domains etc etc"_ — so this entry is **history, not
> instruction**. What actually landed is the **additive** reconciliation: managed addresses **default** to the
> platform's own domain (`my-cool-company-gauzy.ever.works`), the tenant's custom domain and its subdomains work
> through the shipped add/verify flow, and **the dedicated Public-Suffix-List apex stays a supported operator
> configuration with LG-15 and its `APEX_UNDER_PLATFORM_DOMAIN` / `APEX_NOT_ON_PSL` / `PSL_UNREACHABLE` probes
> intact** — kept, never marked "not applicable". Everything below that proposes _dropping_ the PSL apex, deleting
> those probes, or rewriting LG-15 to a single installation domain is **void**. The text is kept because the
> evidence it gathered (what consumes the PSL today, which code paths already ship) is still accurate.

**Owner's answer:** _"No separate PSL-listed user-apps domain: use the existing subdomain mechanism
(`my-app.ever.works`) or a tenant custom domain with per-app subdomains."_

This one answer contradicts **eight** locations. The mechanism the owner is pointing at is real and shipped —
`EVER_WORKS_DOMAIN?.trim() || 'ever.works'` (`apps/api/src/plugins-capabilities/deploy/managed-subdomain.service.ts:298`),
`SubdomainAllocator` (`packages/agent/src/ever-works-providers/subdomain-allocator.service.ts:102`), the
`works.managedSubdomain` column (`packages/agent/src/entities/work.entity.ts:768`) and the Cloudflare plugin's
"managed `*.ever.works` subdomains" (`packages/plugins/cloudflare-dns/src/cloudflare-dns.plugin.ts:89`). What is
stale is every sentence that assumes a **new PSL-listed apex**.

### A-1 · Program D10 — the cookie-isolation premise

- **Location:** `docs/specs/features/app-works/README.md:176-178`
- **Stale sentence:** _"**D10 — User apps never share a parent domain with the platform.** Managed subdomains for
  App Works live under a dedicated user-apps apex domain that is listed on the Public Suffix List (cookie
  isolation). Custom domains reuse the existing add/verify flow."_
- **Why it contradicts:** `ever.works` **is** the platform's parent domain, and no PSL entry is planned. The
  cookie-isolation premise D10 was written to secure therefore disappears with the answer.
- **Mechanical fix:** re-state D10 as _"**D10 — user apps are served on the installation's managed-subdomain
  mechanism (`<slug>.ever.works`) or a tenant custom domain with per-app subdomains. No separate user-apps apex
  is registered and no Public Suffix List submission is made.**"_ Then **add one new sentence** recording the
  consequence the owner accepted: subdomains under a shared registrable domain share cookies, so the platform
  must set `__Host-`-prefixed, host-only, `Secure` session cookies on both the dashboard and app hosts, and must
  not read a cookie set by an app host. (This is a **new** requirement created by the answer — flag it to the
  owner rather than inventing the control silently; it is `decision-sheet.md` B-02.)
- **Also appears in:** `README.md:251` (Wave 2 row: "managed subdomains on the user-apps domain"),
  `README.md:336-337` (§8 Q2), `implementation-plan.md:49` (already marked answered — confirm its wording),
  `CONTRACTS.md:59` (R-16), `CONTRACTS.md:405` (`EVER_WORKS_APPS_DOMAIN` default "unset (placeholder
  `<apps-domain>`)").

**Verified against code (so the fix can be specific):** `packages/contracts/src/release/deployment-verification.types.ts:243-253`
states the package _"has no dependencies and will not carry a PSL"_, and no `user-apps` / `USER_APPS` /
`apexDomain` symbol exists anywhere under `apps/` or `packages/`. **Nothing in the platform consumes the PSL**,
so LG-15's PSL check is the only thing in the program that would ever have needed one.

### A-2 · APW-10 launch-gate item LG-15

- **Location:** `docs/specs/features/app-works/APW-10-apps-hosting-tier/spec.md:197`
- **Stale sentence:** _"| LG-15 | User-apps domain | Both | P2 | Managed addresses use a dedicated apex that is
  not under any platform domain and is present on the Public Suffix List. |"_
- **Mechanical fix:** _"Managed addresses use the installation's configured user-apps domain
  (`EVER_WORKS_APPS_DOMAIN`, the same mechanism Works use today) and are not served under another Ever product's
  domain."_ — and **drop the two probe codes that depend on the PSL**: `APEX_NOT_ON_PSL` and `PSL_UNREACHABLE`
  (`APW-10-apps-hosting-tier/plan.md:390`, where the row reads _"`appsDomain` not equal to or under any platform
  domain; PSL fetched (8 s timeout) contains the apex"_). `APEX_UNDER_PLATFORM_DOMAIN` also needs re-wording,
  since `ever.works` **is** a platform domain and is now the intended target. Also update the LG-15 row of the
  gate board example at `spec.md:455` (_"LG-15│ User-apps domain │ Inconclusive │ PSL_UNREACHABLE"_) and the
  task that probes it (`APW-10-apps-hosting-tier/tasks.md:264`: _"LG-15 PSL fetch 8 s"_).

### A-3 · APW-10 FR-33 and ACC-10-31

- **Location:** `APW-10-apps-hosting-tier/spec.md:321-322`
- **Stale sentence:** _"**FR-33.** Managed addresses live under a dedicated user-apps apex (program D10) served
  by the tier's own edge with a wildcard certificate. No App Work is ever served under a platform domain."_
- **Mechanical fix:** keep the edge + wildcard-certificate requirement (LG-16 depends on it), replace the first
  sentence's "dedicated user-apps apex (program D10)" with "the installation's configured user-apps domain
  (program D10 as re-stated)", and replace the second with "No App Work is ever served under **another Ever
  product's** domain."
- **Also:** `APW-10-apps-hosting-tier/spec.md:564` (ACC-10-31: _"An App Work's managed address is under the
  user-apps apex"_) and `spec.md:113` (S4: _"gets an address under the user-apps domain"_).

### A-4 · APW-06 and APW-13's `<apps-domain>` placeholder, ACC-06-27

- **Location:** `ACCEPTANCE.md:924`
- **Stale sentence:** _"| ACC-06-27 | Managed subdomain never under the platform domain; misconfigured apps
  domain disables it |"_
- **Mechanical fix:** _"Managed subdomain never under another Ever product's domain; misconfigured apps domain
  disables it"_. The same substitution applies to **ACC-13-20** (`ACCEPTANCE.md:1263`: _"never an address under
  the platform's own parent domain"_) and to `APW-06-app-runtime/spec.md:219-222`, `:400` and `:463`, which all
  say `<slug>.<apps-domain>` — the placeholder is fine, but `CONTRACTS.md:405` should record its default as
  `EVER_WORKS_DOMAIN` (`ever.works`) rather than "unset".

> ✅ **Partly fixed while writing:** `implementation-plan.md:49` now reads _"~~User-apps apex domain (Public
> Suffix List submission takes weeks)~~ — **answered (owner, 2026-09-17): no new apex.** … D10's cookie-isolation
> premise must be re-stated, not silently kept"_ — that is the correct instruction; A-1 is the file it applies to.

---

## B. Owner answer 2 — the managed tier runs "like Works today", not on rented isolated capacity

**Owner's answer:** _"run like Works today — our own shared k8s with namespaces/isolation, **plus connected
customer nodes** and customer k8s clusters. Not 'rented isolated capacity only'."_

This is the **highest-risk** contradiction in the program, because APW-10's whole value proposition is a gate
that proves isolation. Four locations still assert physically separate infrastructure.

### B-1 · Program D15 — "own hosts/network/egress identity"

- **Location:** `docs/specs/features/app-works/README.md:209-213`
- **Stale sentence:** _"Before **Ever Works Apps** accepts any App Work, APW-10's launch gate must pass: an
  isolated tier (**own hosts/network/egress identity**), sandboxed runtime, restricted pod security, default-deny
  networking, quotas, a namespace per App Work, no platform-wide credentials in tenant pods, abuse controls and a
  tested per-App-Work quarantine (R-20)."_
- **Why it contradicts:** "own hosts" cannot be true if the zone is namespaces on the shared cluster. Note that
  _"a namespace per App Work"_ in the same sentence is **independently stale** — see D-2 below.
- **Mechanical fix:** _"an isolated zone (**dedicated namespaces on Kubernetes infrastructure Ever Works
  operates, plus optionally connected customer nodes and customer-owned clusters**), sandboxed runtime,
  restricted pod security, default-deny networking, quotas, a namespace per App Work, no platform-wide
  credentials in tenant pods, abuse controls and a tested per-App-Work quarantine (R-20)."_

### B-2 · The three gate items that assert separate infrastructure

- **Locations and stale sentences:** `APW-10-apps-hosting-tier/spec.md:183` — _"| LG-01 | Dedicated capacity |
  Attested | P2 | Tier compute hosts nothing belonging to the platform or to any production product. |"_;
  `spec.md:185` — _"| LG-03 | Separate egress identity | Both | P2 | The public address a tenant's outbound
  traffic presents is not one used by the platform or a production product. |"_; `spec.md:198` — _"| LG-16 |
  Separate edge | Both | P2 | A canary address under the apex serves HTTPS with a valid wildcard certificate
  through the tier's own edge; a separate edge account is attested. |"_
- **Why it contradicts:** these are **Attested**/**Both** items an operator must personally sign, and on a shared
  cluster LG-01 as written is unattainable.
- **Mechanical fix — needs the owner's explicit yes, do not apply silently.** The program's isolation claim has
  to be re-stated to something checkable on shared-but-isolated infrastructure, e.g. LG-01 → _"The tier's zone
  runs in namespaces that host no platform or production workload; the zone's node pool, ResourceQuota,
  LimitRange and NetworkPolicy objects are enforced and drift-checked."_; LG-03 → _"Tenant egress presents an
  address not used by the platform or a production product (a dedicated NAT egress identity)."_; LG-16 → _"The
  tier's ingress is a distinct ingress controller/namespace serving the tier's wildcard certificate, separate
  from the platform's."_ This is `decision-sheet.md` **B-01** — the single most consequential row in the sheet.
- **Also:** `implementation-plan.md:90` (_"isolated zone, sandboxed runtime, tenant data servers, edge"_ is fine,
  but the surrounding sentence should stop implying separate hosts) and the `implementation-plan.md:106-108` rule
  _"the managed Apps tier must not share hosts, network, data servers or edge with it (APW-10 launch gate)"_ —
  "hosts … network … edge" must become "namespaces, quotas, network policy, node pool and ingress".

### B-3 · APW-10 §9's own default

- **Location:** `APW-10-apps-hosting-tier/spec.md:618-619`
- **Stale sentence:** _"**[NEEDS CLARIFICATION: where does the tier run?]** README open question 1. *Default:
  rented dedicated capacity for the untrusted tier; the decision and its trade-offs are in the private
  operations plan.*"_
- **Mechanical fix:** replace the `_Default:_` with the owner's answer verbatim and drop the `NEEDS
CLARIFICATION:` marker. (See `decision-sheet.md` B-01.)

> ✅ **Partly fixed while writing:** `implementation-plan.md:50` now reads _"answered (owner, 2026-09-17): the
> same way Works run today — our own shared k8s with namespace-level isolation, **plus connected customer
> nodes** and customer k8s clusters"_. `README.md:332-335` (§8 Q1) still carries the old default text.

### B-4 · "Connected customer nodes" appears nowhere in the plan

- **Location:** the whole of `docs/specs/features/app-works/` and `docs/internal/app-works-implementation-plan.md`.
- **Stated:** the owner's answer names **connected customer nodes** as a capacity source for the tier.
- **Found:** **zero** occurrences of "customer nodes", "connected customer" or a node-join mechanism anywhere in
  the program docs, in `APW-10`'s gate items or in the code. (The only related surface is the _reverse_
  direction — a customer's own cluster, `custom-kubeconfig`, `packages/plugins/k8s/src/types.ts:83`.)
- **Mechanical fix:** add one sentence to `README.md` D15 and one row to APW-10's §2.4 diagram naming connected
  customer nodes as an optional capacity source, **and either** add a gate item covering node-level trust
  (a customer node is untrusted hardware sitting inside the zone's network) **or** record explicitly that
  connected nodes join only the _build/serving_ pool and never the zone's control plane. Not adding a gate item
  leaves an unexamined trust boundary. **Do not build a node-join feature from this answer alone** — see
  `contradictions.md` E-1.

---

## C. Owner answer 3 — the repository roles

**Owner's answer (paraphrased):** the app code lives in the **Work Repository** — persisted role `website`, UI
label "Work Repository", optional `-app` or `-website` suffix, **suffix only, no new persisted role**.

✅ The vocabulary half was already applied while this file was written (`README.md:78-97`, `CONTRACTS.md:224-231`,
`implementation-plan.md:79`). **The half that was not applied is the one that matters.**

### C-1 · APW-01 still writes the app-code fork into the `data` role

- **Locations and stale sentences:**
    - `APW-01-app-work-kind/plan.md:262` — _"`repos: { data: true, work: false, website: false }`,"_ (the `app` entry
      of `WORK_KIND_CAPABILITIES`)
    - `APW-01-app-work-kind/plan.md:222` — _"`relatedRepositories: { data: { owner, repo } }` … **top-level
      `owner`/`repo` = the data repository**, because `GitFacadeService.getRepoDir` clones the top-level pair"_
- **Why it contradicts the owner's answer:** if the app-code fork is the Work Repository, `app`'s capability set
  should say `website: true`, and the fork should be recorded under `website`.
- **Why it cannot simply be flipped — verified in code:**
    - `packages/agent/src/entities/work.entity.ts:831` — `getRepoOwner(type: RepositoryRole = 'data')`: **the
      default is `data`.**
    - `packages/agent/src/entities/work.entity.ts:815-824` — `getDataRepo()` / `getWebsiteRepo()` / `getMainRepo()`.
    - `APW-08-evolve-loop/plan.md:28` — `applyRepositoryWorkSource` _"Writes the repository under
      `relatedRepositories.data` 'which is what `TaskWorkspaceService.provisionForRun` clones'."_
    - `APW-08-evolve-loop/plan.md:70` — _"`getRepoDir` clones `work.sourceRepository.owner/repo` — the **import
      source** for imported Works, absent for template Works — not `relatedRepositories.data`, which every Task
      path uses."_
    - `EXISTING-SUBSTRATE.md` — `taskIsolationTargetRepo` _"is **declared but not consumed**"_ and
      `task-workspace.service.ts:219-220` hard-codes `work.getRepoOwner()` / `work.getDataRepo()`.
- **Mechanical fix — pick one, then make the docs say it:**
    - **(a) preferred, smallest:** keep the plan's mechanics — the App Work's app-code fork is persisted under the
      **`data`** role — and re-word the README/CONTRACTS vocabulary note to say the Work Repository is the
      **UI name** for an App Work's app-code repository, which is persisted under `data` for compatibility with
      every existing Task/clone path, and carries the `-website` / `-app` **name** suffix. Change
      `README.md:89-91` and `CONTRACTS.md:224-231` accordingly.
    - **(b)** write it under `website` and add a task (APW-01 P1.3) that teaches `getRepoOwner`, `getDataRepo`,
      `GitFacadeService.getRepoDir` and `TaskWorkspaceService` the App-Work case — five call sites plus the
      `repo`-kind guard's assumptions.
      This is `decision-sheet.md` **C-09**. It is the one contradiction that **blocks Wave 1 code today**.

### C-2 · "Top-level `owner`/`repo` = the data repository" survives in CONTRACTS

- **Location:** `CONTRACTS.md:237` (the `Added by APW-01:` row of §2)
- ✅ **FIXED WHILE WRITING** — it now reads *"top-level `sourceRepository.owner/repo` = **the Work Repository**
  (`website` role … *not* the `data` role, which holds the Work's data)"*. **But this is now contradicted by its
  own sibling `APW-01/plan.md:222`**, which still says the opposite. Fix C-1 before anyone reads `CONTRACTS.md`
  §2 alone.
- Two neighbouring sentences still say "data repository" and were **not** fixed: `CONTRACTS.md:236` (_"how the
  data repository relates to the upstream"_) and `CONTRACTS.md:84` (_"`source: # required — written by APW-01 at
  creation"_ is fine, but `:87` now reads "Work Repository branch" — consistent). Audit the remaining
  pre-2026-09-17 occurrences mechanically: `grep -rn "data repository" docs/specs/features/app-works/`.

---

## D. Contradictions found in the plan/code itself (not caused by the owner's answers)

These are not owner decisions. They are build-order facts that must be written down before Wave 1 starts.

### D-1 · APW-09's wave: README says Wave 2, its own spec and the tracker say Wave 1

- **Locations:** `README.md:251` places APW-09 P2 in Wave 2 and **omits APW-09 from Wave 1**
  (`README.md:250` lists "APW-01…08 P1, APW-11 P1, APW-13 P1"); `README.md:274` gives "M · Dep: APW-02, 08".
  Against that, `APW-09-upstream-pull-requests/spec.md:7` reads _"**Program**: [App Works](../../README.md) — Wave 1
  (P1 foundations), Wave 2 (P2–P3)"_.
- ✅ **FIXED WHILE WRITING in the tracker:** `TRACKER.md:31-32` now lists _"**APW-09 P1** (its own spec and
  ACCEPTANCE both place APW-09 P1 in Wave 1; this row previously omitted it — see the note below)"_.
- **Remaining mechanical fix:** add APW-09 P1 to `README.md:250`'s Wave 1 epic list and to its "Epics (phase)"
  column, and update the Wave column of `TRACKER.md:22` from `2` to `1 · 2`.

### D-2 · "One namespace per App Work" is not what the platform does today

- **Locations:** `APW-10-apps-hosting-tier/spec.md:192` (LG-10 — _"Two App Works get two namespaces; nothing a
  request contains can choose or reuse a namespace."_), `spec.md:86` (§2.4 diagram — _"namespace per App Work"_),
  and `README.md:211-212` (D15 — _"a namespace per App Work"_).
- **What the code does instead — verified:** `packages/agent/src/facades/deployment-context.resolver.ts:244-248`
  namespaces by **tenant**, not by Work: `namespace = buildEverWorksTenantNamespace(tenantId, base)` with
  `tenantId = ownerUserId || workId` and `base = EVER_WORKS_DEPLOY_NAMESPACE || 'ever-works-tenants'` →
  `ever-works-tenants-<userId>`; the helper is `packages/agent/src/ever-works-providers/ever-works-k8s-deploy.provider.ts:164`.
  The internal `k8s-works` path namespaces by **slug** (`:259-268` → `ever-works-<slug>-prod`).
- **Mechanical fix:** keep LG-10 as the requirement (APW-10's zone controller is new and can namespace per App
  Work), but add a sentence to `APW-10`'s §2.2 "What exists today" and to `EXISTING-SUBSTRATE.md` recording that
  **today's platform-managed deploys are namespace-per-tenant**, so APW-10's per-App-Work namespace is new work,
  not a reuse — and so nobody wires the tier onto `buildEverWorksTenantNamespace`. `ACC-06-45`'s "removes every
  workload … within 300 s" depends on the per-App-Work boundary being real.

### D-3 · APW-09 §9 still asks a question its own binding resolution already answered

- **Location:** `APW-09-upstream-pull-requests/spec.md:515-516`
- **Stale sentence:** _"**[NEEDS CLARIFICATION: Upstream tab ownership.]** APW-02 shows sync status and APW-09
  the pull requests. One tab, two sections — whichever epic ships first creates the tab."_
- **Why it contradicts:** Resolution R-8 is binding and already decides it — `CONTRACTS.md:51`: _"One route
  `/works/:id/upstream`. APW-02 creates the tab … APW-09 adds the 'Upstream pull requests' section to it."_
- **Mechanical fix:** strike the bullet (or prefix it `**Resolved (Resolution R-8):**`), exactly as the epic
  already does for its other resolved bullets.

### D-4 · APW-12's cross-repository paths read as if they were local paths

- **Locations:** `APW-12-ever-id/cross-platform.md` and `idp-options.md` throughout — e.g. `idp-options.md` §7.1
  names `packages/auth/src/lib/keycloak/{keycloak.strategy.ts,keycloak-auth-guard.ts}`,
  `packages/contracts/src/lib/feature.model.ts`, `packages/common/src/lib/guards/feature-flag-enabled.guard.ts`,
  and the plan names `apps/api/src/plugins.ts`, `apps/api/src/plugin.config.ts` and
  `PluginMetadata extends ModuleMetadata`.
- **Why it matters — verified:** **none of those paths exist in this repository.** `packages/common/` does not
  exist; `packages/contracts/src/lib/` does not exist; there is no `apps/api/src/plugins.ts`, no
  `plugin.config.ts`, and no `PluginMetadata` symbol anywhere; no `featureEnabled()` symbol anywhere. They are
  **`ever-co/ever-gauzy`** paths. This repository's plugin packages are `@ever-works/<name>-plugin`, discovered
  from a filesystem path list (`packages/agent/src/plugins/plugins.constants.ts:14-21`), its auth is Better Auth
  (`apps/api/src/auth/providers/auth-runtime.instance.ts:1,335`), and its fail-open flag helpers are
  `config.features.zeroFrictionOnboarding()` (`apps/api/src/config/constants.ts:403-404`) and
  `config.fleet.isEnabled()` (`packages/agent/src/config/index.ts:549`).
- **Mechanical fix:** prefix every Gauzy path in those two files with `ever-co/ever-gauzy:` (the file header
  already says _"Paths in other repositories are relative to that repository's root"_ —
  `APW-12-ever-id/tasks.md:18-20` — but the mid-document paths still read as local). A reader who greps
  `apps/api/src/plugins.ts` in this repo finds nothing and concludes the spec is wrong.

### D-5 · The Keycloak instruction contradicts "leave it exactly as it is"

- **Locations:** `APW-12-ever-id/idp-options.md` §7 item 5 — _"The dormant Keycloak scaffolding stays exactly as
  it is (NN #20 — no removal)."_; and `APW-12-ever-id/cross-platform.md:78` — _"**Leave as-is (NN #20).**"_
- **Owner's answer:** _"provider plugins are named per provider (`zitadel`, `keycloak`, `supertokens`, `auth0`),
  and **Keycloak's existing core code must be moved into a plugin**."_
- **Why it contradicts:** a move is not "stays exactly as it is".
- **Mechanical fix:** re-word both to \_"Keycloak's existing core code is **moved into the `keycloak` plugin
  package, behaviour unchanged**: the `KEYCLOAK\__`environment keys, the`'disabled'`fallback and the`parseKeycloakConfig`warning are preserved verbatim (NN #20 — nothing is removed or renamed)."\* Then confirm
  the same text appears in`cross-platform.md` §7's plugin-family bullet.

### D-6 · Wave 1 has a declared circular dependency

- **Locations:** ✅ **FIXED WHILE WRITING in the tracker** — `TRACKER.md:38-44` now records it: _"**APW-06 ↔ APW-07
  declare each other.** `APW-06/spec.md:14` depends on APW-07 … and `APW-07/spec.md:13-14` depends on APW-06 …
  The merge order above lands APW-07 P1 first, so one direction must be softened."_
- **Remaining mechanical fix:** apply the tracker's own recommendation to the two specs — soften
  `APW-07/spec.md:13-14`'s dependency on APW-06 to _"APW-06's ports/interfaces only"_. Until one of the two is
  softened, Wave 1's first parallel lane cannot actually run in parallel.

---

## E. Things in the owner's answers that I could **not** verify (do not treat as settled)

### E-1 · "connected customer nodes"

Verified absent from the plan and the code (see B-4). The answer is recorded; the _mechanism_ does not exist
anywhere and is not described by any gate item. **Recommendation:** record the intent, do not scope it.

### E-2 · `ever-works/templates` as "the human listing repo"

- **Stated:** _"`ever-works/templates` is the human listing repo; templates are `-template` repos found by a
  GitHub suffix scan"_ — and `implementation-plan.md:47` now records it as answered: _"the human listing repo is
  **`ever-works/templates`** (not `ever-works/apps`)"_.
- **Found:** the **suffix scan is real and shipped** — `packages/agent/src/template-catalog/template-catalog.service.ts:1047-1049`
  (`return /template$/i.test(repo.trim());`), scanning the **whole `ever-works` org** (`packages/agent/src/config/index.ts:885-887`
  → `WEBSITE_TEMPLATE_CATALOG_ORG || 'ever-works'`), paginated and cached (`:668-712`, `:714-716`, entry point
  `syncDiscoveredWebsiteTemplatesIfStale()` at `:621`). **No repository named `ever-works/templates`, and no
  reference to one, exists anywhere in the code or in any App Works doc.**
- **What the plan does name:** `ever-works/apps` as the machine-readable Apps catalog
  (`CONTRACTS.md:430`; `EVER_WORKS_APPS_CATALOG_REPO` default `ever-works/apps`, `CONTRACTS.md:401`) and
  `ever-works/works` as the Work Blueprint catalog (`apps/api/src/works/works-template-catalog.service.ts:88-89`).
- **So:** either `ever-works/templates` is a **new human-facing listing repository** that no spec mentions
  (which is new scope and needs its own row), or the owner meant "the templates live as `-template` repos in
  `ever-works`, discoverable by the existing org-wide suffix scan, with `ever-works/apps` as the machine
  catalog". **Ask which — do not create a repository on this answer alone.**

### E-3 · `auth.ever.co`

- Stated as _"verified free in the `ever.co` Cloudflare zone"_. **I made no Cloudflare call in this pass and
  could not re-verify it.** The name satisfies `idp-options.md:184` D2's three constraints (not under the Ever
  Works app domain `ever.works`, not under the user-apps domain, not shared with another product line).
- **But three files still say the domain is open** and must be corrected once it is written down:
  `implementation-plan.md:51` (_"domain still open"_), `README.md:348` (_"The **domain** for it is still open."_),
  `APW-12-ever-id/idp-options.md:214-216` (_"D2–D9 remain open"_), and `APW-12-ever-id/spec.md:588`
  (the `[NEEDS CLARIFICATION: identity provider product and domain.]` marker itself).

### E-4 · "Managed Apps tier … customer k8s clusters"

The customer-cluster half **does** exist as substrate: `ClusterSource = 'k8s-works' | 'k8s-works-shared' |
'custom-kubeconfig'` (`packages/plugins/k8s/src/types.ts:83`), presented as _"Ever Works shared customer
cluster"_ / _"Ever Works internal cluster (admin only)"_ / _"Custom — paste your own kubeconfig"_
(`apps/api/src/plugins-capabilities/deploy/cluster-source-matrix.ts:50-60`), with authoritative admission at
`packages/agent/src/facades/deployment-context.resolver.ts:83,126`. **What does not exist is any of the tier:**
`AppsTierPolicy`, an `apps-tier` capability, an `ever-works-apps` plugin, `EVER_WORKS_APPS_MANAGED_ENABLED`, and
the `hosting.ever.works/v1alpha1` `Work` CRD have **zero matches under `apps/` or `packages/`** — they exist
only in `docs/specs/features/app-works/**`. So the tier is 100% new code, and the customer-cluster path is a
reusable _existing_ deploy target, not the tier itself.
