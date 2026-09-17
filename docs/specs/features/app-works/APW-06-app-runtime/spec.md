# Feature Specification: App runtime on Kubernetes

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-06-app-runtime`
**Program**: [App Works](../README.md) — Waves 1 (P1), 2 (P2), 3 (P3)
**Branch**: `feat/apw-06-app-runtime`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: XL · **Depends on**: APW-03 (App spec, license class, hosting eligibility and the license attestation),
APW-05 (Builds, image pull access), APW-07 (env values, App dependencies), APW-10 (the Ever Works Apps tier: launch
gate, its `apps-tier` capability and tier policy, P2+), APW-01 (deleting an App Work) · **Depended on by**: APW-04,
APW-08, APW-11, APW-13

> **Program audit resolutions applied** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):
> R-3 (one license attestation, owned by APW-03), R-5 (on Ever Works Apps the platform only hands over desired state),
> R-10 (verification targets for the App Provisioner), R-12 (deploy target **None**), R-15 (deleting an App Work),
> R-16 (a public URL on Your cluster in Wave 1), R-24 (sandboxed runtime from Wave 2), R-2 (Activity naming), R-22.

> **Additive-only (program rule #1).** The way every existing Work deploys — website repositories, the
> workflow-dispatch path, the platform-managed server-side path, the single-container manifest set, the
> Deploy tab for existing kinds — is untouched and byte-identical. The **Repository Work** keeps refusing to
> deploy. Everything below applies only to Works of kind **App** and is new surface next to what ships.

> **Words.** Kubernetes object kinds are written in code style (`Deployment`, `Ingress`, `Job`). The plain
> word **Deployment** is the Ever Works history record ("putting a built image live", README §1). A deploy
> target is one of **None**, **Your cluster** or **Ever Works Apps**. The word "environment" is not used for
> deploy targets anywhere on this surface.

---

## 1. Overview

An App Work is a real application — several processes, a database, background jobs, scheduled calls, files
on disk — not a static site with one container. This epic runs it. The owner picks where it runs: **None**
(don't deploy yet — build only), **Your cluster** (a kubeconfig they paste) or **Ever Works Apps** (managed, off
until its launch gate passes; there the platform hands the app's desired state to the isolated tier, which renders
and runs it inside its own zone). A Deployment takes a green Build and the App spec from the same commit, turns them into
a locked-down set of Kubernetes objects in a namespace of its own, runs the app's migrations **before** new
code starts, waits for every component to be healthy with numeric deadlines, runs first-time setup **before**
the app is reachable from the internet, publishes it on its domains, and proves it works with the App spec's
smoke tests — from inside the cluster and over the public address. If the new version fails, the previous
one is put back automatically. Afterwards the platform keeps watching: a health card shows what is running,
a sustained failure produces one notification rather than silence, and the owner can pause, resume, roll
back or remove the app — never losing stored data without typing the app's name to confirm, including when the App
Work itself is deleted.

## 2. Why now

### 2.1 The user's question

> _"My fork builds. Now make it run somewhere — properly: its database migrations, its cron calls, its
> login URL, HTTPS — and tell me when it breaks."_

### 2.2 What they do today instead

| The need                                     | What Ever Works offers today                                                                | What the user actually does                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Run more than one process                    | One container per Work, one port, a fixed health path.                                      | Writes manifests by hand.                                |
| Run migrations before the new version starts | Nothing. Many apps migrate on boot and keep booting when the migration fails.               | Hopes the entrypoint fails loudly; usually it does not.  |
| Recurring calls the app expects              | Nothing on a cluster; a hosting provider's cron file does nothing there.                    | Forgets, or exposes the cron route with a guessable key. |
| First-run admin setup                        | Nothing. The app is public the moment its pods are ready.                                   | Races strangers to the setup page.                       |
| Know the new version works                   | "Ready" means the old pods were still available.                                            | Opens the site and clicks around.                        |
| Undo a bad release                           | Re-dispatch of a branch alias that points at the same bad image.                            | Reverts the commit and waits for a rebuild.              |
| Run untrusted software safely                | No rendering built for untrusted code; workloads get whatever the cluster's defaults allow. | Hardens the cluster by hand, or does not.                |

### 2.3 The three gaps, all of them ours

1. **The runtime model is one stateless container.** Real apps need components, jobs, cron, volumes, probes
   and secrets, and the App spec already describes them (APW-03). Nothing renders them.
2. **"Deployed" is not "working".** Today's readiness can report success while the new version crash-loops
   behind the old one, and nothing checks the page a person would actually load.
3. **User-controlled code needs defaults that assume the worst.** A fork is untrusted input (program rule 9).
   The rendered objects must deny what the app does not need — privileges, cluster credentials, private
   networks — while still running software that, for example, rewrites its own files at boot.

### 2.4 What this epic changes

```
 BEFORE                                         AFTER
 Build ─► (nothing)                             green Build + App spec @ same commit
                                                   │ preconditions: spec · license · env · deps · quota
                                                   ▼
                                                namespace (deny-by-default) ─► pre-deploy jobs (migrate)
                                                   ▼                              │ fail → nothing changed
                                                components roll out (deadlines)   ▼
                                                   ▼                            first-deploy jobs (setup)
                                                in-cluster smoke ─► publish domains ─► public + hairpin smoke
                                                   │ fail → previous version restored automatically
                                                   ▼
                                                Live ─► health poll ─► one notification on sustained failure
```

## 3. User scenarios

### 3.1 Primary

- **S1 — No target yet.** **Given** a new App Work whose target is **None — don't deploy yet**, **when** the owner
  opens Deploy, **then** the page reads **"This app isn't running anywhere yet."**, explains the three targets in one
  line each, shows **Connect your cluster** as the primary action and **Run on Ever Works Apps** only when that
  target is enabled for this App Work (otherwise a one-line reason), and still lists Builds.
- **S2 — Connect your cluster.** **Given** the owner pastes a kubeconfig and presses **Check connection**,
  **when** the check finishes (within 30 seconds), **then** the dialog shows the cluster name and version, a
  permissions checklist with every missing permission named, the detected ingress classes (default
  preselected), certificate issuers, storage classes, and the namespace the app will use; **Save** is enabled
  only when every required permission is present.
- **S3 — First Deployment.** **Given** a green Build for the head of the deploy branch, required env set and
  dependencies ready, **when** the owner presses **Deploy**, **then** the request returns at once, the
  progress panel walks through **Preparing → Migrations → Starting components → First-time setup → Checking
  inside the cluster → Publishing → Checking the public address**, and ends **Live** with the URL, the
  components table and the smoke results.
- **S4 — Migration fails.** **Given** a Deployment whose migration job exits non-zero, **when** the job ends,
  **then** no component is changed, the Deployment is **Failed** with **"Migration `migrate` failed (exit
  code 1). Your previous version is still running."**, the last 200 log lines are one click away, and a
  notification is sent.
- **S5 — New version crashes; automatic rollback.** **Given** a live app, **when** a Deployment's web
  component restarts 3 times during rollout, **then** the previous version is restored, the Deployment reads
  **Rolled back** with the reason and the restart logs, and the URL keeps serving the previous version.
- **S6 — Setup before exposure.** **Given** an App spec with a first-deploy job that creates the first
  administrator, **when** the first Deployment runs, **then** that job completes against the app **inside
  the cluster** before any public hostname routes to it, and it never runs again on later Deployments to the
  same cluster.
- **S7 — Smoke catches a baked-in address.** **Given** a smoke check that says the login page must not
  contain a development address, **when** the page still contains it, **then** the check fails with the
  exact string found and the Deployment is rolled back.
- **S8 — Custom domain.** **Given** a live app on Your cluster, **when** the owner adds `book.example.com`,
  creates the DNS record shown (an `A` record to the ingress IP, or a `CNAME` to the ingress hostname) and
  presses **Verify**, **then** the domain is published within 60 seconds of verification without restarting
  the app, with a certificate when the cluster has an issuer configured.
- **S9 — Primary address changes.** **Given** an App spec whose domain change policy is **restart**, **when**
  a verified custom domain is made primary, **then** a Deployment of the same Build restarts the app with the
  new address in its settings; with policy **rebuild**, a Build starts first and the Deployment follows it,
  while the old address keeps working until the new version is live.
- **S10 — Health notification.** **Given** a live app, **when** its public check fails on 5 consecutive
  polls (≈ 5 minutes), **then** the owner gets one notification **"<app> is down"** naming the failing check,
  the Overview card turns red, and when 3 consecutive polls pass a **"<app> is back"** notification follows.
- **S11 — Pause and resume.** **Given** a live app, **when** the owner presses **Pause app**, **then** every
  component stops within 120 seconds, scheduled calls stop, data and dependencies stay, health polling
  stops, and **Resume** brings it back with the same checks as a Deployment.
- **S12 — Source offer.** **Given** an App Work whose license requires offering source to network users and
  that either links its own repository or whose fork has commits the upstream does not, **when** it is live, **then** the Deploy tab and the App Launcher item
  show **Source** linking to the fork at the exact deployed commit.

### 3.2 Unhappy paths

- **S13 — Preconditions unmet.** **Given** two required env values unset and a dependency still provisioning,
  **when** the owner presses **Deploy**, **then** nothing is queued and the panel lists all three problems by
  name, each with a link to fix it — never a generic "not ready".
- **S14 — No green Build for the head.** **Given** the newest Build of the deploy branch failed, **when** the
  owner presses **Deploy**, **then** the dialog offers **Deploy <short sha> (3 commits behind)** from the
  newest green Build, or **Build the latest commit**.
- **S15 — Kubeconfig that runs code.** **Given** a pasted kubeconfig that authenticates by running a local
  command, reading a local file, using a proxy or skipping certificate checks, **when** the owner checks the
  connection, **then** it is refused before any connection attempt with the specific reason and a link to the
  service-account instructions.
- **S16 — Cluster address not public.** **Given** a kubeconfig whose server resolves to a private, loopback,
  link-local or shared address, **when** the connection is checked, **then** it is refused with **"Ever Works
  can only reach clusters at a public address."**
- **S17 — Missing permission.** **Given** a credential that cannot create network policies, **when** the
  check runs, **then** the checklist names that permission and shows the command that grants it.
- **S18 — Image runs as root.** **Given** an image that insists on running as root, **when** it is deployed
  to Your cluster, **then** the rollout fails within 180 seconds with **"This image runs as root."** and the
  option **Allow this app to run as root on my cluster** (warning shown); on Ever Works Apps the same image
  is refused before anything is applied.
- **S19 — Public check fails, app is fine.** **Given** in-cluster smoke passes but the public address does
  not resolve to the cluster yet, **when** the public window (600 seconds on first publish) ends, **then**
  the Deployment is **Live with warnings**, nothing is rolled back, and the DNS record to create is shown.
- **S20 — Rollback fails too.** **Given** a failed rollout and a previous version that no longer starts,
  **when** the rollback deadline passes, **then** the Deployment is **Failed — rollback did not complete**,
  an urgent notification is sent, and the Deploy tab shows both versions' component states.
- **S21 — Cluster unreachable.** **Given** a live app whose cluster credential has expired, **when** 10
  consecutive polls cannot reach the cluster, **then** the health state is **Can't reach your cluster**
  (not "down"), one notification says so, and deploying is refused until the connection check passes.
- **S22 — Quota.** **Given** an owner with 3 App Works on Ever Works Apps, **when** they choose that target
  for a fourth, **then** the choice is refused with the limit and the three App Works that count toward it.
- **S23 — License blocks the target.** **Given** an App Work classified amber with no recorded upstream agreement,
  **when** the owner chooses Ever Works Apps, **then** that target is disabled with the license reason; Your cluster
  requires the owner's attestation once, recorded with their name and the date; a member who is not the owner sees
  **Attest** disabled with **"Only the App Work's owner can attest."** A red license is never offered on Ever Works
  Apps.
- **S24 — Remove with data.** **Given** an app with a volume and a database, **when** the owner removes it and
  ticks **Also delete stored data**, **then** removal proceeds only after they type the App Work's slug
  exactly, and the dialog lists every volume and dependency that will be destroyed.
- **S25 — Someone else's App Work.** **Given** an App Work id from another workspace, **when** any route in
  this epic is called, **then** the answer is **not found**, identical to an id that does not exist.

### 3.3 Race and permission edges

- **S26 — Two deploys.** **Given** a Deployment running, **when** a second is requested manually, **then** it
  is refused with a link to the running one; **when** a newer Build succeeds instead, **then** it is queued,
  and a still newer Build replaces the queued one (the replaced one reads **Skipped**).
- **S27 — Pause during a Deployment.** **Given** a Deployment in progress, **when** **Pause app** is pressed,
  **then** it is refused with **"Wait for the current Deployment to finish, or cancel it."**
- **S28 — Viewer.** **Given** a member with view permission only, **when** they open Deploy, **then** they
  see status, history and smoke results but no deploy, rollback, job, pause, remove or log actions.
- **S29 — Different cluster.** **Given** a live app, **when** the owner saves a kubeconfig for a different
  cluster, **then** the next Deployment asks for confirmation: the app on the previous cluster keeps running
  and is not removed, and first-time setup jobs will run again on the new cluster.

### 3.4 Deleting, public URLs and verification

- **S30 — Delete the App Work, keep the data.** **Given** a live App Work on Your cluster with a volume and a
  PostgreSQL dependency, **when** the owner deletes the App Work with **Also delete stored data** unticked (the
  default), **then** the dialog first lists what is kept (**volume web-uploads (2 GiB) · PostgreSQL database**), the
  App Work reads **Deleting…**, every workload, job, scheduled call, service, published host, managed DNS record, the
  env secret and the app's network policies are removed within 300 seconds, the volume and the database stay with
  their data (the database stopped and still closed to every other pod), and then the App Work disappears; Activity
  names what was kept.
- **S31 — Delete the App Work and its data.** **Given** the same App Work, **when** the owner ticks **Also delete
  stored data**, **then** **Delete** stays disabled until they type the App Work's slug exactly; once deleted, the
  dependencies are deprovisioned, the volume claims and then the namespace are removed.
- **S32 — Delete while the cluster is unreachable.** **Given** an App Work whose cluster credential has expired,
  **when** the owner deletes it, **then** removal is retried 3 times over 15 minutes, the App Work is then deleted
  anyway, and Activity names every object that may remain on the cluster so the owner can remove it by hand.
- **S33 — A public URL on Your cluster without a custom domain.** **Given** an installation, **when** an App Work
  first deploys to Your cluster whose ingress reports a public address, **then** it is published at
  `<slug>.<apps-domain>` (a short suffix is added when the slug is taken) with a DNS record pointing at that
  ingress, the URL uses `https` when the cluster has a certificate issuer selected, and custom domains can still
  be added. `<apps-domain>` is `EVER_WORKS_APPS_DOMAIN`, **defaulting to the installation's platform domain**, so
  the ordinary result is `<slug>.ever.works`; an operator may configure a dedicated apex instead (owner decision
  2026-09-17, R-16 — additive). **Given** the managed shape is switched off or its apex fails validation — the
  only case in which no managed address is offered — **then** only custom domains are offered.
- **S34 — Verification before merge.** **Given** the App Provisioner verifies a proposal on an App Work that targets
  Your cluster, **when** a verification runs, **then** a temporary namespace separate from the live app is created with
  no public host, no custom domain and no DNS record, dependencies without persistent volumes, and smoke checks run from
  inside it; it is removed entirely when the verification ends or its time limit passes, and no Deployment is recorded.
- **S35 — An app whose image is published, not built.** **Given** an App Work whose App spec names an existing image
  rather than a Dockerfile or an automatic build, **when** the owner presses **Deploy**, **then** the Deployment starts
  with no Build and no Build entry appears in the history, the image is fetched once and pinned by digest, the Deploy tab
  shows the short digest in place of a Build link, and **Roll back** returns to a previous Deployment's recorded digest
  without fetching the tag again. **Given** the named image cannot be read without credentials, **then** the Deployment
  fails with **"This image can't be downloaded without credentials. Ever Works deploys published images only when they
  are public."**; **given** it is named only by a movable tag, **then** the Deployment proceeds on Your cluster with
  **"This image is referenced by tag. Pin it by digest so every Deployment runs the same image."** while Ever Works Apps
  refuses it before anything is applied.
- **S36 — Dependencies before the first Deployment.** **Given** an App Work on Your cluster whose App spec declares a
  database, **when** the owner saves the target, **then** the app's namespace and its baseline network policies are
  created before the database is provisioned — nothing waits for a Deployment — the database becomes ready within its
  deadline, and only then does the first Deployment run. **Given** the owner has switched network isolation off,
  **then** other pods still cannot reach the database.

---

## 4. Functional requirements

Every threshold below is a number on purpose.

### 4.1 Deploy targets

- **FR-1.** Every App Work has exactly one deploy target: **None** (default; labelled **"None — don't deploy
  yet"**), **Your cluster** or **Ever Works Apps**. There is no separate "not yet" state. Changing the target never
  removes anything already running; the change dialog says so.
    > **The choices are three; the shapes underneath are a family, and no shape is ever removed** (owner answer
    > 2026-09-17, Resolution **R-27**). `Your cluster` is served by the Ever Works **shared** customer cluster, the
    > internal admin cluster, or a **customer kubeconfig**; **Ever Works Apps** runs on the shared zone as a
    > namespace-isolated tier _and_ may be served by a customer cluster, a machine **connected to Ever Works**, or —
    > as recorded extension points — a remote host over SSH or any further provider published as a `deployment`
    > plugin. The taxonomy, its evidence and the per-shape gate attestations are in
    > [`deploy-shapes.md`](./deploy-shapes.md). **This paragraph is additive: it grants no new requirement on any
    > shipped shape and removes none.**
- **FR-2.** **None**: nothing is deployed; Builds still run; the Deploy tab explains the targets and offers
  **Connect your cluster**.
- **FR-3.** **Your cluster** uses a kubeconfig stored encrypted for this App Work, never returned by any
  endpoint. A kubeconfig is refused, before any connection attempt, when it runs a local command for
  credentials, references a local file, names a proxy, disables certificate verification, or lacks inline
  certificate authority data.
- **FR-4.** The cluster server must use `https`. Every address its hostname resolves to must be public: not
  private, loopback, link-local, shared carrier-grade, multicast, reserved, unique-local or an IPv4-mapped
  form of those. The connection is made to the address that was validated, never re-resolved, and redirects
  are not followed. Operators of self-hosted installations may allow specific address ranges explicitly.
- **FR-5.** Every connection to any App Work cluster — both targets — is made by an isolated background
  worker without access to the platform's internal networks, never by the web or API process. When the
  installation has not declared such a worker, cluster-connected actions for App Works are refused with a
  stated reason in production.
- **FR-6.** **Check connection** reports within 30 seconds: cluster name and version, required and optional
  permissions (each met or missing, by name), ingress classes (default marked), whether an ingress controller
  was found, certificate issuers and storage classes when readable. Missing required permissions block
  **Save**; missing optional ones show what is lost.
- **FR-7.** **Ever Works Apps** is offered only while APW-10's tier is open for this installation and the owner is
  eligible. In Wave 2 it accepts only App Works resolved from a verified App Blueprint, and only while the tier reports a
  sandboxed container runtime for tenant workloads; in Wave 3 any App Work the gate admits. On this target the platform
  never applies workloads itself: it renders the app's desired state and hands it to the tier, which renders and runs it
  inside the isolated zone; status, jobs, logs and removal go through the tier the same way.
- **FR-63.** The target a person chose **at creation** is carried into the App Work's runtime state on its first
  read, never left at the default: when the Work was created for **Your cluster**, the runtime state reports
  **Your cluster**; when it was created for a managed target, that target; otherwise **None**. Until this
  derivation happens the App Work would read as **None** and refuse to deploy, so it is a precondition of the
  first Deployment, not a later correction. (APW-01 persists the creation-time choice; this epic derives and owns
  the runtime value — see APW-01's recorded cross-epic requirement.)
- **FR-8.** At most **3** App Works per owner may target Ever Works Apps (operator-configurable); paused App
  Works count. The limit is checked when the target is chosen and again atomically at deploy time.
- **FR-9.** License gate per target, as APW-03's hosting eligibility reports it: **green** — every target; **amber** —
  Your cluster after the owner's attestation, Ever Works Apps only when an upstream agreement is recorded; **red** and
  **unknown** — Your cluster after the owner's attestation, never Ever Works Apps. The attestation is APW-03's single
  record: made by the App Work's owner only (anyone else is refused), recorded with actor and date, and re-required when
  the classified license changes. This epic stores no attestation of its own.

### 4.2 What runs on the cluster

- **FR-10.** Each App Work gets its own namespace per cluster, named once when the App Work is first **prepared** on
  that cluster — dependency provisioning or the first Deployment, whichever comes first — and never renamed
  (a slug rename does not move it). A namespace that belongs to another Work, or that holds objects Ever
  Works did not create, is refused unless the owner explicitly chose it. Platform-reserved namespaces are
  always refused. Preparing a namespace also installs the baseline network policies of FR-20 before any
  dependency is provisioned, so requiring a dependency to be ready before the first Deployment (FR-24) never
  waits on a Deployment to create them.
- **FR-11.** Each component runs as its own workload with its declared replicas (0–10). Web components get an
  in-cluster service; only the primary web component is published on domains.
- **FR-12.** Security defaults for every container: no privilege escalation, every Linux capability dropped,
  the runtime's default system-call filter, no cluster credential mounted, no automatic service environment
  variables, a non-root user. The root filesystem is read-only unless the component declares a writable root
  filesystem; read-only components get a private temporary directory of at most 256 MiB.
- **FR-13.** An image that runs as root, or whose user cannot be verified as non-root, fails the rollout within
  180 seconds with that reason. On Your cluster the owner may allow it for this App Work (warning recorded in
  Activity); on Ever Works Apps it is refused before anything is applied.
- **FR-14.** Probes come from the App spec. With no startup probe, a web component gets 10-minute startup
  tolerance (checked every 10 seconds, 60 failures) so slow first boots are not killed. Liveness is applied
  only when declared.
- **FR-15.** Every container carries explicit CPU and memory requests and a memory limit (App spec values or
  its defaults). Namespace defaults also apply to anything the platform starts (jobs, probes) where the
  credential allows.
- **FR-16.** Volumes become persistent volume claims. Redeploying, pausing, rolling back and removing never
  delete them; only removal with typed confirmation does (FR-49). A component with a volume and more than 1
  replica is refused at deploy time. Volumes can grow; shrinking is refused with a reason.
- **FR-17.** Runtime env values (APW-07) are delivered as a secret whose contents change the pods' identity, so
  a changed value always restarts pods on the next Deployment and an unchanged value never does. Each
  Deployment keeps its own immutable copy so a rollback restores the matching values; the current and 2
  previous copies are kept. A Deployment of the same Build with unchanged env values and unchanged platform
  variables therefore leaves running pods in place — pre-deploy jobs and smoke checks still run — and no
  per-Deployment fact (its id, its short id, a timestamp, a counter) is ever placed in a pod template.
- **FR-18.** The platform adds read-only variables prefixed `EVER_WORKS_` (public URL, deployed commit, Source
  URL when FR-44 applies). The App spec's settings may also refer to the deployed commit and to each web
  component's in-cluster address, which works before and after the app is published. Env changes made after a Deployment reach the app on the next Deployment; the
  Deploy tab counts pending changes.
- **FR-19.** Images are pulled with a read-only credential scoped to this App Work (APW-05), never the owner's
  Git token and never a platform-wide credential.
- **FR-20.** Network isolation is rendered by default on every target: deny all; allow the ingress controller
  to reach the primary web component's port; allow the app's pods to reach each other; allow DNS; allow the
  internet except private, loopback, link-local, shared, multicast and reserved ranges (IPv4 and IPv6); allow
  the app's own dependencies; allow the app's own public address when it needs to call itself. On Your
  cluster the owner may switch isolation off for this App Work (warning shown and recorded); on Ever Works
  Apps it cannot be switched off.
- **FR-21.** After each rollout the platform tests whether isolation is actually enforced (a connection that
  must be blocked is attempted with a 3-second timeout) and shows **Enforced** or **Not enforced by your
  cluster's network plugin**. On Ever Works Apps "not enforced" fails the Deployment.
- **FR-22.** On Ever Works Apps each namespace also gets a resource quota (requests 2 CPU / 4 GiB, limits
  4 CPU / 6 GiB, 20 pods, 5 volume claims, 20 GiB storage, no load balancers, no node ports), the
  restricted pod security level and the tier's sandboxed container runtime; the tier enforces these inside its zone and
  may tighten them. On Your cluster the baseline level is enforced and
  the restricted level is warned about.

### 4.3 The Deployment flow

- **FR-23.** A Deployment starts from: a manual **Deploy**, saving a cluster target with **Deploy now** ticked
  (the default) when a green Build exists, a Build succeeding on the deploy branch (default on, switchable per
  App Work), an App spec applied on the deploy branch that changes what runs when the App spec's build strategy is
  **image** (FR-64), a primary-domain change (FR-38), or a rollback (FR-33). The request answers
  within 2 seconds and never waits for the cluster.
- **FR-24.** Preconditions, checked on request and again when work starts, each reported by name: App spec at
  the Build's commit is valid; the license allows the target (FR-9); every required env value is set; every
  dependency is ready; a green Build exists for the chosen commit (default: head of the deploy branch) and its
  image still exists — **required only for the App spec's build strategies that produce a Build (FR-64)**; the
  target is configured and its last connection check passed; the App Work is not paused; no other Deployment is
  running; cron and job authentication values are set and non-empty; quota.
- **FR-25.** The image and the App spec always come from the **same commit**. When the App spec's build strategy
  publishes an image rather than building one (FR-64), that image is the App spec's own reference at that commit.
- **FR-26.** Order, with the rule for each failure:

| #   | Phase                                                     | Deadline                                                                               | On failure                                    |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Prepare namespace, policies, secrets, volumes             | 120 s                                                                                  | Failed; running app untouched                 |
| 2   | Pre-deploy jobs, in declared order                        | each job's timeout (10–3600 s, default 600 s), with its retries                        | Failed; running app untouched                 |
| 3   | Components roll out                                       | per component: startup tolerance + readiness tolerance + 120 s, between 300 and 2400 s | Rolled back (or Failed on a first Deployment) |
| 4   | First-deploy jobs (first Deployment to this cluster only) | each job's timeout                                                                     | Failed; not published                         |
| 5   | In-cluster smoke                                          | 120 s window                                                                           | Rolled back (or Failed, not published)        |
| 6   | Publish domains                                           | 60 s                                                                                   | Rolled back                                   |
| 7   | Public smoke and self-address check                       | 600 s on first publish, 180 s afterwards                                               | Live with warnings (no rollback)              |
| 8   | Post-deploy jobs                                          | each job's timeout                                                                     | Live with warnings                            |
| 9   | Scheduled calls applied                                   | 60 s                                                                                   | Live with warnings                            |

- **FR-27.** A rollout fails early — without waiting for its deadline — when a pod restarts 3 times, or when an
  image cannot be pulled or a container cannot be configured for 180 seconds.
- **FR-28.** A component with replicas `0` is applied and not waited for. A worker without probes is ready
  when all replicas have run 30 seconds without restarting.
- **FR-29.** The whole Deployment has a hard limit of 2 hours; reaching it after components changed triggers a
  rollback.
- **FR-30.** One Deployment runs per App Work. A manual request during a run is refused. A Build-triggered
  request is queued; at most 1 is queued and a newer one replaces it (the replaced record reads **Skipped**).
- **FR-31.** A running Deployment can be cancelled: before components change it ends **Cancelled**; after,
  the previous version is restored and it ends **Rolled back (cancelled)**.
- **FR-32.** On a first Deployment that fails in phase 3–5, Your cluster keeps the unpublished workloads for
  inspection (the Deploy tab offers **Retry** and **Remove**); Ever Works Apps scales them to 0.

### 4.4 Rollback

- **FR-33.** Automatic rollback restores, for every component, the exact workload definition that was running
  before the Deployment (image, env copy, settings), and the previous published hosts.
- **FR-34.** Manual **Roll back** is offered on any **Live** Deployment among the last 20 to the same target
  whose image still exists. It deploys that Deployment's Build with the App spec from that Build's commit,
  skips pre-deploy jobs by default, and states: **"Database changes made by later Deployments are not
  undone."** For an App Work whose image is published rather than built (FR-64) it redeploys the recorded
  image digest and spec commit, and never re-resolves a tag.
- **FR-35.** A rollback that does not reach readiness within the component deadlines ends **Failed — rollback
  did not complete** and sends an urgent notification.

### 4.5 Smoke tests

- **FR-36.** Every smoke check in the App spec runs twice per Deployment: from inside the cluster against the
  primary web component (with the primary host as the requested host) and over the public address. A check
  passes when the status is expected, every `bodyContains` string is present, no `bodyNotContains` string is
  present (in the first 1 MiB), and the response arrives within its latency limit. Smoke, job and scheduled
  requests never follow redirects: a redirect is judged by its own status. Checks marked first-deploy run only
  on the first Deployment.
- **FR-37.** When the App spec says the app calls its own public address, the platform also requests the
  public address **from inside the cluster**; failure is shown as **"Your app can't reach its own address from
  inside the cluster"** with guidance, as a warning. Public failures are classified — DNS not pointing at the
  cluster, certificate not ready, unreachable, check failed — and only **check failed** while in-cluster
  passed counts toward health. A failure message quotes the unexpected status or the exact string found,
  never response bodies beyond 200 characters, and never a secret value.

### 4.6 Domains and TLS

- **FR-38.** The primary address is the verified custom domain the owner marked primary, else the managed subdomain
  when the App Work has one, else none. When it changes, the App spec's policy applies: **restart** — a Deployment
  of the current Build; **rebuild** — a Build, then its Deployment; the previous address stays published
  until the new version is live. Adding or removing a non-primary domain only updates published hosts, within
  60 seconds, with no restart.
- **FR-39.** Custom domains reuse the existing add → DNS instructions → verify → remove flow. Only verified
  domains are published. DNS instructions use the address the cluster's ingress reports: an IP gives an `A`
  record, a hostname a `CNAME`.
- **FR-40.** Managed subdomains are `<label>.<apps-domain>`, where the label is the App Work's slug (with a short
  suffix when it is taken). `EVER_WORKS_APPS_DOMAIN` **defaults to the installation's platform domain**
  (`EVER_WORKS_DOMAIN`), so the ordinary managed address is `<slug>.ever.works`; an operator may configure a
  **dedicated** apps domain instead, which then must not be under any platform domain and must be on the Public
  Suffix List (owner decision 2026-09-17, R-16 — the dedicated path is kept, not removed). Managed subdomains are
  not offered only when the managed shape is switched off or the configured apex fails that validation; custom
  domains are unaffected either way. Labels are 3–63 characters, reserved labels are refused, and a label stays
  with its App Work across removals.
- **FR-41.** From Wave 1, an App Work on Your cluster gets a managed subdomain whenever a valid apps domain resolves;
  its DNS record points at the address the cluster's ingress reports, only when that address is public, and is
  re-checked on every health poll (updated if it changes, withdrawn if it stops being public). Its URL uses `https`
  when the TLS choice is **certificates from my cluster's issuer** (a certificate is requested for it) and `http` with
  the no-TLS warning otherwise, because the record points straight at the cluster. The owner may switch the managed
  subdomain off for this App Work; custom domains work either way.
- **FR-42.** TLS on Your cluster follows the owner's choice: **certificates from my cluster's issuer**,
  **TLS is terminated before my cluster** (URL uses `https`, no certificate requested), or **no TLS** (URL
  uses `http`, warning shown). On Ever Works Apps every address is HTTPS and HTTP redirects to HTTPS.
- **FR-43.** A certificate still not valid 30 minutes after publishing produces one notification.

### 4.7 Source offer

- **FR-44.** When the license class requires offering source to network users (per APW-03's registry) **and**
  either the App Work links its own repository or the Work Repository has commits the upstream does not (the same
  condition APW-03's hosting eligibility reports), the Deploy tab,
  the Overview card and the App Launcher item show **Source**, linking to the Work Repository at the exact
  deployed commit, or to the App spec's declared source-offer URL when the Work Repository is private. The
  app receives the same URL as `EVER_WORKS_SOURCE_URL`.
- **FR-45.** Ever Works does not modify the running app to display the offer and does not verify that it does.
  The Deploy tab states: **"This license requires your app to offer its source to its users. Ever Works links
  to it here; showing that link inside your app is your responsibility. This is not legal advice."** A
  private Work Repository with no source-offer URL shows a warning on every Deployment.

### 4.8 Status and health

- **FR-46.** App status shows: target, state, URL, per component ready /
  desired replicas, restarts of current pods, last out-of-memory kill in the last 24 hours, each job's last
  result, each scheduled call's last run and result, the latest smoke results, network-isolation
  enforcement, Source (FR-44), the outcomes of any action still in flight, and the time it was observed. The
  state is one of **Not deployed**, **Live**, **Degraded**, **Down**, **Can't reach your cluster**, **Paused** or
  **Deleting**; when a Deployment is running, its own state (**Deploying**, **Checking**, **Live with warnings**)
  is shown beside it rather than replacing it. A snapshot older than 180 seconds says
  **"Last checked <n> minutes ago"**; **Refresh** is allowed once per 15 seconds.
- **FR-47.** Live App Works are polled every 60 seconds: component readiness, restarts, out-of-memory kills, and
  the first `GET` smoke check over the public address. **Degraded**: a web component below desired replicas,
  or the public check failing. **Down**: the primary web component has 0 ready replicas. After 5 consecutive
  failing polls one notification is sent (at most 1 per App Work per 6 hours); after 3 consecutive passing
  polls a recovery notification follows only if a failure notification was sent. 10 consecutive polls that
  cannot reach the cluster produce **Can't reach your cluster** and one notification.
- **FR-48.** Job logs, component logs and rollout failure logs show the last 200 lines (up to 500 on request,
  256 KiB) per container, with every secret env value of 8 or more characters replaced by its name. Logs are
  fetched on demand, kept for 5 minutes, never stored in a Deployment record or Activity, and only for members
  who can deploy.

### 4.9 Pause, resume, remove, run a job

- **FR-49.** **Pause app** scales every component to 0 and suspends scheduled calls within 120 seconds; published
  addresses stay (visitors see the controller's unavailable page). **Resume** restores declared replicas and
  runs phases 3 and 5 with their deadlines. Deploying a paused App Work is refused. If a resume's own checks fail,
  the app stays resumed — there is no earlier version to restore — the Deploy tab shows the failure, and health
  notifications follow FR-47.
- **FR-50.** **Remove from cluster** deletes workloads, jobs, scheduled calls, services, published hosts, secrets,
  the app's network policies and the managed DNS record within 300 seconds, and keeps volumes, dependencies and the
  namespace holding them; the namespace's deny-all policy stays while any kept dependency or volume remains, so kept
  data is never opened to other pods. **Also delete stored data** additionally deprovisions dependencies (APW-07), deletes volume
  claims and then the namespace; it requires typing the App Work's slug exactly and lists every item first.
- **FR-51.** **Run now** on a job runs it with the current live version's image and env; one run per job at a
  time; first-deploy jobs ask for confirmation. Results appear in status and Activity.

### 4.10 Preview Deployments (Wave 3)

- **FR-52.** When enabled for an App Work, a pull request from a branch **in the Work Repository** (never from a
  fork of it) with a green Build gets a preview at `pr-<number>-<label>.<apps-domain>` in its own namespace,
  with 1 replica per component, no scheduled calls, temporary volumes, and its own dependencies — a preview
  never connects to the live app's data. Apps whose dependencies cannot be provisioned per preview get no
  preview and the pull request says why.
- **FR-53.** At most 3 previews per App Work run at once; a preview is removed within 10 minutes of its pull
  request closing and after 72 hours without a new push.

### 4.11 Scope, events, limits

- **FR-54.** Every route is scoped to the caller's workspace; another workspace's App Work answers **not
  found**. Viewing requires view permission; every action requires deploy permission.
- **FR-55.** Rate limits per member: deploy 10/min, job run 5/min, lifecycle actions 5/min, log requests 10/min,
  connection checks 6/min; status refresh 4/min per App Work.
- **FR-56.** Every Deployment, job, smoke run, rollback, pause, resume, removal, health change and target change
  is recorded in Activity with names, states, durations and links — never env values, kubeconfig content,
  tokens or log text. Managed-tier Deployments carry the compute receipt link when one exists.
- **FR-57.** Every user-visible string is translatable and none is assembled from fragments.

### 4.12 Deleting an App Work

- **FR-58.** Deleting an App Work first removes what it runs on its deploy target — workloads, jobs, scheduled calls,
  services, published hosts, the managed DNS record, the env secret and the app's network policies — and then deletes
  the App Work. Volumes and App dependencies are kept unless the owner asks otherwise (FR-59); kept in-cluster
  dependency workloads are stopped, and the namespace's deny-all policy stays while kept data remains. The upstream is
  never deleted; the fork or private copy is deleted only with its own separate confirmation (APW-01).
- **FR-59.** The delete dialog lists every volume and dependency that will be kept and offers **Also delete stored
  data** (unticked by default), which requires typing the App Work's slug exactly and then lists every item that will
  be destroyed; with it, dependencies are deprovisioned (APW-07), then volume claims and the namespace are deleted.
- **FR-60.** An App Work whose target is None, or that never had a Deployment, is deleted at once. Otherwise removal runs
  in the background: the App Work reads **Deleting…**, accepts no deploy, job, lifecycle or target change, and is
  deleted within 300 seconds of the removal finishing. When the cluster cannot be reached after 3 attempts over 15
  minutes, the App Work is deleted anyway and Activity names every object that may remain.
- **FR-61.** On Ever Works Apps the same removal is requested from the tier, which keeps or deletes stored data by the
  same rule.

### 4.13 Verification targets (for the App Provisioner)

- **FR-62.** A verification of an App Provisioner proposal on Your cluster runs in a temporary namespace per attempt,
  separate from the live app's namespace, labelled with its expiry: no public host, custom domain or DNS record; volumes
  and dependencies without persistent storage; smoke checks run from inside the namespace. It never counts as a
  Deployment, never changes the live app, and is removed entirely when the verification ends or its time limit passes.
  All of its cluster work runs on the isolated worker (FR-5). Its namespace name is derived by this epic from the live
  namespace plus the provisioning attempt, so a re-provision never collides with a leftover namespace from an earlier
  attempt, and a verifier never has to derive or guess a name of its own; its progress and outcome reach the verifier
  through a result channel rather than being read from a Deployment row.

### 4.14 App Works whose image is published, not built

- **FR-64.** An App spec may publish an image instead of building one (the build strategy that names an existing
  image) or declare that there is nothing to run at all. For the **published-image** strategy: no Build is
  produced, so a Deployment requires none and **no Build event is emitted**; the image reference comes from the
  App spec at the Deployment's own spec commit and is resolved **once**, in the isolated worker, to an immutable
  digest, with the reference's registry treated exactly like a cluster address (FR-4) before it is contacted; a
  reference given only by a movable tag is deployed once and the Deployment records it, and on **Ever Works Apps**
  such a reference is refused before any work starts; a reference that cannot be read without credentials is
  refused with **"This image can't be downloaded without credentials. Ever Works deploys published images only
  when they are public."**, a tag-only reference is reported as **"This image is referenced by tag. Pin it by
  digest so every Deployment runs the same image."**, and a reference that does not exist or cannot be reached
  fails the Deployment by name. No pull credential is used for a public image. Deployments of this strategy
  start from the App spec being applied on the deploy branch when it changes anything that runs (FR-23), and a
  rollback reuses that Deployment's recorded digest and spec commit (FR-34). For the **nothing-to-run** strategy,
  Builds still happen and a Deployment is refused with a named reason.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity                      | Today                                                                | This epic adds                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deployment**              | One row per deploy: state, provider, branch, commit, website, error. | The Build it deployed, target, per-component outcome, job outcomes, smoke results, the App spec commit, rollback facts, and the states **Rolled back** and **Skipped**. |
| **Custom domain**           | Stored, verified, merged into the website's ingress.                 | For App Works: published only when verified; can be marked primary.                                                                                                     |
| **Managed subdomain**       | One label per Work under the platform domain.                        | For App Works: under the apps domain, which defaults to the platform's own domain (`ever.works`) — never another Ever product's domain (owner decision 2026-09-17).     |
| **Build** (APW-05)          | —                                                                    | The only source of images a Deployment may use.                                                                                                                         |
| **Activity / Notification** | Existing.                                                            | App runtime events and four notification kinds (deploy failed, down, back, cluster unreachable).                                                                        |

### 5.2 New

| Entity                | Why it must exist                                                                                                                                                                                                                                                                                                                                                                                                           | Shape                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **App runtime state** | Some facts belong to the running app, not to any one Deployment and not to the Work's content: its target and namespace, whether it is paused or being deleted, whether first-time setup has run on this cluster, its last health verdict and failure streak, the last connection check. Deployments are history; the Work row is shared by every kind. The license attestation is not here — it is APW-03's single record. | One row per App Work. Internal state — not a user-facing noun and not added to the README vocabulary, following the `*State` precedent of APW-02 and APW-03. |

### 5.3 States and transitions

```
 Deployment:  Queued ─► Deploying ─► Checking ─► Live
                 │          │            │          └─(public/post-deploy warnings)─► Live with warnings
                 │          │            └─ fail ─► Rolled back │ Failed (first Deployment, not published)
                 │          └─ fail before components change ─► Failed
                 ├─ newer Build queued ─► Skipped
                 └─ cancel ─► Cancelled │ Rolled back (cancelled)

 App runtime: Not deployed ─► Live ⇄ Degraded ⇄ Down          any ─► Can't reach your cluster ─► (check passes) ─► previous
                                  └─ Pause ─► Paused ─ Resume ─► Live       any ─ Remove ─► Not deployed (data kept unless typed)
              any ─ Delete App Work ─► Deleting ─► (workloads removed, or 3 unreachable attempts) ─► App Work deleted
```

## 6. UX

All copy below is final English copy.

### 6.1 Deploy tab — target None

```
╔════════════════════════════════════════════════════════════════════════════════╗
║ Deploy                                                                         ║
║ This app isn't running anywhere yet.                                           ║
║  ○ None — don't deploy yet. Builds still run.                        (current)  ║
║  ○ Your cluster — Runs on a Kubernetes cluster you control.  [ Connect your cluster ] ║
║  ○ Ever Works Apps — We run it for you.   Not available yet for this app.      ║
║ Builds  #14 a1b2c3d ✓ 6 min ago · #13 9f8e7d6 ✗ …                              ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### 6.2 Connect your cluster

```
╔════════════════════════════════════════════════════════════════════════╗
║ Connect your cluster                                              [×]  ║
║ kubeconfig  [ paste …                                              ]   ║
║ Use a service account token. Commands, local files and proxies aren't  ║
║ supported.  How to create one →                                        ║
║                                            [ Check connection ]        ║
║ ✓ prod-east · v1.31.2                                                  ║
║ Permissions  ✓ workloads ✓ jobs ✓ services & ingress ✓ secrets         ║
║              ✗ network policies — kubectl create rolebinding …  [Copy] ║
║              ! namespace defaults (optional) — defaults not applied     ║
║ Ingress class [ nginx (default) ▾ ]   TLS [ Certificates from issuer ▾ ] ║
║ Issuer [ letsencrypt ▾ ]   Namespace  ew-scheduler-3f2a9c1b            ║
║ Network isolation  ● On (recommended)  ○ Off                           ║
║                                        [ Cancel ]  [ Save ] (disabled) ║
╚════════════════════════════════════════════════════════════════════════╝
```

### 6.3 Deploy tab — live

```
╔════════════════════════════════════════════════════════════════════════════════╗
║ ● Live  https://book.example.com   Source ↗   Your cluster · prod-east          ║
║ Deployment #9 · Build #14 a1b2c3d · 4 min ago           [ Deploy ▾ ] [ ⋯ ]     ║
║ 2 env changes aren't live yet.  [ Redeploy ]                                    ║
║ Components   web ✓ 2/2  restarts 0 │ worker ✓ 1/1  restarts 1                    ║
║ Smoke        inside ✓ 3/3 · public ✓ 3/3 · own address ✓   Isolation: Enforced ║
║ Jobs         migrate ✓ 38 s  [Logs] [Run now] │ create-admin ✓ first Deployment  ║
║ Scheduled    reminders */15 · last ✓ 2 min ago                                  ║
║ Domains      (existing cards)                                                   ║
║ History      #9 Live · #8 Rolled back · #7 Live [Roll back] …                   ║
║ Danger zone  [ Pause app ]  [ Remove from cluster ]                             ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### 6.4 Progress, failure and rollback

```
 Deploying Build #15 b4c5d6e
  ✓ Preparing   ✓ Migrations (migrate 41 s)   ✗ Starting components — web restarted 3 times
  ⟳ Restoring the previous version …   ✓ Restored
 ⚠ Rolled back. "web" kept crashing: exit code 1 after 4 s.   [ Show logs ]  [ Open Build #15 ]
```

### 6.5 Remove dialog

```
╔══════════════════════════════════════════════════════════════════════╗
║ Remove "scheduler" from your cluster?                                 ║
║ Stops and removes the app. Stored data is kept unless you choose:     ║
║ ☐ Also delete stored data — cannot be undone                          ║
║     • volume web-uploads (2 GiB) • PostgreSQL database                ║
║     Type scheduler to confirm [                 ]                     ║
║                                      [ Cancel ]  [ Remove ]           ║
╚══════════════════════════════════════════════════════════════════════╝
```

The same kept/destroyed list and typed confirmation appear as the **Stored data** section of the App Work's delete
dialog (S30, S31), next to APW-01's separate fork checkbox:

```
║ Stored data                                                           ║
║ Kept: • volume web-uploads (2 GiB) • PostgreSQL database              ║
║ ☐ Also delete stored data — cannot be undone                          ║
║     Type scheduler to confirm [                 ]                     ║
║ Generated values (like encryption keys) are deleted with the App Work.║
```

### 6.6 Overview health card

```
┌ App ───────────────────────────────────────────────────────┐
│ ● Live · https://book.example.com · checked 40 s ago       │
│ web 2/2 · worker 1/1 · last Deployment 4 min ago (a1b2c3d) │
│ ⚠ worker was out of memory 3 h ago                          │
│ [ Open app ]  [ Deploy ]  Source ↗                         │
└────────────────────────────────────────────────────────────┘
```

### 6.7 Copy

| Element                                      | Copy                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment states                            | `Queued` · `Deploying` · `Checking` · `Live` · `Live with warnings` · `Failed` · `Rolled back` · `Cancelled` · `Cancelled — quarantined` · `Skipped`                                                                |
| App states                                   | `Not deployed` · `Live` · `Degraded` · `Down` · `Can't reach your cluster` · `Paused` · `Deleting…`                                                                                                                 |
| Deployment states shown beside the app state | `Deploying` · `Checking` · `Live with warnings`                                                                                                                                                                     |
| Published image                              | `This image can't be downloaded without credentials. Ever Works deploys published images only when they are public.` · `This image is referenced by tag. Pin it by digest so every Deployment runs the same image.` |
| Precondition list header                     | `Fix these before deploying:`                                                                                                                                                                                       |
| Kubeconfig refused                           | `This kubeconfig {reason}. Use a service account token instead.`                                                                                                                                                    |
| Not public                                   | `Ever Works can only reach clusters at a public address.`                                                                                                                                                           |
| Root image                                   | `This image runs as root.`                                                                                                                                                                                          |
| Isolation not enforced                       | `Not enforced by your cluster's network plugin`                                                                                                                                                                     |
| Hairpin warning                              | `Your app can't reach its own address from inside the cluster.`                                                                                                                                                     |
| Rollback disclaimer                          | `Database changes made by later Deployments are not undone.`                                                                                                                                                        |
| Down notification                            | `{app} is down` / `{check} has failed for {minutes} minutes.`                                                                                                                                                       |
| Back notification                            | `{app} is back`                                                                                                                                                                                                     |
| Target change                                | `Changing the target doesn't remove anything already running.`                                                                                                                                                      |
| Target labels                                | `None — don't deploy yet` · `Your cluster` · `Ever Works Apps`                                                                                                                                                      |
| Deleting                                     | `Deleting…` · `Removing the app from your cluster. Stored data is kept.` · `Some objects may remain on your cluster: {names}`                                                                                       |
| Attestation (non-owner)                      | `Only the App Work's owner can attest.`                                                                                                                                                                             |

Keyboard: every action, dialog and table row is reachable by `Tab`; `Esc` closes dialogs and returns focus;
states are text plus icon, never colour alone.

---

## 7. Out of scope

- Building images (APW-05), env values and dependency provisioning (APW-07), the managed tier's hosts,
  network, edge and abuse controls (APW-10), the App Launcher (APW-11).
- Helm, Kustomize, raw manifests or compose files as input; the App spec is the only input.
- Multi-cluster, autoscaling, blue/green or canary releases; path-based routing between web components.
- Backups of volumes on Your cluster (flagged per volume, not performed).
- Reversing database migrations on rollback.
- Changing how existing kinds deploy, including the existing Deploy tab and managed hosting for websites.

## 8. Acceptance criteria

- [ ] **ACC-06-01** None: Deploy tab shows S1 copy; Builds still run; no cluster call is made.
- [ ] **ACC-06-02** A kubeconfig using a command, a local file, a proxy or skipped verification is refused before any connection (S15).
- [ ] **ACC-06-03** A server resolving to any private/loopback/link-local/shared address, IPv4 or IPv6, is refused; an operator-allowed range is accepted (S16).
- [ ] **ACC-06-04** No App Work cluster connection originates from the API or web process (asserted by test double), and production refuses cluster actions without the isolated worker declared.
- [ ] **ACC-06-05** Check connection names each missing required permission and blocks Save (S17).
- [ ] **ACC-06-06** First Deployment reaches Live on a real cluster with web + worker + migrate + first-deploy job + cron + volume (S3).
- [ ] **ACC-06-07** Rendered containers: no privilege escalation, all capabilities dropped, default seccomp, no cluster credential, non-root, read-only root unless declared.
- [ ] **ACC-06-08** Root image: rollout fails ≤ 180 s with the reason; allowing root on Your cluster succeeds; Ever Works Apps refuses before apply (S18).
- [ ] **ACC-06-09** Migration failure leaves the running version untouched (S4).
- [ ] **ACC-06-10** Crash during rollout rolls back automatically; the URL serves the previous version (S5).
- [ ] **ACC-06-11** First-deploy jobs complete before any published host routes to the app, and do not run on the second Deployment (S6).
- [ ] **ACC-06-12** `bodyNotContains` failure quotes the string and rolls back (S7).
- [ ] **ACC-06-13** Public DNS/TLS failure with in-cluster pass ends Live with warnings, no rollback (S19).
- [ ] **ACC-06-14** Self-address check runs from inside the cluster when declared.
- [ ] **ACC-06-15** Env change restarts pods on the next Deployment; unchanged env does not; rollback restores the previous env copy.
- [ ] **ACC-06-16** Image pull uses the per-App-Work read-only credential; the owner's Git token never appears in any cluster object.
- [ ] **ACC-06-17** Default network policies are rendered; isolation enforcement is reported; switching isolation off on Your cluster is recorded.
- [ ] **ACC-06-18** Volumes survive redeploy, pause, rollback and remove-without-data; volume with 2 replicas is refused.
- [ ] **ACC-06-19** Preconditions are listed by name and nothing is queued (S13); no green head Build offers the older Build (S14).
- [ ] **ACC-06-20** Image and App spec always come from the same commit.
- [ ] **ACC-06-21** Second manual deploy refused; Build-triggered deploys queue with latest-wins and Skipped (S26).
- [ ] **ACC-06-22** Cancel before and after components change ends Cancelled / Rolled back (cancelled).
- [ ] **ACC-06-23** Manual rollback deploys the old Build with the old commit's App spec and shows the disclaimer.
- [ ] **ACC-06-24** Failed rollback ends "rollback did not complete" and sends an urgent notification (S20).
- [ ] **ACC-06-25** Verified custom domain is published ≤ 60 s after verify without restart; unverified is never published (S8).
- [ ] **ACC-06-26** Primary change with restart vs rebuild policy behaves per FR-38 (S9).
- [ ] **ACC-06-27** Managed subdomain is never under **another Ever product's** domain (a subdomain of the platform's own `ever.works` IS allowed — owner decision 2026-09-17); misconfigured apps domain disables the feature (Wave 1 for Your cluster).
- [ ] **ACC-06-28** Managed DNS record on Your cluster targets only a public ingress address and is withdrawn when it is not (Wave 1).
- [ ] **ACC-06-29** TLS modes produce `https`/`http` URLs and certificate requests as stated (FR-42).
- [ ] **ACC-06-30** Source link appears only when the license requires it and the fork differs; it targets the deployed commit (S12).
- [ ] **ACC-06-31** App status returns every field in FR-46; stale snapshot copy after 180 s; refresh limited to 1 per 15 s.
- [ ] **ACC-06-32** Health: notification after 5 failing polls, max 1 per 6 h; recovery after 3 passes (S10).
- [ ] **ACC-06-33** 10 unreachable polls → Can't reach your cluster, not Down (S21).
- [ ] **ACC-06-34** Logs redact every secret value ≥ 8 characters and are not persisted.
- [ ] **ACC-06-35** Pause ≤ 120 s, resume with checks, deploy while paused refused, pause during Deployment refused (S11, S27).
- [ ] **ACC-06-36** Remove keeps volumes and dependencies; data deletion requires the exact slug (S24).
- [ ] **ACC-06-37** Run now uses the live version and refuses a concurrent run of the same job.
- [ ] **ACC-06-38** Ever Works Apps hidden/refused while the gate is off; Wave 2 accepts only verified Blueprints and refuses while the tier reports no sandboxed runtime; quota of 3 enforced atomically (S22).
- [ ] **ACC-06-39** License gate per target read from APW-03's eligibility (amber on Ever Works Apps only with an upstream agreement, red never); a non-owner cannot attest; attestation re-required on license change; no attestation stored by this epic (S23).
- [ ] **ACC-06-40** Another workspace's App Work answers not found on every route; viewer sees no actions (S25, S28).
- [ ] **ACC-06-41** Activity contains no env value, kubeconfig, token or log text.
- [ ] **ACC-06-42** Previews: same-repository pull requests only, never shared data, ≤ 3, removed ≤ 10 min after close (Wave 3).
- [ ] **ACC-06-43** Existing kinds deploy exactly as before: the existing k8s plugin and deploy service test suites pass unchanged.
- [ ] **ACC-06-44** Every new string exists in all locale files; the Deploy tab passes an automated accessibility check.
- [ ] **ACC-06-45** Deleting a live App Work without stored data removes every workload, job, scheduled call, service, published host, DNS record, env secret and app network policy within 300 s, keeps volumes, dependencies and the deny-all policy, then deletes the App Work; Activity names what was kept (S30).
- [ ] **ACC-06-46** **Also delete stored data** requires the exact slug; with it, dependencies are deprovisioned before volume claims and the namespace are deleted; an unreachable cluster is retried 3 times over 15 minutes before the App Work is deleted with the remaining objects named (S31, S32).
- [ ] **ACC-06-47** A first Deployment on Your cluster is published at `<slug>.<apps-domain>` (the apex defaults to the platform's own domain, so `<slug>.ever.works` is the ordinary result; a dedicated PSL-listed apex is also supported) with a record to the public ingress address, `https` only in issuer mode; only when the managed shape is off or its apex fails validation is no managed subdomain offered (S33).
- [ ] **ACC-06-48** A verification target is a separate namespace with an expiry label, no Ingress, DNS record or persistent volume claim, in-namespace smoke, no Deployment row, and is removed entirely by destroy (S34).
- [ ] **ACC-06-49** On Ever Works Apps the Deployment reaches the tier's plugin as desired state; no workload object is applied by the platform and the `k8s` plugin never receives the tier's credential.
- [ ] **ACC-06-50** The deploy-target picker offers **None**, **Your cluster** and **Ever Works Apps**, each with a stated reason when it is unavailable; a shape the installation cannot serve is never offered, and **no shape that ships today is removed from the matrix**: an app-kind change leaves `allowedClusterSourcesFor` returning `k8s-works` (admin), `k8s-works-shared` and `custom-kubeconfig` exactly as before (R-27).
- [ ] **ACC-06-51** The same fixture App Work deploys successfully through **both** shipped cluster sources — `custom-kubeconfig` and `k8s-works-shared` — proving the target is a configuration of one runtime rather than a fork of it (R-27, `deploy-shapes.md` §4).
- [ ] **ACC-06-52** A published-image App Work deploys with no Build, emits no `app.build.*` event and shows a short digest where the history normally links a Build; a movable tag is resolved once and a rollback reuses the recorded digest without re-resolving it; a registry answer of 404, 401/403 or timeout fails the Deployment with its own named reason (S35, FR-64).
- [ ] **ACC-06-53** Ever Works Apps refuses a tag-only image reference before anything is applied (precondition `image_not_pinned`); a public image reference is deployed with no pull credential; the `nothing-to-run` strategy refuses the Deployment by name while Builds still run (S35, FR-64).
- [ ] **ACC-06-54** On Your cluster with no Deployment yet, saving the target creates the namespace, the `LimitRange` and the three baseline network policies before the first dependency is provisioned, and the dependency reaches ready without any Deployment having run; a second call is a no-op; a namespace labelled for another Work is refused; with isolation off the baseline policies are absent while a `dep-<kind>` policy still admits only the app's own pods (S36, FR-10, FR-20, FR-24).
- [ ] **ACC-06-55** Every action route's outcome is visible: a completed refresh, a log fetch, a pause, a resume, a removal, a cancel, a job run, a connection check and an ingress reconcile each leave their documented result (runtime state or the 5-minute cache) and a failed one leaves a named code; a log `requestId` from another App Work answers not found; a cancel is honoured only for the Deployment that requested it (FR-46, FR-48, FR-49, FR-51).
- [ ] **ACC-06-56** No App Work kubeconfig is loaded, parsed or dialled by the API: saving settings through the generic Work plugin-settings route for kind `app` records zero `validateConnection` calls and zero `KubeConfig.loadFromString` calls, while the same route for a non-App Work is byte-identical to today (FR-3, FR-5, ACC-06-43).
- [ ] **ACC-06-57** Another workspace's App Work answers not found with a body identical to an unknown id on every route, before the kind check, while a viewer member still gets 403 on actions (S25, FR-54).
- [ ] **ACC-06-58** A Deployment of the same Build with unchanged env values leaves every component's pod identities and ReplicaSet count unchanged, and the per-Deployment id appears only on the Deployment object's metadata (FR-17).

## 9. Open questions

- **[NEEDS CLARIFICATION: private clusters.]** FR-4 refuses clusters on private addresses, so a cluster on a
  home or office network whose API is not public cannot be **Your cluster** without an operator allow-list
  (self-hosted installations). Is an outbound connector
  (an agent installed in the cluster that dials Ever Works) wanted in a later wave? _Default: no; documented._
- **Resolved (CONTRACTS C2): HTTP job bodies.** The outline's `generatedCredential: admin` is illustrative; bodies use
  `{{env.NAME}}` placeholders over a generated env entry.
- **[NEEDS CLARIFICATION: custom domains on Ever Works Apps.]** They depend on APW-10's certificate mechanism
  for arbitrary hostnames. _Default: managed subdomain only in Wave 2; custom domains in Wave 3._
- **Resolved (CONTRACTS C2): volume + replicas.** `volumes` with `replicas > 1` is an App spec error in APW-03 and a
  deploy-time refusal here.
- **[NEEDS CLARIFICATION: kept data after deleting an App Work.]** Kept volumes and dependencies stay on the owner's
  cluster with no App Work to manage them. _Default: Activity names them and the owner removes them by hand; generated
  values that protect that data are deleted with the App Work, and the dialog says so._
- **[NEEDS CLARIFICATION: auto-deploy default on the managed tier.]** On by default like Your cluster, or
  off because managed Deployments spend compute? _Default: on, with the receipt in Activity._
- **[NEEDS CLARIFICATION: health poll scale.]** 60-second polls dial each user cluster 1 440 times a day. Is
  that acceptable to owners who pay for API calls on hosted control planes? _Default: yes; configurable later._
