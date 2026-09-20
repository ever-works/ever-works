# App Works — program overview

**Program ID:** `app-works` (epic prefix `APW`)
**Status:** `Draft`
**Created:** 2026-09-17
**Authored against:** `origin/develop` @ `a655b53ca` · **Verified against:** `develop` @ `873274c9f` (2026-09-17; previously `e5f43f44d`, and `ee45946e5` for the first re-verification — see [EXISTING-SUBSTRATE](./EXISTING-SUBSTRATE.md) for what each pass re-checked)
**Audience:** Product, Engineering (backend, frontend, platform/infra), Design
**Governance:** [Spec Kit](../../README.md) · [Constitution](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)
**Companion documents:** [BUILD-READINESS.md](./BUILD-READINESS.md) (**start here to build it** — what is
decided, fixed, built and still missing) · [EXISTING-SUBSTRATE.md](./EXISTING-SUBSTRATE.md) (what already ships,
with file evidence) · [TRACKER.md](./TRACKER.md) (status) · [ACCEPTANCE.md](./ACCEPTANCE.md) (the end-to-end
acceptance suite for the whole program) · [CONTRACTS.md](./CONTRACTS.md) (the normative cross-epic contracts,
including resolutions R-1…R-39 and the flag, quota, notification, threat and signal registers) ·
[CLARIFICATIONS.md](./CLARIFICATIONS.md) (one row per open `[NEEDS CLARIFICATION]` marker, who decides and which
wave it blocks) · [CONFIGURATION.md](./CONFIGURATION.md) (every environment variable, flag and catalog pin, per
environment) · [data-model.md](./data-model.md) (one place for the tables the epics add) ·
[GITHUB-PERMISSIONS.md](./GITHUB-PERMISSIONS.md) (the permission and event matrix every live GitHub call needs) ·
[THREAT-MODEL.md](./THREAT-MODEL.md) (trust boundaries, threats and their controls) ·
[quickstart.md](./quickstart.md) (run the suites locally) · [checklists/requirements.md](./checklists/requirements.md)
(what `Reviewed` and `Approved` mean for a spec) · [DOCS-PLAN.md](./DOCS-PLAN.md) (where the user docs publish) ·
[JIRA-DRAFT.md](./JIRA-DRAFT.md) (the epic and story drafts) · [`contracts/`](./contracts/) (OpenAPI and
agent-surface contracts) · [`_build-artifacts/`](./_build-artifacts/) (the artifacts the program described but
never produced)

---

## 0. Why this program exists

> 📄 **The source of intent, verbatim: [`ORIGINAL-BRIEF.md`](./ORIGINAL-BRIEF.md)** — the owner's original
> `/goal` prompt of 2026-09-17, recovered from the session log on 2026-09-20 and filed here unedited, with a
> table mapping each of its sentences onto the epic that implements it. Read it before arguing that a scope
> question is settled: it is what the program was asked for, and §0 below is what thirteen epics made of it.

Ever Works builds and maintains Works with agents: it generates directories and websites, runs Tasks,
Missions and Goals, opens pull requests, deploys to Kubernetes, and keeps an Activity log of all of it.
Every Work it can **run**, however, starts from a template the platform owns.

The owner's product idea removes that limit:

> **Any repository on GitHub can be the starting point of a Work.** Paste a repository URL. If the
> repository is not yours, Ever Works forks it into your GitHub account or organization. Ever Works then
> works out how to run it — from a curated blueprint if one exists, otherwise by having an agent study
> the repository — and runs it as a Work: live on a subdomain or your own domain, on the shared Ever
> Works cluster or on your own Kubernetes cluster, or not deployed at all. From then on you **chat with
> your agents** and they keep changing that software for you: new features, fixes, a whole product built
> on top of it — pushed to your fork, redeployed, and, when you want, proposed back to the original
> project as a pull request.

Hosting open-source software is common. Hosting it **and** continuously evolving your own fork of it
with agents — while staying in sync with upstream and able to contribute back — is the gap.

| The user's question                                            | Today                                                                                                                | What this program adds                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| "I love this open-source app. Can I have my own running copy?" | Only platform templates run. A **Repository Work** can wrap an existing repo, but never forks, builds or deploys it. | Create an **App Work** from any GitHub URL: link or fork, then run it.                   |
| "How do I even run it?"                                        | Read the project's docs; write Dockerfiles, manifests, env files yourself.                                           | An **App Blueprint** (curated) or the **App Provisioner** agent writes the **App spec**. |
| "Where does it run?"                                           | Platform-template sites only, on the platform's clusters, Vercel, or a custom kubeconfig.                            | Any App Work on a user cluster, on the managed Apps tier (gated), or nowhere.            |
| "Make it do X for my business."                                | Tasks, Goals and Missions work on Works whose code the platform generated.                                           | The same loop on the fork: chat → Task → PR → checks → merge → rebuild → redeploy.       |
| "Upstream shipped a release — am I behind?"                    | Nothing tracks forks.                                                                                                | **Upstream sync** on a schedule; conflicts become a Task.                                |
| "This fix would help everyone."                                | Nothing proposes changes to third-party repositories.                                                                | **Upstream pull requests**, human-approved, following the project's contribution rules.  |
| "Jump from Ever Works to Gauzy, Teams, or the app I built."    | Each platform is an island with its own login.                                                                       | The **App Launcher** and **Ever ID** single sign-on.                                     |

This program is **additive** (NN #20). It removes nothing, renames no entity, and changes no existing
kind's contract — in particular the **Repository Work** (`repo`) keeps its "never generate, never
deploy, never write" guarantee (EW-766). Where a new noun is genuinely required, §1 says so.

---

## 1. Vocabulary — no new synonyms

| Concept                                                                           | Canonical noun                                                                                                                                                                                                                          | Do **not** introduce                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A Work whose code is a repository that Ever Works builds, runs and evolves        | **App Work** — a Work of kind **`app`** (chip label **App**) — **NEW kind**, justified in APW-01                                                                                                                                        | "project", "application instance", "service", "deployment"             |
| A Work that only wraps an existing repository (no fork, no build, no deploy)      | **Repository Work** (`repo`, existing, unchanged)                                                                                                                                                                                       | —                                                                      |
| The repository the user pointed at, when it belongs to someone else               | **Upstream** (repository)                                                                                                                                                                                                               | "source", "origin", "parent" in UI copy                                |
| The user's copy on GitHub                                                         | **Fork** (a GitHub fork) or **Private copy** (a non-fork duplicate) — both are the App Work's **Work Repository** (see the repository-role note below)                                                                                  | "clone" as a UI noun, "mirror"                                         |
| How to build and run the software                                                 | **App spec** — the `spec` block of `.works/works.yml` for kind `app` (existing file, existing "kind spec" idea)                                                                                                                         | "recipe", "preset", "manifest", "compose file" as the noun             |
| A curated, ready-made App spec for a known open-source project                    | **App Blueprint** — a [Work Blueprint](../../../features/work-blueprints.md) whose kind is `app`                                                                                                                                        | "preset", "template" (Templates are Website/Work Templates)            |
| The catalog listing App Blueprints                                                | **Apps catalog** — the listing in **`ever-works/templates`** (a runtime-loaded listing, ADR-014; renamed from `ever-works/apps` on 2026-09-17 — the noun "Apps catalog" is unchanged)                                                   | "marketplace" (reserved for EW-299), "store"                           |
| The repository holding one App Blueprint                                          | **Blueprint repository** — `ever-works/<app>-template`                                                                                                                                                                                  | —                                                                      |
| The agent that studies a repository and writes its App spec                       | an **Agent** created from the **App Provisioner** agent template, using the **`provision-app` Skill**                                                                                                                                   | "provisioning bot", "deployer agent" as entities                       |
| Producing a container image from a commit                                         | **Build** (`WorkBuild`) — **NEW entity**, justified in APW-05                                                                                                                                                                           | "pipeline run", "CI job" as the noun                                   |
| Putting a built image live                                                        | **Deployment** (existing `WorkDeployment`)                                                                                                                                                                                              | "release", "rollout" as the noun                                       |
| Where an App Work runs                                                            | **Deploy target**: **None**, **Your cluster** (custom kubeconfig), **Ever Works Apps** (managed, gated)                                                                                                                                 | "hosting plan", "environment" (Environments = agent sandboxes)         |
| The infrastructure a deploy target actually resolves to                           | **Deploy shape** — shared cluster · internal cluster · customer kubeconfig · connected Ever Works machine · SSH host · provider plugin. **A family, additive only** (R-27, [`deploy-shapes.md`](./APW-06-app-runtime/deploy-shapes.md)) | "the cluster" as if there were one, and any wording that drops a shape |
| A database, cache or bucket the app needs                                         | **App dependency** (declared in the App spec, provisioned per App Work)                                                                                                                                                                 | "addon", "resource", "sidecar"                                         |
| Bringing upstream changes into the fork                                           | **Upstream sync**                                                                                                                                                                                                                       | "rebase job", "update"                                                 |
| A pull request opened against the upstream repository                             | **Upstream pull request**                                                                                                                                                                                                               | "contribution" as an entity                                            |
| The cross-platform switcher (Ever Works, Gauzy, Teams, Rec, the user's App Works) | **App Launcher**                                                                                                                                                                                                                        | "switcher" (Organization/Work switchers exist), "selector"             |
| One identity across Ever platforms                                                | **Ever ID** (single sign-on)                                                                                                                                                                                                            | "Ever account", "global login"                                         |
| An Ever ID sign-in linked to an Ever Works account                                | **Connected identity** (`ExternalIdentity`) — **NEW entity**, justified in APW-12                                                                                                                                                       | "linked account", "federated user"                                     |
| One App Provisioner attempt on an App Work (steps, attempts, evidence)            | **App provisioning** (`WorkAppProvisioning`) — **NEW entity**, justified in APW-04                                                                                                                                                      | "provisioning job", "setup run" as nouns                               |
| The checklist that must be green before Ever Works Apps accepts user code         | **Launch gate** (items `LG-01`…`LG-25`, APW-10)                                                                                                                                                                                         | "go-live checklist", "readiness review"                                |
| Stopping one App Work's workloads and network on Ever Works Apps                  | **Quarantine** (APW-10; distinct from the platform stop flag and Agent/workspace pauses — Resolution R-20)                                                                                                                              | "kill switch" for a single App Work, "suspend"                         |
| A unit of delegated work / an initiative / an execution / a capability            | **Task** / **Mission** / **Run** / **Skill** (existing — see the Agent Workspace vocabulary)                                                                                                                                            | —                                                                      |

> **Repository roles — read before using the words "data repository" (added 2026-09-17).** A Work has up to three
> repositories, and their roles are **already persisted** as `RepositoryRole = 'data' | 'work' | 'website'`
> (`packages/contracts/src/api/work/import-source.dto.ts:12`). The mapping is documented in the platform itself
> (`packages/contracts/src/domain/work-capabilities.ts:40-49`) and is easy to get wrong:
>
> | Role (persisted, do not rename) | Default name     | UI label                    | What it holds                                                                                                                                                                                                                                             |
> | ------------------------------- | ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `data`                          | `<slug>-data`    | **"Work Repository"**       | The Work's **data** (content items, SEO/meta-data, setup parameters)                                                                                                                                                                                      |
> | `website`                       | `<slug>-website` | **"Work Repository"**       | The **app code / template output** — "not always a website". The owner's decision (2026-09-17) allows an **optional `-app` suffix alongside `-website`**, chosen by template type; the role itself is unchanged — **suffix only, no new persisted value** |
> | `work`                          | `<slug>`         | **"{provider} Repository"** | The GitHub-facing repository: the **generated output** (the "awesome" repo people star), **never deployed**                                                                                                                                               |
>
> **An App Work's app-code fork — the repository Tasks, builds and deploys target — is the Work Repository
> (`website` role), never the Work Repository.** Wherever an epic writes "the Work Repository" to mean the app
> code, read "the Work Repository".
>
> **Template provenance (owner decision, 2026-09-17).** A Work created from a template must show where it came
> from: in the **"Work Information"** block, **"Created from [public/private icon] Template Repo"**, with the
> template repository as a **URL** rendered like the Work's other repositories. The DB side is additive (the
> template coordinates are already implied by the fork relationship; store them explicitly so the UI needs no
> GitHub round-trip), and APW-01 owns the create-path write.

---

## 2. Decisions

Each decision names the alternatives it beat. Epic specs must honour these; changing one is a README
change in the same PR.

**D1 — A new Work kind `app`; the `repo` kind is not modified.**
_Alternatives:_ (a) lift `repo`'s deploy/write refusals behind a flag — rejected: `repo`'s single shared
guard (`repository-work-guard.ts`) is load-bearing for the self-build fleet, and a flag would make every
one of its fifteen refusal points conditional; (b) extend Work Import `link_existing` — rejected: it is
directory-generation-shaped and requires write access to the exact repository. `app` reuses `repo`'s URL
parser and access probe, and is added to `WORK_KIND_CAPABILITIES` with deploy, Tasks, KB and schedules
on and the content pipelines (items, taxonomy, comparisons, community PR, website generator) off.

**D2 — Link or fork, decided at creation, never silently.**
If the caller can push to the repository, the default is **Link** (the repository itself becomes the data
repository). Otherwise the default is **Fork** into the caller's own GitHub account or one of their
organizations, using **the caller's own Git connection** — never the platform's customer organization
(GitHub allows one fork per account per upstream network, so a shared organization cannot hold two
customers' forks, and upstream pull requests must come from the user, not the platform). **Private copy**
(a non-fork duplicate) is offered when the user needs a private repository; the UI states that a private
copy cannot open upstream pull requests. Creating an App Work never deletes, renames or changes the
visibility of an upstream repository, and deleting an App Work never deletes the fork unless the user
ticks that box explicitly.

**D3 — The App spec lives in the Work Repository.** `.works/works.yml` gains a `spec` schema for kind `app`
(Constitution III) and lives in the repository holding the app code — the **Work Repository** (`website` role),
_not_ the `data` role (see the repository-role note in §1). The database stores derived state only (last applied
spec hash, build and deployment records). A human can edit the spec by hand; agents change it by pull request like
any other file.

**D4 — Templates live in their own repositories; the listing is curation (ADR-014).** _(Rewritten 2026-09-17 on the
owner's template-repo decision; the previous text made the catalog a metadata-only manifest and excluded
code-bearing templates.)_
Every template is its own repository in the catalog organization, named with the **`-template`** postfix —
Website/Work Templates and App Blueprints alike. The platform **discovers them by scanning the catalog
organization and keeping repositories whose name ends in `template`**, which is the rule the Website Template
catalog already uses (`packages/agent/src/template-catalog/template-catalog.service.ts:1047-1049`), then reads
each repository's own metadata: `.works/template.yml` (is this an app template, which shape, where the app source
is) and `.works/works.yml` (the App spec, `blueprint` mode). A template is therefore usable the moment its
repository exists — no listing pull request is needed for that.
The repository **`ever-works/templates`** is the **listing**: `manifest.json` (one row per template repository,
website and app alike, plus a JSON Schema), `licenses.yml` and CI. It is "mostly for us to keep track" — it adds
the **pin** (`template.sha`), the licence class, trademark and protected-path data, the managed-hosting decision
and the verification evidence, and it is what makes a template **listed** (badged and searchable). It is not what
makes a template exist, and a listing row never overrides what a template repository says about itself.
**Two shapes.** An app template is either **code-bearing** — the template repository holds the whole codebase,
kept in sync as a **public fork of the original project** with our metadata added, so provisioning forks **one**
repository and that fork is the App Work's Work Repository — or **metadata-only** — the template repository holds
only our metadata and refers to the original app repository for the source, so provisioning forks **two**: the app
source first (it is the Work Repository, built and deployed, and receives the App spec), then the template
repository, both with the member's own Git connection into the member's own account or organization (D2).
Resolution order when a user pastes a URL: (1) an explicit Blueprint id; (2) a listing match on upstream
`owner/repo` (including renames and the fork-network root); (3) the suffix scan of the catalog organization — a
`*-template` repository that declares this upstream in its own metadata and carries a valid App spec (the
`-template` suffix alone is not enough — Website Templates use it too); (4) the App Provisioner. The exact
algorithm, its limits and the fork plan are specified in
[`_build-artifacts/templates-catalog/resolution-spec.md`](./_build-artifacts/templates-catalog/resolution-spec.md).

**D5 — The App Provisioner is an Agent + a Skill running a Task, not a bespoke service.**
It runs in an isolated workspace **with no secrets and restricted egress**, treats every byte of the
repository as untrusted input, and delivers its result as a **pull request to the Work Repository** that
adds the App spec (and, only if needed, a Dockerfile). A verification loop — schema validation, a Build,
an ephemeral boot and the spec's smoke tests — is the Task's quality gate; red sends the agent back up to
the gate-attempt budget, then escalates to the user through the existing ask-human path.

**D6 — Builds are a plugin capability (`build`), first on GitHub-hosted runners in the user's repository.**
The first build plugin writes one Ever Works workflow into the Work Repository, builds on GitHub-hosted
runners (free for public repositories, large enough for heavy Node builds), pushes to the registry under
the Work Repository's owner, and reports through the existing GitHub event intake with polling as a
fallback. Upstream workflows inherited by a fork are **disabled** by default. An in-cluster, rootless,
sandboxed build plugin follows for the managed Apps tier (APW-10). No build runs on the cluster that hosts
Ever Works itself or any production product.

**D7 — The runtime is the existing `k8s` deploy plugin, extended with an App renderer.**
The plugin already applies Deployments, Services, Ingresses and pull secrets server-side, and already
supports a user-supplied kubeconfig. APW-06 adds rendering of an App spec: several components (web,
worker), init/migrate Jobs, CronJobs, startup/readiness/liveness probes, volumes, resource hints and App
dependencies. Deploy targets: **None**, **Your cluster**, **Ever Works Apps** (managed). **Ever Works Apps
is disabled until APW-10's launch gate passes**, and even then only for App Blueprints marked verified
until Wave 3.

**D8 — App dependencies are provisioned per App Work, never on the platform's own data services.**
On a user cluster: in-namespace (operator-backed when the operator exists, otherwise a single-replica
StatefulSet with a persistent volume and a backup warning). On the managed tier: dedicated tenant data
servers inside the isolated zone, with per-role connection limits. The existing per-Work Postgres
provisioner is reused for its idempotent DDL, pointed at a tenant server.

**D9 — App env and secrets are schema-driven.**
The App spec declares every variable: generated (with a typed generator and validation, e.g. "exactly 32
characters"), derived (`domains.primary.url`, `deps.postgres.url`), prompted (with description and
required flag) or defaulted, plus a **build-time vs run-time** flag. Values are stored encrypted per App
Work (Constitution VII), never logged, and rendered into a Secret. Generated secrets are generated **once**
and never rotated implicitly. This is a new store; the existing Stripe-shaped runtime-env allow-list is
untouched.

**D10 — Three address shapes, all supported; the apex is an operator choice and nothing was removed.**
_(Made explicit 2026-09-17 on the owner's answer. This decision is **purely additive** — every address shape the
earlier plan allowed still works; the platform-domain shape is added to them, not swapped in for them.)_

An App Work is reachable by all three of these, in the order a Work usually acquires them:

1. **A subdomain of the platform's own domain — `my-cool-company-gauzy.ever.works`.** This is the shape that now
   works out of the box, because installing Gauzy from a template should just work at `<slug>.<EVER_WORKS_DOMAIN>`
   the moment it deploys. `EVER_WORKS_APPS_DOMAIN` **defaults to `EVER_WORKS_DOMAIN`** and an operator may point it
   at any other apex (see 3).
2. **The tenant's own custom domain — `gauzy.my-cool-company.com`, added later.** The existing
   add → verify → remove custom-domain flow is reused unchanged, an App Work may also take `<slug>.<tenant-domain>`
   subdomains under it, and a tenant may attach a bare apex. Same flow as every other Work — no new mechanism.
3. **A dedicated user-apps apex — `<slug>.<apps-domain>` under an apex outside every platform domain and listed on
   the Public Suffix List.** **Still fully supported, still operator-selectable, never deprecated.** It remains the
   right answer for an installation that wants hard **cookie isolation**: an app under a PSL-listed apex can never
   set a cookie for a domain the platform's own session uses. LG-15 and its `APEX_NOT_ON_PSL` / `PSL_UNREACHABLE`
   probes therefore **stay exactly as they are** — they apply whenever an operator configures such an apex, and are
   simply not exercised by an installation that does not.

**What is forbidden — unchanged before and after:** a managed address under **another Ever product's** domain
(`ever.team`, `gauzy.co`, `cloc.*`, …).

**What shape 1 costs, stated rather than hidden:** when an installation picks shape 1, an app and the platform
share a registrable domain, so the isolation shape 3 exists to provide must be carried explicitly — host-only
`__Host-` Secure cookies on platform routes, no platform session cookie on app hosts, and app hosts that never
serve platform pages. Pick shape 3 and that work is unnecessary. Both are supported; the operator decides, and the
implementation obligation follows the choice. `R-16`, `ACC-06-27`, `ACC-13-20` and APW-06's domain section were
reconciled with this in the same pass — as additions, with the PSL path and its probes intact.

**D11 — Evolving an App Work reuses the existing agent loop.**
Task isolation (branch per Task), quality gates (checks from the App spec, run sandboxed), merge policy
(default: agents open PRs, humans merge) and the Fleet are reused unchanged. What is new: the data
repository of an App Work is the Task target; a merge to the default branch triggers a Build and, when it
is green, a Deployment; Goals and Missions can be scoped to an App Work; every step lands in Activity.
**Vocabulary, binding (2026-09-17):** the Task target is the App Work's **Work Repository** — the persisted
`RepositoryRole` value `website`, whose UI label is literally "Work Repository" — and **never** the `data` role,
which holds the Work's data (content items, meta-data, setup parameters). Every pre-2026-09-17 occurrence of
"data repository" that means app code reads as Work Repository (CONTRACTS §2's vocabulary fix).

**D12 — Upstream is followed, never pushed to.**
**Upstream sync** runs on a Schedule (GitHub's merge-upstream for forks; fetch-and-merge for private
copies); a conflict never auto-resolves — it opens a Task. **Upstream pull requests** are opt-in per App
Work, always human-approved, rate-limited, follow the upstream's `CONTRIBUTING`/`AGENTS.md` and AI
disclosure rules, never sign a CLA or DCO on the user's behalf, and are never merged by the platform.

**D13 — A license gate protects hosting, not forking.**
The Apps catalog's `licenses.yml` classifies licenses: **green** (permissive and copyleft including AGPL —
managed hosting allowed; AGPL-modified apps get a visible "Source" link to the deployed commit), **amber**
(source-available licenses that restrict hosting — **Your cluster** with the owner's attestation; **Ever Works
Apps** only with a recorded upstream agreement), **red** (non-commercial or no-hosting — never offered on the
managed tier and never in the catalog; allowed on **Your cluster** only after the owner's attestation — see
[CONTRACTS.md Resolution R-3](./CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)). The
license is re-evaluated on every upstream sync. Trademarked names are displayed as "<name> (community
build)" when the blueprint requires it, and blueprint-declared branding paths are read-only to agents.
The registry is legal-reviewed before launch.

**D14 — The App Launcher ships before single sign-on.**
Phase 1 is a framework-neutral web component fed by a static platform catalog plus the signed-in user's
App Works that expose a URL (`GET /api/me/apps`). **Ever ID** (a dedicated OpenID Connect identity
provider) follows; platforms adopt it additively and keep their current sign-in methods. Ever Works is
**not** the identity root for production platforms. Session tokens are never placed in URLs.
**Provider and domain decided (owner, 2026-09-17): ZITADEL, self-hosted as-is, one instance for every
platform, at `auth.ever.co`** (Resolution R-28; decision record
[`APW-12/idp-options.md`](./APW-12-ever-id/idp-options.md) §6–§7). "Additively" is binding: each platform keeps
its own authentication and its own user database, duplicated profiles are accepted, and nothing that signs a
person in today is removed or routed away.
**The user's own App Works are explicitly outside Ever ID's first wave** (owner step 7's "SSO" applies to the
platforms and to the launcher, not to a deployed App Work): a deployed Cal.diy or Umami keeps whatever sign-in it
ships with. Bringing Ever ID to a deployed App Work is a **recorded later wave**, not a silent omission — it
needs an optional `identity` block in the App spec (derived OpenID Connect client values injected as env) plus
Blueprint support, and it is listed in §8 as question 9. **No page and no string may claim SSO for an App Work
until that ships** (launch-parity G-09).

**D15 — Running user-controlled code on shared infrastructure is gated.**
Before **Ever Works Apps** accepts any App Work, APW-10's launch gate must pass: an isolated tier, sandboxed
runtime, restricted pod security, default-deny networking, quotas, a namespace per App Work, no platform-wide
credentials in tenant pods, abuse controls and a tested per-App-Work quarantine (R-20). **Isolation is measured
per deploy shape and every shape is kept** (R-27): on the shared zone the tier gets its own node pool, egress
identity and ingress; on a machine the owner connects, a customer cluster, or a host reached by SSH, the same
properties are attested **for that machine** — the gate item is located, never waived, and a shape that cannot
satisfy an item is recorded `Failed` with its reason rather than skipped. The shape family, with what ships today
and what is an extension point, is in
[`APW-06-app-runtime/deploy-shapes.md`](./APW-06-app-runtime/deploy-shapes.md). Infrastructure specifics live in
the private operations repository, not in this public spec.

---

## 2A. Approaches considered for the program as a whole

| Approach                                                                                            | Verdict                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Extend the `repo` kind** with fork + build + deploy                                            | Rejected (D1). Fastest to type, but breaks the self-build fleet's guarantee and tangles two opposite contracts in one guard.                                                                     |
| **B. New `app` kind on existing substrate** (fork API, k8s plugin, Tasks/Fleet, Blueprint catalog)  | **Chosen.** Roughly half the loop already ships; the new work is concentrated in create-from-URL, the App spec, builds, the App renderer, env/dependencies, upstream flows and the hosting gate. |
| **C. A separate hosting product first** (the future `ever.sh`), Ever Works only as the coding layer | Deferred. The App spec is written so a future hosting product can consume it unchanged; nothing in this program depends on it.                                                                   |

---

## 3. The operating loop this program makes obvious

```
 paste URL ─► Link / Fork ─► App Blueprint? ──yes──┐
                               │ no                 ▼
                               └─► App Provisioner ─► PR: .works/works.yml (App spec)
                                                          │ merge
                                                          ▼
     Upstream sync (Schedule) ─► Build ─► Deployment ─► live URL ─► App Launcher
            │ conflict             ▲                         │
            ▼                      │ merge to default branch  │ Activity
          Task ◄─ chat / Goal / Mission ─► Task ─► Run ─► PR ─┘
                                                 │
                                                 └─(opt-in, approved)─► Upstream pull request
```

---

## 4. Waves — the fastest safe path to the owner's end-to-end example

| Wave  | Ships                                                                                                                                                                                                                                                                                                                                                                        | Epics (phase)                                                       | Deploy targets enabled                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| **0** | Prerequisite fixes found by research: agent `commitToRepo` / `openPullRequest` tool bindings, checkout-directory collisions, fork readiness, **and the APW-13 test harness** (fake GitHub, the `EVER_WORKS_E2E_FAKES` non-production switch, helpers, `playwright.app-works.config.ts`) that other epics' PR-lane specs are written against. Small, independently shippable. | APW-08 P0, APW-02 P0, **APW-13 P0**                                 | —                                           |
| **1** | Create an App Work from any GitHub URL (link/fork/private copy); App spec + Apps catalog + license gate; App Provisioner; Builds on GitHub-hosted runners; App renderer; env + dependencies on **Your cluster**; evolve loop; Upstream sync; App Launcher phase 1. **The owner's Cal.diy example runs end to end on a user cluster.**                                        | APW-01…08 P1, **APW-09 P1**, APW-11 P1, APW-13 P1                   | **None**, **Your cluster**                  |
| **2** | The isolated Apps tier passes its launch gate (incl. a sandboxed container runtime for tenant workloads, R-24); managed subdomains on the user-apps domain; **verified App Blueprints only** on **Ever Works Apps**; Upstream pull requests; Ever ID for Ever Works.                                                                                                         | APW-10 P1–P2, APW-06 P2, APW-07 P2, APW-09 P2, APW-12 P1, APW-13 P2 | + **Ever Works Apps** (verified Blueprints) |
| **3** | Any provisioned repository on **Ever Works Apps**, built by sandboxed in-zone rootless builds (R-24); preview Deployments per PR; Ever ID adopted by other platforms; App Launcher reads Apps across platforms.                                                                                                                                                              | APW-05 P3, APW-06 P3, APW-10 P3, APW-11 P2, APW-12 P2–P3            | + **Ever Works Apps** (any App Work)        |

Wave 1 deliberately runs user code only where the **user** owns the blast radius (their cluster, their
GitHub Actions minutes). That is what makes it shippable ASAP.

**Cohort rollout and rollback, per wave** (added 2026-09-17 — resolution R-30; every family has an operator kill
switch in [CONTRACTS](./CONTRACTS.md) §7, read by its job dispatcher and failing closed):

| Wave | Cohort order                                                              | Exit criteria                                                                                                               | Rollback                                                                                                                                    |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | staff (the harness is not user-facing)                                    | Wave 0 PRs merged; the APW-13 harness green on `develop`                                                                    | revert the PRs; no user-visible state exists yet                                                                                            |
| 1    | staff → invited tenants → all tenants, one cohort per week                | the owner's Cal.diy example green on a user cluster; Wave 1 acceptance suite green; no P1 regression in the existing suites | `EVER_WORKS_APP_WORKS_ENABLED=false` (stops create/inspect) plus the family switches below; existing App Works keep running read-only       |
| 2    | staff tenant → design partners → paying tenants, one step per gate re-run | APW-10's launch gate green **and** its per-shape attestations recorded (D15); Ever ID Test connection green (R-28)          | the same switches, plus `EVER_WORKS_APPS_MANAGED_ENABLED=false` (stops new managed deploys) and `EVER_WORKS_APP_UPSTREAM_PRS_ENABLED=false` |
| 3    | all tenants, in zone order                                                | Wave 3 acceptance green; sandboxed in-zone builds (LG-24) attested                                                          | per-family switches; `works-app-previews` flag off                                                                                          |

**"App Works off" is defined**: with the switches off, App Works stop _changing anything_ — jobs pause, the UI is
read-only with a banner, existing Deployments keep running, and reads and sign-in keep working. Migrations are
forward-only, so a rollback is a flag flip, never a schema revert.

---

## 5. Epics

Each epic is a Spec Kit feature folder (`spec.md` + `plan.md` + `tasks.md`). `S` = size, `Dep` = blocking
dependencies.

| ID                                                          | Epic                                                                                                                                                                                                               | Extends (existing Ever Works)                                                | S   | Dep                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------- |
| [APW-01](./APW-01-app-work-kind/)                           | App Work kind & create from any repository URL (link · fork · private copy)                                                                                                                                        | `repo` kind create path, work kinds, create-Work UI                          | L   | APW-02 P0; **APW-03 P2** (T22, T26, T28, T32), **APW-06 T2–T3** (`app-runtime/ports.ts`, `APPS_TIER_POLICY`), **APW-13 P0** |
| [APW-02](./APW-02-fork-lifecycle/)                          | Fork lifecycle: readiness, Actions hygiene, upstream sync, divergence, checkout keys                                                                                                                               | GitHub plugin `forkRepository`, git facade, `GitOperations`                  | L   | —                                                                                                                           |
| [APW-03](./APW-03-app-spec-and-catalog/)                    | App spec (`.works/works.yml` kind `app`), Apps catalog, Blueprint resolution, license gate                                                                                                                         | `works-config` kind specs, Work Blueprints catalog service                   | L   | —                                                                                                                           |
| [APW-04](./APW-04-app-provisioner/)                         | App Provisioner: repository analysis → App spec PR → verification loop                                                                                                                                             | Agents catalog, Skills catalog, Tasks, quality gates, ask-human              | XL  | APW-01, 03, 05, 06, 07                                                                                                      |
| [APW-05](./APW-05-builds/)                                  | Builds: `build` capability, GitHub Actions build plugin, in-cluster builder later                                                                                                                                  | plugin system, GitHub event intake, deploy service                           | L   | APW-02, 03, 07; **APW-13 P0** (the fake-GitHub lane its tasks run in)                                                       |
| [APW-06](./APW-06-app-runtime/)                             | App runtime on Kubernetes: App renderer, deploy targets, domains, smoke tests, health                                                                                                                              | `k8s` plugin, cluster-source matrix, subdomains, custom domains, verifier    | XL  | APW-03, 05, 07, 10                                                                                                          |
| ↳ [deploy-shapes.md](./APW-06-app-runtime/deploy-shapes.md) | **The deploy-shape family (R-27)** — shared cluster, internal cluster, custom kubeconfig, connected node, SSH host, provider plugins: what ships, what is an extension point, and why nothing here may be narrowed | cluster-source matrix, `deployment` plugin capability, Fleet node enrollment | —   | —                                                                                                                           |
| [APW-07](./APW-07-app-env-and-dependencies/)                | App env & secrets store; App dependencies (Postgres, Redis, object storage)                                                                                                                                        | per-Work DB provisioner, plugin secret encryption                            | L   | APW-03, 06 (P1b only — **P1a** lands in the Wave 1 foundations without APW-06)                                              |
| [APW-08](./APW-08-evolve-loop/)                             | Evolve loop: chat → Task → PR → merge → Build → Deployment; Goals & Missions on App Works                                                                                                                          | Tasks, task isolation, quality gates, merge policy, Fleet, chat tools        | L   | APW-01, 03, 05, 06                                                                                                          |
| [APW-09](./APW-09-upstream-pull-requests/)                  | Upstream pull requests                                                                                                                                                                                             | task isolation, GitHub PR API, approvals                                     | M   | APW-02, 08                                                                                                                  |
| [APW-10](./APW-10-apps-hosting-tier/)                       | Ever Works Apps: isolated hosting tier for user-controlled code (launch gate)                                                                                                                                      | managed hosting, cluster-source matrix, deployer                             | XL  | —                                                                                                                           |
| [APW-11](./APW-11-app-launcher/)                            | App Launcher & Apps registry API                                                                                                                                                                                   | Work deployments, custom domains, dashboard shell                            | M   | — (P1); APW-06, 12 (P2)                                                                                                     |
| [APW-12](./APW-12-ever-id/)                                 | Ever ID — single sign-on across Ever platforms                                                                                                                                                                     | auth provider abstraction                                                    | XL  | — (P1); APW-11 P2 reads delegated tokens                                                                                    |
| [APW-13](./APW-13-golden-paths/)                            | Golden paths & end-to-end acceptance: fixture app, Umami, **Cal.diy** Blueprints                                                                                                                                   | e2e suites, Apps catalog                                                     | L   | APW-01…08 (P1/P2); **P0 has no dependency and lands in Wave 0**                                                             |

The `Dep` column and every epic's own `Depends on` line must agree; when they disagree the epic's own spec wins and
the table is corrected in the same PR (resolution R-38, and [TRACKER](./TRACKER.md) carries the merge order).

---

## 6. Where progress is tracked

- **[TRACKER.md](./TRACKER.md)** — spec and implementation status per epic, the merge order, what `Reviewed`
  and `Approved` mean, the owner/operator actions no epic can take, and the Jira mapping once tickets exist
  (placeholders `EW-TBD` until then).
- **[ACCEPTANCE.md](./ACCEPTANCE.md)** — the owner's eight-step example as executable acceptance
  scenarios, with the test file each scenario lives in.
- **[CONTRACTS.md](./CONTRACTS.md)** — the normative names and rules: resolutions R-1…R-39, entities, routes,
  jobs, Activity events, flags, the quota table (§7A), the notification catalogue (§6A), the threat register
  (§10), the operational signals (§11) and the error-code catalogue (§12).
- **[CLARIFICATIONS.md](./CLARIFICATIONS.md)** — the register of open `[NEEDS CLARIFICATION]` markers: who
  decides each one, the default the specs assume, and the wave it blocks.
- **[CONFIGURATION.md](./CONFIGURATION.md)** — every environment variable, flag and catalog pin, per
  environment, with the epic that owns it and whether it is a secret.
- **[data-model.md](./data-model.md)** — the consolidated tables the epics add, their owners, migrations and
  retention.

---

## 7. Rules every epic spec in this program must follow

1. **Additive only** (NN #20). No existing kind, route, entity, column or behaviour is removed or renamed.
   The `repo` kind's refusals stay exactly as they are.
2. **No duplicate nouns.** Use §1. A new entity is justified in the epic spec's §5.2 and added to §1 in the
   same PR.
3. **Behaviour-first spec, implementation-detail plan** (Constitution IX): no class or file names in
   `spec.md`; `plan.md` cites every path it relies on, and every cited path was opened.
4. **Plugin-first** (Constitution I–II): builds, registries, data services and identity providers are
   plugin capabilities resolved through facades; no hard-coded plugin ids outside the plugin.
5. **Background work through the job-runtime provider** (Constitution IV): fork readiness, builds, sync,
   deployment verification and provisioning are dispatched jobs; endpoints return `202`; overlapping runs
   are guarded.
6. **Forward-only migrations in the same PR** (Constitution V, NN #16). Migration timestamps come from the
   epic's reserved block `1792` + two-digit epic number + two-digit slot + `00000` (APW-01 slot 00 =
   `1792010000000`), above the newest migration on `develop` — `1791240000000-AddSafetyRailsCore.ts` at
   `ee45946e5` (re-verified 2026-09-17 against `873274c9f`; `1791200100000-CreateOnboardingChecklists.ts` when
   the program was authored); re-stamp before merge if `develop` moved past it. Within the block, migrations are
   stamped in **merge order within the epic's slot**, and the `1792` prefix is reserved for App Works filenames
   by a contract-test entry (Resolution R-39).
7. **Tests first** (Constitution VI): unit for logic, controller spec for endpoints, Playwright for every
   new user-visible flow, and the epic's scenarios wired into [ACCEPTANCE.md](./ACCEPTANCE.md).
8. **Secrets** (Constitution VII): App env values, kubeconfigs, registry and Git tokens are `x-secret`,
   encrypted, never logged or returned; Activity records field names only.
9. **Repository content is untrusted input.** READMEs, issues, code comments, `AGENTS.md`, workflow files
   and App specs from a fork can contain prompt injection. Agents reading them run without secrets; checks
   declared in a repository run sandboxed; nothing from a repository is executed on platform
   infrastructure outside a sandbox. **Qualified 2026-09-17 (Resolution R-33):** the two places a repository's
   own checks may run are the App Work's own CI (read-only token, no secrets) and a Fleet node the owner
   enrolled — and on a Fleet node the **setup steps and checks run with that machine's real home directory and
   toolchain**. The containment a run reports covers the **model step only** and is environment construction, not
   a filesystem or egress boundary; the owner's per-check admission (APW-08 FR-14, the EW-807 allow-list) is the
   control there, and an App Work run is admitted to a Fleet node only when its reported containment includes the
   isolated home and carries no downgrade affecting the workspace it will read.
10. **Public-repository hygiene.** This repository is public: no competitor names
    (`docs/internal/launch-parity-backlog.md`), no infrastructure addresses, hostnames of internal systems
    or unfixed security findings, and no undisclosed third-party vulnerability details. Those live in the
    private operations repository.
11. **i18n**: every user-visible string is a key in `apps/web/messages/en.json` (camelCase leaves, no
    literal `.`), added to all locale files in the same PR.
12. **Every action that spends money says so**: Builds (runner minutes), agent Runs (tokens) and managed
    hosting (compute) each produce a receipt linked from Activity.
13. **Every background family has an operator kill switch** (Resolution R-30). The switches are listed in
    [CONTRACTS](./CONTRACTS.md) §7, read by the job dispatcher that owns the family, and fail closed. A switch
    pauses a family — it never deletes, and "App Works off" means _stop changing things_, not _stop serving_.
14. **Every unbounded action has a cap** (Resolution R-31). The per-member and per-organization caps live in
    [CONTRACTS](./CONTRACTS.md) §7A with an environment override, a refusal code and user copy, and a cap is
    raised by an operator, never widened silently.
15. **Human-only actions are bound to a person, not to a credential** (Resolution R-32): spending money,
    deleting data, publishing outside the platform, changing a security posture and accepting a legal obligation
    go through `@HumanOnly()` and are excluded from MCP and chat; a typed confirmation is an extra field, never
    the guard.
16. **Every new Activity actionType is classified and summarised** (Resolution R-34): a Live Feed kind, a
    shared-view publishability decision (App Works events are `NEVER_PUBLISH`), a `status` and a human-readable
    `summary`. A completeness spec fails the build when one is missing.
17. **Every new user-visible surface is keyboard-operable and checked** (added 2026-09-17): focus order follows
    visual order, focus returns to its opener when a dialog closes, state is never carried by colour alone, live
    regions announce asynchronously-arriving status politely, and the layout survives right-to-left locales
    (`ar`, `he` are shipped). Each epic adds its own acceptance row and an automated axe check over each of its
    new surfaces, next to the epics that already have one (APW-03, 05, 06, 07, 11, 12).
18. **Constitutional gaps are flagged, not absorbed** (added 2026-09-17). `.specify/memory/constitution.md`
    Principle VI still points new API behaviour at `apps/api/test/`, which is not a runnable lane
    (Resolution R-22 corrects the _plan_; the constitution itself needs a patch), and Principle V names a
    migrations path that differs from the one every epic actually uses. Until a proposed **PATCH 1.0.1** merges
    (it updates Principle VI's implication, Principle V's path, the tasks template's test location and the spec
    template's provider-neutral wording), a plan's Constitution VI checklist line says
    "Constitutional gap flagged (R-22); amendment PR: <link>" rather than ticking silently.

---

## 8. Open questions for the owner

Each has a recommended default that the epic specs assume until answered.

1. **Managed hosting location** for Wave 2 — on infrastructure Ever already operates, behind the APW-10
   gate, or on separately rented dedicated/cloud capacity? _Default: rented capacity for the untrusted tier;
   existing infrastructure keeps serving the platform and the other Ever products. The trade-offs are in
   the private operations repository._
2. **User-apps apex domain — ANSWERED 2026-09-17: the platform's own domain by default, a dedicated
   PSL-listed apex optional.** `EVER_WORKS_APPS_DOMAIN` **defaults to `EVER_WORKS_DOMAIN`**, so managed
   addresses are `<slug>.ever.works` and no domain registration or Public Suffix List submission sits on the
   critical path; an operator may point it at a dedicated apex, and that configuration keeps the full PSL
   checks (LG-15). `<apps-domain>` remains the placeholder in the epic specs and is correct either way.
   See D10 above.
3. **Free tier** — may unverified/free users run code on the managed tier? _Default: no; Wave 2 requires a
   verified, paying account._
4. **Blueprint repository naming** — `<app>-template` (owner's suggestion) collides in suffix with Website
   Templates. _Default: keep `<app>-template` and require the `ever-works-app-blueprint` topic plus a valid
   App spec (D4)._
5. **Default fork visibility** — forks of public repositories are always public. Offer **Private copy**
   prominently? _Default: Fork is default; Private copy is one click, with the upstream-PR trade-off shown._
6. **Ever ID identity provider** — which product and domain? _Answered (owner, 2026-09-17): **ZITADEL**,
   self-hosted as-is, integrated only through standard OpenID Connect, as a **pure addition** — every platform
   keeps its own authentication and its own user database, and duplicated profiles are accepted. See
   [APW-12 `idp-options.md`](./APW-12-ever-id/idp-options.md) §6–§7. The domain is also answered:
   **`auth.ever.co`**, verified free in the live `ever.co` zone, one instance serving every platform
   (Resolution R-28). The open sub-questions are D3–D9 in that file's §6 (hosting tier, brokering, audience
   strategy, registration, consent, MFA policy, federation), tracked in
   [CLARIFICATIONS.md](./CLARIFICATIONS.md)._
7. **Where the App Launcher web component is published** — Ever Works monorepo package vs a cross-product
   repository in `ever-co`. _Default: a cross-product package in `ever-co`, since Gauzy and Teams consume it.
   Still open (CL-xx in [CLARIFICATIONS.md](./CLARIFICATIONS.md)); the platform catalog it reads is already
   settled — `ever-works/platforms` exists (Resolution R-29)._ **The Wave 1 half is answered (2026-09-17):** the
   component ships in this monorepo as `packages/app-launcher` (private, declared by `apps/web` in APW-11 T10) and
   mounts in the Ever Works header from P1, so nothing waits on this question. What remains open is the **Wave 3
   extraction** repository, the npm scope and the names-only publish credential (APW-11 T28, `EXT-30`).
8. **First golden path** — validate the pipeline on a small app before the flagship? _Default: a fixture
   app and Umami first, **Cal.diy** as the flagship demo (APW-13)._
9. **Single sign-on into a user's own App Works** — should a deployed App Work accept Ever ID as a sign-in
   option, and in which wave? _Default: **not in Waves 1–2** (recorded in D14 above). If the owner wants it,
   APW-12 gains a phase with an optional `identity` block in the App spec, derived client values injected as env,
   and Blueprint support; until then no page or string may claim it (G-09)._
10. **Does the managed-tier Cal.diy run belong to Wave 2's exit criteria?** — APW-13's golden-path lane runs
    Cal.diy on **Your cluster** through Link; the traceability matrix previously marked the Ever Works Apps half
    "GAP (optional)". _Default: keep it out of Wave 2's exit criteria and say so explicitly in
    [ACCEPTANCE](./ACCEPTANCE.md) §4, because Cal.diy needs SMTP and a root-capable runtime that the Wave 2 tier
    does not yet offer (see the capability rows in [TRACKER](./TRACKER.md)); it becomes a Wave 3 criterion once
    the tier's dependency set covers those. The owner may promote it to Wave 2 — that is the open decision._

**How these ten relate to the epic markers.** Questions 1 and 7 are restated as epic markers and are rows
`CL-42` and `CL-48` in [CLARIFICATIONS.md](./CLARIFICATIONS.md); question 10 covers the same subject as `CL-08`.
Questions 3, 4, 5, 6 and 9 have **no** epic §9 marker and are tracked only here — they block no epic's approval.
Every epic marker, the default its spec assumes, the wave it blocks and who decides it are in that register; a
spec is `Approved` for a wave only when no blocking marker for that wave is open (the status criteria are in
[TRACKER](./TRACKER.md), and the repeatable checklist is
[`checklists/requirements.md`](./checklists/requirements.md)).
