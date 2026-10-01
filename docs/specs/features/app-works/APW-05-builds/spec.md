# Feature Specification: Builds

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-05-builds`
**Program**: [App Works](../README.md) — Wave 1 (P1) · Wave 3 (P3)
**Branch**: `feat/apw-05-builds`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: L · **Depends on**: APW-03 (App spec `build` block, validation), APW-02 (Actions hygiene, webhook
capability), APW-07 (build-phase values) · **Depended on by**: APW-04 (verification builds), APW-06
(deploys a Build), APW-08 (merge → rebuild), APW-13 (golden paths)

> **Additive-only (program rule #1).** Nothing here changes how platform-template Works build or deploy
> today. The workflows the platform already dispatches for generated websites keep their names, triggers
> and secrets. The Repository Work (`repo`) still never builds. Everything below applies only to App Works.

---

## 1. Overview

An App Work's code lives in the user's own repository. A **Build** turns one commit of that repository into
one container image that a Deployment can run. The platform never builds on its own servers: in Wave 1 the
build runs on **GitHub-hosted runners inside the user's Work Repository**, from a single workflow file the
platform writes there, `.github/workflows/ever-works-build.yml`, generated from the App spec's `build`
block. The image is pushed to the container registry under the repository's owner and identified by an
immutable digest. Build-time values the app needs travel as masked repository secrets whose names start with
`EW_` — never as text in the workflow file. Builds start on every push to the tracked branch, on pull
requests into it (so the App Provisioner can verify a proposal before anyone merges it), and on **Rebuild**.
Every Build appears on a **Builds** tab with its status, commit, duration, image digest and a link to the logs
on GitHub; a failed Build says _why_ in plain words — "ran out of memory", "a build value is missing", "the
Dockerfile failed at step 7 of 14" — and hands the same diagnosis to the agents that keep the app evolving.
Every Build leaves a receipt of the runner minutes it used and who paid for them. On pull requests the same
workflow also runs the App spec's **checks** — each as its own check run named `Ever Works check: {name}`, with
read-only access and no secrets — so the agents that evolve the app see them like any other CI result. In Wave 3 a
second provider builds for the managed **Ever Works Apps** tier inside the isolated hosting zone: ephemeral,
rootless and sandboxed, with an egress allowlist, hard caps, a vulnerability scan and a signature the hosting tier
verifies before it runs anything.

> **Program audit resolutions applied** ([CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):
> R-9 (checks in the user's CI), R-10 (verification inside the runner), R-13 (`auto` build strategy), R-23 (fixture
> branches belong to APW-13), R-24 (sandboxed in-zone builds arrive in Wave 3), R-5 (the managed tier is reached only
> through APW-10's tier policy), R-4 (a linked repository always receives a pull request).

## 2. Why now

### 2.1 The user's question

> _"I forked this app and Ever Works knows how to run it. Who turns my code into something that runs — and
> when it breaks, how do I find out why?"_ — and, after an agent's first merge: _"Is the new version built
> yet, and did it work?"_

### 2.2 What they do today instead

| The need                                    | What Ever Works offers today                                                                                                                                 | What the user actually does                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Build an arbitrary repository into an image | Nothing. Images exist only for platform templates, whose Dockerfile and build workflow the platform wrote and synced into each generated website repository. | Writes a CI workflow by hand, guesses registry permissions. |
| Know which image a deploy runs              | Server-side deploys pin a **branch alias tag**, which moves on every push; the commit is recorded only as an annotation.                                     | Trusts that "latest on main" is what they think it is.      |
| Pass build-time values safely               | Template workflows read a fixed list of repository secrets the platform pushes for its own templates.                                                        | Pastes values into the Dockerfile or workflow — into git.   |
| Learn why a build failed                    | CI results reach the Task fix loop through the GitHub event intake, but only as green/red — never "out of memory" or "missing value".                        | Opens the GitHub log and scrolls 20,000 lines.              |
| Know what a build cost                      | Nothing.                                                                                                                                                     | Reads the GitHub billing page at the end of the month.      |

### 2.3 The gaps, all of them ours

1. **There is no generic build.** The platform builds only what it authored; the App spec now says how to
   build anything, and nothing reads it.
2. **Nothing identifies an image.** Without an immutable reference per commit, "deploy what was verified" and
   "roll back to the last good build" cannot be expressed.
3. **Failure is opaque.** Memory, missing value and Dockerfile error all look identical today: red.

### 2.4 What this epic changes

```
   App spec applied ──► 1 workflow file in the Work Repository
        push · pull request · Rebuild ──► GitHub-hosted runner (user's repository, user's minutes)
             Build: queued ─► running ─► succeeded · failed (class + suggestion) · cancelled · blocked (reason)
                  │ image digest, deployable yes/no + reason, receipt
                  ▼
             Deployment (APW-06) runs exactly that digest
```

## 3. User scenarios

### 3.1 Primary

- **S1 — The first Build.** **Given** an App Work forked from a public repository, whose merged App spec
  declares `build.strategy: dockerfile`, **when** the App spec is applied, **then** within 60 seconds the data
  repository gains exactly one file, `.github/workflows/ever-works-build.yml`, committed to `main` as **"Add Ever
  Works build workflow"**; that commit starts a Build shown as **Queued · Push · main · a1b2c3d**, then
  **Running**, then **Succeeded · 18m 42s** with digest `sha256:4f1c…` and **View logs on GitHub**.
- **S2 — The workflow arrives as a pull request.** **Given** a linked repository whose `main` requires reviews,
  **when** the App spec is applied, **then** one pull request **"Add Ever Works build workflow"** is opened, the
  Builds tab shows **Waiting for the build workflow to be merged** with its link, and the first Build starts on
  the merge commit.
- **S3 — Rebuild.** **Given** a succeeded Build of the `main` head, **when** a member with edit rights clicks
  **Rebuild**, **then** the request returns within 2 seconds, a Build **Queued · Manual** for the same commit
  appears, and a second click within 10 seconds returns that same Build.
- **S4 — Build values travel as secrets.** **Given** two build arguments referencing App env entries with
  `fromEnv`, **when** the Build is prepared, **then** the repository holds two Actions secrets `EW_<NAME>`, the
  workflow refers to them only as secret references, the Build lists **2 build values synced** by name, and no
  value appears in the workflow, the Builds tab, Activity or platform logs.
- **S5 — A database during the build.** **Given** a build service `postgres` and a build argument referencing a
  Postgres connection value, **when** the Build runs, **then** an ephemeral database starts beside the build, the
  reference resolves to it for that build only, and the App Work's real database is never contacted.
- **S6 — Verifying a proposal before merge.** **Given** the App Provisioner's pull request #12 into `main`,
  **when** it is opened or updated, **then** a Build runs for its head commit, is listed as **PR #12**, is marked
  **Not deployable — built from a pull request**, and its result reaches the provisioning's verification loop.
- **S7 — Superseded builds.** **Given** a running pull request build, **when** a newer commit is pushed to that
  pull request, **then** the running build is cancelled within 60 seconds as **Cancelled — superseded by a newer
  commit**. **Given** instead a running `main` build and two more commits on `main`, **then** the running build
  continues, only the newest waiting commit builds next, and the skipped one shows the same superseded reason.
- **S8 — Build status on the Overview.** **Given** an App Work with Builds, **when** the owner opens its Overview,
  **then** a **Latest build** card shows status, commit, age and duration of the newest tracked-branch Build, and
  the newest deployable Build when they differ.
- **S9 — The cost receipt.** **Given** a 23-minute Build on a GitHub-hosted runner in a public repository, **when**
  it completes, **then** its Activity entry links a receipt **"23 runner minutes · GitHub-hosted, public repository
  · paid by your GitHub account (free for public repositories on standard runners)"** and no credits are charged.
- **S10 — Pulling a private image.** **Given** an App Work on a private copy, **when** the owner deploys to **Your
  cluster**, **then** Deploy is blocked with **"This image is private. Add a read-only pull token so your cluster
  can download it."**; the dialog rejects a token that can do more than read packages, confirms it can read this
  image, stores it encrypted and never shows it again.
- **S11 — Verification inside the runner.** **Given** the App Provisioner verifies a proposal on an App Work whose
  deploy target is **None**, **when** its verification Build succeeds, **then** the same runner starts the image with
  throwaway dependency containers, runs the App spec's `pre-deploy` and `first-deploy` jobs and its smoke tests, and
  reports each job result, whether every component became ready, and each smoke result on the Build within the
  30-minute verification limit; the throwaway values it used are never stored anywhere.
- **S30 — App checks on a pull request.** **Given** an App spec with checks `type-check` (required) and `lint`
  (`required: false`), **when** an agent opens a pull request into `main` from a branch of the same repository,
  **then** the pull request shows two check runs, **Ever Works check: type-check** and **Ever Works check: lint**,
  each with its own result and log; a failing `lint` is reported as failed but does not fail the workflow run; the
  pull request's Build keeps its own status whatever the checks report.
- **S31 — Checks without a build.** **Given** `build.strategy: image` and one declared check, **when** the App spec is
  applied, **then** the build workflow is written with only the checks, pull requests show **Ever Works check:
  {name}**, and no Build is recorded.
- **S32 — A value no human has reviewed stays out of the run.** **Given** an App Work with one build value and a pull
  request opened by an agent from a branch of the same repository whose `Dockerfile` prints every build argument, **when**
  that pull request's Build runs, **then** the build receives the throwaway marker and never the stored value (the value
  appears in no log, no build argument and no published layer), the canary sink receives nothing, and the Build is
  **Not deployable — built from a pull request** exactly as before. **Given** the same App Work's verification of that
  proposal, **then** a prompted value is delivered only when the change touches no build-affecting file or the owner
  approved it, and otherwise the Build detail says **"Owner approval is needed before prompted values are used for this
  verification."** with **Review the change**.

### 3.2 Unhappy paths

- **S12 — Out of memory.** **Given** a build killed with exit code 137, **then** the Build shows **Failed — Ran out
  of memory**, the suggestion **"Raise build.resources.memory (now 7Gi) or lower the build's heap size. On this
  runner a build can use at most 14 GiB."**, and at most 20 redacted log lines.
- **S13 — A required build value is not set.** **Given** a build argument referencing a required prompted value
  nobody set, **when** a Build would start, **then** it is **Blocked — Waiting for 1 build value: `LICENSE_KEY`**
  with **Set it**; a push-triggered run that starts anyway fails in its first step in under 1 minute.
- **S14 — The Dockerfile fails.** **Then** the Build shows **Failed — The Dockerfile failed at step 7 of 14**, the
  step's command truncated to 120 characters, and the redacted lines that preceded the failure.
- **S15 — Actions is off.** **Given** Actions disabled on the repository, **then** Builds are **Blocked — GitHub
  Actions is turned off for this repository**, with **Turn it on** (enabling only the Ever Works workflow) for
  members who can, and the reason for those who cannot.
- **S16 — The workflow was edited by hand.** **Given** a person changed the workflow file, **when** the `build`
  block changes, **then** the file is not overwritten; a pull request carries the regenerated version and the tab
  warns **"The build workflow was edited by hand. Review the pull request to keep builds in sync with the App
  spec."**
- **S17 — The runner is too small.** **Given** a private copy asking for `build.resources.memory: 12Gi` and no larger
  runner configured, **then** Builds are **Blocked — This build needs 12 GiB but the runner for private repositories
  allows 5 GiB** with **Use a larger runner**. **Given instead** a private copy whose App spec leaves
  `build.resources` out, **then** the Build runs on the standard private runner with no block, and if it runs out of
  memory the panel reads **"Raise build.resources.memory (now 5Gi) or lower the build's heap size. On this runner a
  build can use at most 5 GiB."** with **Use a larger runner**.
- **S18 — Events never arrive.** **Given** a Build whose event deliveries are lost, **then** the platform asks GitHub
  directly and the tab reflects each status change within 3 minutes. **Given** a platform that never received a single
  delivery for a workflow — no webhook is installed, or it was refused — **when** a push reaches the tracked branch,
  **then** the push is still recorded as a Build within 3 minutes and its terminal status is visible within 3 minutes of
  it ending: discovery does not depend on any event arriving.
- **S19 — A secret inside the image.** **Given** a Dockerfile that copies a secret build value into the final
  image's metadata, **then** nothing is pushed, the Build shows **Failed — A secret would have been published inside
  the image: `SIGNING_KEY`** with advice to use it only in an earlier stage, and the value is never printed.
- **S20 — Timeout.** **Given** `timeoutMinutes: 60`, **then** at 60 minutes the build stops and shows **Failed — Took
  longer than 60 minutes**.
- **S21 — Nothing to build.** **Given** `build.strategy: image` or `none`, **then** the tab reads **"This app runs a
  published image — there is nothing to build."** (showing the pinned image) or **"This App Work has nothing to
  build."**; no Build exists, and the workflow is written only when the App spec declares checks (S31).
- **S22 — A strategy this provider cannot build.** **Given** `build.strategy: auto` (zero-config: build without a
  Dockerfile) in Wave 1, **then** no Build runs and the tab reads **"This build strategy isn't available yet. Add a
  Dockerfile and use the `dockerfile` strategy."**
- **S23 — Someone else's App Work.** **Given** another account's Build id, **when** it is read, rebuilt or cancelled,
  **then** the answer is **not found** every time.

### 3.3 Race and permission edges

- **S24 — A build value changes mid-build.** **Given** a running Build, **when** a member rotates one of its build
  values, **then** the Build finishes with the old value, is marked **Not deployable — built with older build
  values**, and the next Build uses the new one.
- **S25 — An invalid App spec at the commit.** **Given** a push whose `.works/works.yml` has errors, **when** its Build
  succeeds from the last valid workflow, **then** it is marked **Not deployable — the App spec at this commit has
  errors**.
- **S26 — A viewer.** **Given** view-only access, **then** every Build and logs link is visible; **Rebuild**,
  **Cancel** and **Add pull token** are disabled with **"You need edit access to do this."**
- **S27 — A pull request from outside.** **Given** a stranger's pull request from their own fork into the user's
  public fork, **then** no build value is exposed, nothing is pushed, and no Build is recorded.

### 3.4 Wave 3 — builds for Ever Works Apps

- **S28 — Managed build.** **Given** an App Work on **Ever Works Apps**, **when** a Build runs, **then** it shows runner
  **Ever Works Apps builder**, scan counts such as **"0 critical · 2 high · 11 medium"** and **Signed**; the hosting
  tier refuses any image of that App Work that is unsigned or signed by another identity.
- **S29 — Blocked network access.** **Given** a managed build reaching a host outside its allowlist, **then** it fails
  with **Network access was blocked** and lists up to 10 blocked host names.

---

## 4. Functional requirements

Every threshold below is a number on purpose.

### 4.1 Build providers

- **FR-1.** Every Build is performed by a build provider resolved per App Work through the platform's normal plugin
  resolution; no surface names a provider directly.
- **FR-2.** Wave 1 ships one provider, **GitHub Actions**, for deploy targets **None** and **Your cluster** (and, in
  Wave 2, verified App Blueprints on **Ever Works Apps**). Wave 3 adds the **Ever Works Apps builder**, which then
  becomes the only provider allowed for the managed tier.
- **FR-3.** `dockerfile` builds; `image` and `none` produce no Build (S21); `auto` — the build provider detects the
  language and framework and builds without a Dockerfile — is refused by the GitHub Actions provider in Wave 1 (S22).
  Which builder implements `auto` is internal to the provider that supports it; no surface names one.
- **FR-4.** No Build runs on infrastructure that hosts Ever Works itself or any production product.

### 4.2 The build workflow file

- **FR-5.** The GitHub Actions provider writes exactly one file, `.github/workflows/ever-works-build.yml`, and changes
  no other file in the repository.
- **FR-6.** Generation is deterministic: the same `build` block and provider settings produce a byte-identical file.
  Its first 3 lines are a comment saying it is generated, that hand edits are proposed over rather than silently
  kept, and the fingerprint of its inputs.
- **FR-7.** The file is **committed directly** to the tracked branch when the App Work created the repository (Fork,
  Private copy) **and** the branch has no rule requiring reviews or status checks; otherwise it is proposed as one
  pull request. A linked repository always receives a pull request. At most one such pull request is open per App
  Work; a newer version updates it.
- **FR-8.** After writing, the file is read back and compared byte for byte; a mismatch is retried once, then
  reported as **"The build workflow could not be written."**
- **FR-9.** A file that differs from the last version the platform wrote is treated as edited by hand (S16).
- **FR-10.** The workflow contains no App env value: only literal build arguments already written in the App spec,
  and references to `EW_` secrets.
- **FR-11.** Triggers: push to the tracked branch; pull request into it from the same repository (opened, updated,
  reopened); a manual dispatch carrying the Build id. Pull requests from other repositories never run a job that can
  read secrets or push images (S27).
- **FR-12.** The workflow requests only read access to contents and write access to packages, plus the attestation
  permissions when attestations are on (FR-30).
- **FR-13.** Every third-party action is pinned to a full 40-character commit hash.
- **FR-14.** A newer commit on a pull request cancels that pull request's running build. On the tracked branch a
  running build is never cancelled; at most one build waits, and a newer commit replaces the waiting one (S7).
- **FR-15.** Inherited upstream workflows stay disabled (APW-02); only this workflow is enabled. With Actions
  disabled for the repository, Builds are **Blocked** (S15).

### 4.3 Build values and build services

- **FR-16.** Every `fromEnv` build argument is delivered as an Actions secret named `EW_` + the env name, synchronised
  (a) before every Build the platform starts, (b) within 60 seconds of a build-phase value change, (c) whenever the
  `build` block changes.
- **FR-17.** At most 50 build values per App Work. A value over 48 KB is refused with **"`<NAME>` is too large to pass
  to a build (48 KB maximum)."** When the repository has no room for more secrets, Builds are **Blocked — The
  repository has no room for more secrets**.
- **FR-18.** Only `EW_` secrets the platform wrote are ever removed, and only once no build argument references them.
- **FR-19.** A missing required build-phase value blocks the Build before anything runs, naming every missing value;
  the workflow's first step re-checks presence and fails in under 1 minute if one is empty.
- **FR-20.** Build services live for one build and are reachable only from it. During a Build, a reference to a
  dependency output of the same name resolves to the build service. A build never receives live dependency outputs
  or runtime-only values.
- **FR-21.** Before anything is pushed, the finished image's metadata is checked for every secret build value of 8
  characters or more; a match fails the Build (S19) without printing the value.

### 4.4 Runners, cache and resources

- **FR-22.** Public repositories use GitHub's standard hosted runner for public repositories (4 vCPU, 16 GB at the
  time of writing); private repositories use the standard private runner (2 vCPU, 7 GB) unless a **larger runner
  label** is set in the App Work's build settings (with its memory declared there).
- **FR-23.** `build.resources.memory` above the runner's memory minus 2 GiB blocks the Build, stating both numbers
  (S17). `build.resources.cpu` above the runner's vCPU count is a warning only. An App spec that leaves
  `build.resources.memory` out uses the runner's maximum (runner memory − 2 GiB) and is **never** blocked by this rule:
  the field asks for a specific amount, it does not set a ceiling.
- **FR-24.** The job timeout equals `build.resources.timeoutMinutes` (5–180, default 60).
- **FR-25.** Checkout fetches a single commit. The runner frees preinstalled tool directories before building unless
  **Reclaim runner disk** is off (default on).
- **FR-26.** Layer cache lives beside the image in the owner's registry. Tracked-branch builds read and write it; pull
  request builds only read it, so a pull request can never poison the cache deployable builds use.

### 4.5 Images and deployability

- **FR-27.** The image is `ghcr.io/<repository owner>/<repository name>/ever-works-app`, lower-cased.
- **FR-28.** Tags: `sha-<40-character commit>` always; `branch-<branch slug>` for tracked-branch builds; `pr-<number>`
  for pull request builds. `latest` is never pushed.
- **FR-29.** A digest is accepted only when well-formed and — whenever the registry can be read — equal to the digest
  the registry reports for the commit tag; otherwise the Build fails with **"The pushed image could not be
  confirmed."**
- **FR-30.** SBOM and provenance attestations are off by default and can be enabled per App Work for public
  repositories.
- **FR-31.** A Build is **deployable** only when it succeeded; was built from the tracked branch by a push or Rebuild;
  its commit's App spec is valid; its build values were current when it started; its secret check passed; its digest
  was confirmed (and in Wave 3, FR-58 allows it). Each non-deployable Build states which condition failed.
- **FR-32.** Deployments reference a Build's digest, never a tag.

### 4.6 Status, reporting and diagnosis

- **FR-33.** Builds are numbered per App Work from **#1** in the order first recorded. Exactly one status: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `blocked` (nothing ran; reason
  named). Exactly one trigger: **Push**, **Pull request**, **Manual**, **Verification**.
- **FR-34.** A push-started Build is recorded the first time the platform hears of it, by event or by polling. Runs of
  any other workflow are ignored.
- **FR-35.** A status change delivered as a repository event is visible within 10 seconds. A Build not finished and
  not heard from for 90 seconds is polled, so every change is visible within 3 minutes.
- **FR-36.** A Build unobservable for its timeout plus 30 minutes becomes **Failed — Lost track of this build**.
- **FR-37.** Failure classes form a closed set, each with its own title and suggestion (§6.3).
- **FR-38.** The failure excerpt holds at most 20 lines of at most 300 characters from the last 2 MiB of the failing
  job's log, after every known App env value of this App Work is replaced with `***` and secret-shaped strings are
  masked. Logs stay with the provider.
- **FR-39.** Agents working on the App Work receive the class, suggestion, excerpt and logs link in the same words the
  user sees, marked as untrusted output.
- **FR-40.** Activity records Build queued, started, succeeded, failed and cancelled with Build id, commit, trigger and
  failure class — never a value or a log line.

### 4.7 Rebuild and cancel

- **FR-41.** **Rebuild** builds the tracked branch head, or — from a Build's detail — that commit while it is reachable
  from the tracked branch. It returns within 2 seconds.
- **FR-42.** A Rebuild for a commit that has a queued, blocked or running Build created less than 10 seconds ago returns
  that Build.
- **FR-43.** At most 10 Rebuilds per App Work per hour; the 11th answers **"Too many rebuilds — try again in {minutes}
  minutes."**
- **FR-44.** **Cancel** works on queued and running Builds and takes effect within 60 seconds.

### 4.8 Cost receipts

- **FR-45.** Every Build that ran records a receipt: billable runner minutes (each job rounded up to the minute), runner
  class, repository visibility and payer (**your GitHub account**), linked from its Activity entry.
- **FR-46.** GitHub-hosted builds never charge Ever Works credits; a money amount the platform cannot know is shown as
  unknown, never as zero.
- **FR-47.** Wave 3 managed builds record build compute minutes on the workspace's usage meters.

### 4.9 Image pull credentials

- **FR-48.** After the first succeeded Build the platform records whether the image is public or private. For a public
  repository with a private image, the tab explains how to make the package public and offers **Check again**.
- **FR-49.** A private image needs a per-App-Work **pull token**, accepted only when it grants nothing beyond reading
  packages and can read this image; stored encrypted, never returned.
- **FR-50.** The pull credential is never the user's Git connection, a sign-in token, or any token belonging to an Ever
  Works organization.
- **FR-51.** A pull token expiring within 14 days shows a warning on the Builds and Deploy tabs.

### 4.10 Verification inside the runner (for the App Provisioner)

- **FR-52.** A **Verification** Build carries a verification plan (components to start, throwaway dependency kinds,
  jobs, smoke tests). After a successful image build — in the same run, or reusing the confirmed image of an earlier
  succeeded Build of the same commit, so nothing is built twice — the runner starts the image and dependency
  containers on its private network, runs the jobs and smoke tests, and reports each smoke result on the Build. **When
  the App Work has no build workflow yet**, a dispatch-only version of the file is committed or proposed first, exactly
  as FR-7 delivers it; a verification therefore never needs a file that only an applied App spec could produce, and it
  dispatches on the tracked branch with the proposal's commit. A pending proposal blocks the Verification Build as
  **Waiting for the build workflow to be merged**, and a verification pushes no image and no tag (FR-54).
- **FR-53.** Verification is limited to 30 minutes and 12 GiB of summed memory. Generated values are freshly
  generated inside the runner, derived values point at the runner's throwaway containers, and both are discarded with
  the runner; a prompted value is used only when the owner has already set it, is delivered for that run alone and is
  removed from the repository when the run ends. No value is written back to the App Work.
- **FR-54.** A Verification Build is never deployable and never writes the cache.

### 4.11 Wave 3 — the Ever Works Apps builder

- **FR-55.** Each managed Build runs as its own ephemeral workload in the isolated hosting zone — never privileged,
  with a sandboxed runtime and user namespaces — and is removed at most 10 minutes after it ends.
- **FR-56.** Network access during a managed build is denied except to the source repository host and the base-image
  and package registries on the operator's allowlist; blocked hosts are reported (S29).
- **FR-57.** Default caps: 4 vCPU, 12 GiB memory, 30 GiB ephemeral disk, 60 minutes — these defaults apply when the App
  spec leaves the corresponding `build.resources` value out, so an App spec with no `build.resources` at all still
  builds on the managed tier rather than being blocked; operator plan maximums never exceed
  16 vCPU, 64 GiB and 180 minutes. At most 1 running managed Build per App Work and 3 per account. Source is fetched
  with a read-only token for one repository valid ≤ 1 hour; the push token covers one repository in a per-tenant
  registry namespace and is valid ≤ timeout + 60 minutes. No platform or production pull credential can read a tenant
  namespace.
- **FR-58.** Every managed image is scanned; the Build shows counts per severity. By default a **critical** finding with
  a fixed version available makes the Build not deployable.
- **FR-59.** Every managed image is signed by the builder's identity; the hosting tier refuses an App Work image that
  is unsigned or signed by any other identity.

### 4.12 Scope, permissions, limits and observability

- **FR-60.** Reading Builds needs view access; Rebuild, Cancel, build settings and the pull token need edit access.
- **FR-61.** Every read and write is scoped to the caller's account; another account's Build is **not found**.
- **FR-62.** The list is paginated 20 per page (at most 100), newest first, filterable by status, trigger, branch and
  pull request.
- **FR-63.** Every user-visible string is translatable and never concatenated from fragments.
- **FR-64.** Telemetry holds counts and identifiers only: Builds by status, trigger, failure class and duration bucket;
  blocked reasons; rebuilds; pull-token validations.

### 4.13 App checks on pull requests

- **FR-65.** When the App spec declares checks, the build workflow runs them on every pull request into the tracked
  branch from the same repository: one job per check, each reported as its own check run named exactly
  `Ever Works check: {name}`. Pull requests from other repositories run no check.
- **FR-66.** A check job can only read the repository: it receives no build value and no other secret, pushes nothing,
  and never reads or writes the image cache.
- **FR-67.** A check runs its command exactly as written in the App spec, as a shell script, with no part of the command
  interpreted by the workflow engine. Its time limit is its `timeoutSeconds` rounded up to whole minutes. At most 5 checks
  run at the same time and one check's failure never cancels another.
- **FR-68.** A required check fails its check run on a non-zero exit. A check with `required: false` reports its own result
  but never fails the workflow run.
- **FR-69.** Checks and the image build are independent: a check's result never changes a Build's status or deployability,
  and a failed image build never skips a check. The runner minutes of check jobs are shown on the pull request Build's
  receipt as a separate line.
- **FR-70.** Checks are written for every build strategy, including `image` and `none`, where the workflow holds only the
  checks (S31). Removing every check from the App spec removes the checks from the workflow on its next preparation.

### 4.14 Restricted build values on pull requests and verifications

- **FR-71.** A Build started by a pull request from the App Work's own repository receives **no stored build value**:
  every `fromEnv` build argument is passed a fixed throwaway marker instead of the value, a value that belongs to a
  build service still resolves to that run's own throwaway service, prompted values are not synchronised for a pull
  request at all, and the workflow's missing-value check does not run, because a pull request legitimately has no stored
  value. Nothing else about the pull-request Build changes: it still builds the pull-request head, is still **Not
  deployable — built from a pull request**, and still writes no cache and pushes no image. Builds on the tracked branch
  (push and Rebuild) keep using the stored values exactly as FR-16 describes. An owner who needs a stored value on a
  pull request may switch this off per App Work, and the Builds tab then states plainly that a value is handed to
  whatever code the pull request contains.
- **FR-72.** A **Verification** Build never receives a stored build value either: its `fromEnv` arguments come from the
  value-free verification recipe (FR-53), and the owner-set prompted values are delivered only when the change under
  verification touches no build-affecting file — the Dockerfile, `.dockerignore`, `package.json`, lockfiles, `Makefile`,
  or anything under `build/`, `scripts/` or `.github/workflows/` — or the owner approved that change. Otherwise the
  verification runs on generated and derived values alone and says so, with a **Review the change** action. The
  honeypot assertion is FR-71's: a build value whose Dockerfile reads it on an agent-authored pull request must leave
  the canary sink empty (ACC-05-31).

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity              | Today                                                        | This epic adds                                                                              |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **App Work**        | A Work of kind `app` with a Work Repository and an App spec. | Builds, a **Builds** tab, a **Latest build** card, build settings, a pull token.            |
| **Deployment**      | One deploy of a Work.                                        | Nothing here; APW-06 links each App Work Deployment to the Build whose digest it runs.      |
| **Activity**        | The account's event log.                                     | The `app.build.*` events.                                                                   |
| **Usage receipt**   | Per-call usage rows recording who paid.                      | One row per Build for runner minutes.                                                       |
| **Plugin settings** | Per-scope settings, secret fields encrypted.                 | Per-App-Work build settings (larger runner, disk reclaim, attestations) and the pull token. |

### 5.2 New

| Entity    | Why it must exist                                                                                                                                                                                                     | Shape                                                                                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Build** | A Deployment must name exactly what it runs, a failure must be diagnosable afterwards, and the evolve loop must know when a merge became an image. No record holds a commit → digest relation, a diagnosis or a cost. | One row per run attempt of one App Work: commit, branch, pull request, trigger, provider, status, blocked reason, failure class and excerpt, digest and tags, deployable flag and reason, duration, runner minutes, logs link. Derived state (Constitution III). |

> **No other new noun.** The workflow is a file, a build value is an App env entry (APW-07), a pull token is a build
> setting, a receipt is a usage row.

### 5.3 States and transitions

```
 Rebuild · push · pull request · verification
        │
        ├── preconditions fail ──► blocked (reason) ── cause fixed, retried ──► queued
        ▼
     queued ──► running ──► succeeded ── deployable? ── yes ──► offered to Deployment (APW-06)
        │          │                                  └─ no ──► kept, reason shown
        │          ├──► failed (class)
        │          └──► cancelled (by a person · superseded)
        └──► cancelled (superseded while waiting)
     unobservable for timeout + 30 min ──► failed (lost)
```

---

## 6. UX

All copy below is final English copy, ready to be keyed for translation.

### 6.1 The Builds tab — loaded

```
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║  Builds                                               [ Build settings ] [ Rebuild ]   ║
║  Built on GitHub-hosted runners in acme/cal-diy · image ghcr.io/acme/cal-diy/…         ║
║  Status ▾ All   Trigger ▾ All   Branch ▾ main                                          ║
╟───────────────────────────────────────────────────────────────────────────────────────╢
║  ● Running    Push    main          a1b2c3d  "Add booking reminder"   4m 10s   [Cancel]║
║  ✓ Succeeded  Manual  main          9f8e7d6  "Bump next"             18m 42s  sha256:4f1c…║
║  ✗ Failed     Push    main          5c4b3a2  "Upgrade prisma"        11m 03s  Ran out of memory║
║  ✓ Succeeded  PR #12  ew/provision  77aa1bc                          17m 55s  sha256:0b9e…║
║               Not deployable — built from a pull request                              ║
║  ⊘ Blocked    Push    main          3d2c1b0  Waiting for 1 build value: LICENSE_KEY [Set it]║
║                                        Showing 1–20 of 64   [ Previous ] [ Next ]     ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝
```

| Element                | Copy                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subtitle               | `Built on GitHub-hosted runners in {repository} · image {imageRepository}`                                                                                                                                                                                         |
| Status / trigger       | `Queued` · `Running` · `Succeeded` · `Failed` · `Cancelled` · `Blocked` / `Push` · `PR #{number}` · `Manual` · `Verification`                                                                                                                                      |
| Not-deployable reasons | `Built from a pull request` · `The App spec at this commit has errors` · `Built with older build values` · `The secret check did not pass` · `The pushed image could not be confirmed` · `A critical vulnerability has a fix available` · `Built for verification` |
| Row actions            | `Cancel` · `Rebuild this commit` · `View logs on GitHub`                                                                                                                                                                                                           |
| Receipt                | `{minutes} runner minutes · paid by your GitHub account` · `{checksMinutes} of them ran App checks` (pull request Builds with checks)                                                                                                                              |
| Pagination             | `Showing {start}–{end} of {total}` · `Previous` · `Next`                                                                                                                                                                                                           |

### 6.2 Build detail (drawer)

```
╔═════════════════════════════════════════════════════════════════════════════╗
║  Build #14 · 9f8e7d6 · Succeeded                                       [×]  ║
║  Trigger      Manual — by Maya, 2 hours ago                                 ║
║  Commit       9f8e7d6 "Bump next" (main)                        [ Open ↗ ]  ║
║  Runner       GitHub-hosted · public repository · 4 vCPU / 16 GB            ║
║  Duration     18m 42s (queued 12s)                                          ║
║  Image        ghcr.io/acme/cal-diy/ever-works-app@sha256:4f1c…    [ Copy ]  ║
║  Tags         sha-9f8e7d6…  branch-main                                     ║
║  Deployable   Yes                                                           ║
║  Build values 2 synced: DATABASE_URL, CALENDSO_ENCRYPTION_KEY               ║
║  Receipt      19 runner minutes · paid by your GitHub account               ║
║                                     [ View logs on GitHub ] [ Rebuild ]      ║
╚═════════════════════════════════════════════════════════════════════════════╝
```

### 6.3 Failure panel — every class, exact copy

| Class                    | Title                                                         | Suggestion                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| outOfMemory              | `Ran out of memory`                                           | `Raise build.resources.memory (now {memory}) or lower the build's heap size. On this runner a build can use at most {max}.`                                         |
| diskFull                 | `Ran out of disk space`                                       | `Turn on "Reclaim runner disk" in build settings, or shrink the build context with a .dockerignore file.`                                                           |
| dockerfileError          | `The Dockerfile failed at step {step} of {total}`             | `The failing step was: {command}. Fix it in {dockerfile} and push, or ask an agent to fix it.`                                                                      |
| dependencyDownloadFailed | `Couldn't download dependencies`                              | `A package or base image registry didn't answer. Rebuild in a few minutes; if it keeps failing, pin the versions you depend on.`                                    |
| registryPushDenied       | `Couldn't push the image`                                     | `Allow workflows in this repository to write packages (Settings ▸ Actions ▸ General ▸ Workflow permissions), then rebuild.`                                         |
| missingBuildValue        | `A build value is missing: {names}`                           | `Set it in Settings ▸ Environment, then rebuild.`                                                                                                                   |
| secretInImage            | `A secret would have been published inside the image: {name}` | `Use this value only in an earlier build stage, or pass it as a build secret mount. Nothing was pushed.`                                                            |
| timeout                  | `Took longer than {minutes} minutes`                          | `Raise build.resources.timeoutMinutes (maximum 180) or speed the build up with caching.`                                                                            |
| workflowInvalid          | `The workflow file is invalid`                                | `GitHub can't run the build workflow. Review the open pull request from Ever Works to restore it.`                                                                  |
| digestMismatch           | `The pushed image could not be confirmed`                     | `The registry reported a different image than the build did. Rebuild; nothing unconfirmed will be deployed.`                                                        |
| verificationFailed       | `The app didn't pass its smoke tests`                         | `{failed} of {total} smoke tests failed. See the results below.`                                                                                                    |
| egressBlocked            | `Network access was blocked`                                  | `The build tried to reach {hosts}, which aren't on the builder's allowed list. Get what you need from your source repository or an allowed registry, then rebuild.` |
| lost                     | `Lost track of this build`                                    | `GitHub stopped answering about this build. Check it on GitHub.`                                                                                                    |
| unknown                  | `Something else went wrong`                                   | `Open the logs on GitHub, or ask an agent to look.`                                                                                                                 |

`egressBlocked` is a Wave 3 class — it never occurs on GitHub-hosted runners — but its copy ships in P1 with the other 13
because the class list is P1, so no pass over the 14 leaves a hole. `{hosts}` is at most 10 names.

Every failure panel offers **Ask an agent to fix this**, handing class, suggestion, excerpt and logs link to the
evolve loop (APW-08) through `POST /api/works/:id/evolve` with the failed Build's `buildId`; the action is hidden when
APW-08 is absent or the viewer lacks edit access.

### 6.4 Blocked states, Overview card, empty, loading, error

```
  ⊘ Waiting for the build workflow to be merged.                          [ Review pull request ↗ ]
  ⊘ GitHub Actions is turned off for this repository.                     [ Turn it on ]
  ⊘ Waiting for {count} build value(s): {names}                           [ Set it ]
  ⊘ This build needs {needed} but the runner for {visibility} repositories allows {max}.  [ Use a larger runner ]
  ⊘ The build workflow was edited by hand.                                [ Review pull request ↗ ]
  ⊘ The repository has no room for more secrets.                          [ Open repository settings ↗ ]
  ⊘ Ever Works can't reach this repository with your GitHub connection.   [ Reconnect GitHub ]

  LATEST BUILD (Overview): "✓ Succeeded · main · 9f8e7d6 · 2h ago · 18m 42s" · "Deployable build: {same|commit}" [ Open Builds ]
  NO BUILDS: "No builds yet. The first build starts when the build workflow is in the repository."
  LOADING: 5 skeleton rows, no layout shift.   LOAD ERROR: "Builds could not be loaded. Try refreshing the page."
```

Every blocked reason has its own copy and its own action — the seven above plus:

| Reason                              | Copy                                                                                                                       | Action             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `workflowWriteFailed`               | `Ever Works couldn't write the build workflow to the repository.` · `A rule on this repository refuses the change.`        | `Rebuild`          |
| `tooManyBuildValues`                | `This build uses {count} build values; at most 50 are allowed.`                                                            | `Open Environment` |
| `buildValueTooLarge`                | `{name} is too large to pass to a build (48 KB maximum).`                                                                  | `Open Environment` |
| `buildServicePortRequired`          | `The build service {service} needs a port: Ever Works doesn't know which port "{image}" listens on.`                       | `Open Environment` |
| `verificationDependencyUnsupported` | `A verification can't start {kind} yet. The check runs on the cluster instead.`                                            | —                  |
| `strategyNotSupported`              | `GitHub-hosted runners can't build with the "{strategy}" strategy. Add a Dockerfile and set build.strategy to dockerfile.` | —                  |
| `specInvalid`                       | `The App spec at this commit has errors.`                                                                                  | —                  |
| `repositoryUnavailable`             | `{repository} is archived, deleted or no longer available to your GitHub connection.`                                      | —                  |
| `managedConcurrencyLimit`           | `Waiting for other builds: at most {perWork} per app and {perAccount} per account run at once.`                            | —                  |
| `buildValueNameReserved`            | `{name} is reserved by Ever Works and can't be passed to a build. Rename the environment entry.`                           | `Open Environment` |

### 6.5 Pull token dialog

```
╔══════════════════════════════════════════════════════════════════════╗
║  Add a pull token                                               [×]  ║
║  This image is private. Your cluster needs a token that can only     ║
║  read packages to download it.                                       ║
║  1. Create a classic token with only "read:packages" checked.        ║
║  2. Paste it here.                                                   ║
║  Token  [ ••••••••••••••••••••••••••••••••            ]              ║
║                                        [ Cancel ]  [ Check and save ]║
╚══════════════════════════════════════════════════════════════════════╝
  Errors: "This token can do more than read packages. Create one with only read:packages."
          "This is a fine-grained token. Create a classic token with only read:packages checked."
          "This token can't read {imageRepository}."
          "This image is already public — no token is needed."
  Saved:  "Pull token saved. It expires on {date}." · "Pull token saved. It doesn't expire."
  Waiting:"There is no finished build yet. Add a pull token after the first successful build."
  Public: "This image is private. Make the package public in GitHub, then check again."   [ Check again ]
  Viewer: "You need edit access to do this."
```

The **Check again** action re-reads the registry and, when the package has become public, clears the token state without
ever displaying a stored token.

### 6.6 Keyboard affordances

| Where         | Key     | Action                                                        |
| ------------- | ------- | ------------------------------------------------------------- |
| Builds list   | `↑` `↓` | Move between rows; `Enter` opens the detail drawer.           |
| Builds list   | `R`     | Rebuild (edit access only; not while a text field has focus). |
| Detail drawer | `Esc`   | Close; focus returns to the row that opened it.               |
| Detail drawer | `C`     | Copy the image reference.                                     |

Status is text plus an icon, never colour alone; live status changes are announced politely.

---

## 7. Out of scope

- **Builds for platform-template Works** — their workflows and deploy paths are untouched.
- **Multi-architecture images** — `linux/amd64` only in Wave 1.
- **The `auto` strategy on GitHub-hosted runners** (open question) and **build matrices** (one App spec, one image;
  the checks of FR-65 run as several jobs, but they build nothing).
- **Running App checks anywhere but the repository's own CI** — sandboxed checks for Tasks on Fleet nodes are APW-08's.
- **Preview Deployments per pull request** — pull request builds exist for verification; deploying them is APW-06 P3.
- **Copying logs into Ever Works** — only the classified excerpt is kept.
- **Provisioning self-hosted runners** — a larger-runner label may point at one; the platform manages none.
- **Registry retention** — deleting old images or cache stays the owner's choice.

---

## 8. Acceptance criteria

- [ ] **ACC-05-01** — Applying an App spec with `strategy: dockerfile` on an unprotected fork commits exactly one file,
      `.github/workflows/ever-works-build.yml`, within 60 seconds; the file list differs by exactly that path.
- [ ] **ACC-05-02** — On a branch requiring reviews the same apply opens one pull request; applying twice more still
      leaves one open pull request.
- [ ] **ACC-05-03** — Generating the workflow twice from the same inputs yields byte-identical files.
- [ ] **ACC-05-04** — A hand-edited workflow is never overwritten; a `build` block change opens a pull request.
- [ ] **ACC-05-05** — The workflow contains no stored App env value of the fixture App Work, and every third-party
      action is pinned to a 40-character hash.
- [ ] **ACC-05-06** — A pull request from another repository runs no job with secret access and pushes no image.
- [ ] **ACC-05-07** — A push to the tracked branch yields a `succeeded` Build with a confirmed digest and tags
      `sha-<40>` and `branch-<slug>`; no `latest` tag exists.
- [ ] **ACC-05-08** — Rebuild returns in under 2 seconds; two clicks within 10 seconds produce one Build; the 11th
      Rebuild in an hour is refused with the stated copy.
- [ ] **ACC-05-09** — Cancel on a running Build reaches `cancelled` within 60 seconds.
- [ ] **ACC-05-10** — Two quick commits on a pull request cancel the older build; three quick commits on the tracked
      branch never cancel the running build and build only the newest waiting commit.
- [ ] **ACC-05-11** — With event delivery disabled **and with no repository webhook installed**, a push to the tracked
      branch is still recorded as a Build and its terminal status appears within 3 minutes.
- [ ] **ACC-05-12** — The fixture app's build migrates an ephemeral Postgres and succeeds; no connection reaches the App
      Work's real database.
- [ ] **ACC-05-13** — `EW_` secrets exist before a platform-started Build dispatches and are re-synced within 60 seconds
      of a build-phase value change.
- [ ] **ACC-05-14** — A missing required build value blocks the Build naming it; a push-started run fails in its first
      step in under 1 minute.
- [ ] **ACC-05-15** — A fixture Dockerfile copying a secret build value into the final image fails with
      `secretInImage`, pushes nothing, and the value appears in no log, response or Activity row.
- [ ] **ACC-05-16** — A Build started before a build value rotated is marked not deployable with the stated reason.
- [ ] **ACC-05-17** — Fixture failures classify as `outOfMemory` (exit 137), `dockerfileError` (step and total),
      `missingBuildValue`, `timeout` and `diskFull`, each with its §6.3 copy.
- [ ] **ACC-05-18** — The excerpt has at most 20 lines of at most 300 characters and shows `***` wherever a stored App
      env value appeared in the log.
- [ ] **ACC-05-19** — The agent handling a failed Build receives the same class, suggestion and excerpt the user sees.
- [ ] **ACC-05-20** — Every Build that ran has a receipt with rounded runner minutes and payer "your GitHub account";
      no credits were charged.
- [ ] **ACC-05-21** — A private image without a pull token blocks Deploy with the stated copy; a token with any scope
      besides `read:packages` is refused; a valid token is saved and returned by no endpoint.
- [ ] **ACC-05-22** — A private-repository Build asking for 12Gi with no larger runner is blocked with both numbers.
- [ ] **ACC-05-23** — A Verification Build with a plan runs the fixture's smoke tests in the runner within 30 minutes,
      reports each result, and is never deployable.
- [ ] **ACC-05-24** — Another account's Build id answers not found on read, Rebuild and Cancel; a viewer sees Rebuild,
      Cancel and pull token disabled with the stated reason.
- [ ] **ACC-05-25** — Every visible string resolves through translation; tab, drawer and dialog pass an automated
      accessibility check with no new violations.
- [ ] **ACC-05-26** — _(Wave 3)_ A managed Build runs with no privileged container, is removed within 10 minutes of
      ending, and shows scan counts and **Signed**.
- [ ] **ACC-05-27** — _(Wave 3)_ A managed build reaching a non-allowlisted host fails listing the blocked host.
- [ ] **ACC-05-28** — _(Wave 3)_ The hosting tier refuses an unsigned image and an image signed by another identity.
- [ ] **ACC-05-29** — A same-repository pull request on an App spec with one required and one advisory check shows two
      check runs named `Ever Works check: {name}`; the check jobs grant only read access to contents and reference no
      secret; the advisory check's failure does not fail the workflow run; the pull request Build's status is unchanged
      by either result; a pull request from another repository runs no check.
- [ ] **ACC-05-30** — With `build.strategy: image` and one check, the written workflow contains only the checks and no
      Build is recorded; removing the check removes it from the workflow on the next preparation.
- [ ] **ACC-05-31** — A build value whose `Dockerfile` reads it is passed to a pull request from the App Work's own
      repository as a throwaway marker only: the stored value appears in no build argument, no log line, no published
      image layer and no Activity row, the workflow still references `secrets.EW_<NAME>` for the tracked-branch path
      only, and the canary sink receives nothing.
- [ ] **ACC-05-32** — A Verification Build delivers an owner-set prompted value only when the verified change touches no
      build-affecting file or the owner approved it; otherwise the Build detail shows the approval notice with **Review
      the change**, and the verification still completes on generated and derived values.

---

## 9. Open questions

- **[NEEDS CLARIFICATION: the `auto` strategy on GitHub-hosted runners.]** Wave 1 refuses it. _Default: the App
  Provisioner writes a Dockerfile instead; `auto` stays refused until a build provider supports it (which builder it
  uses is that provider's internal choice — Resolution R-13)._
- **[NEEDS CLARIFICATION: default package visibility.]** Whether a first push from a public repository's workflow
  creates a public or private package must be verified against GitHub before P1 ships; the pull-token flow covers
  both, but the default Builds-tab copy depends on it. **Either outcome is now handled without touching a scenario:**
  if the first push yields a private package, a public fork's Build cannot be confirmed anonymously, so it is
  `digestUnconfirmed` and not deployable until a token exists — the acceptance harness therefore carries an optional
  `APW_E2E_GHCR_PULL_TOKEN` secret and a **Make the package public** step for the fixture repository, either of which
  satisfies ACC-E2E-05/07/14, and the live probe records the observed default here once it is run.
- **[NEEDS CLARIFICATION: larger runners for private copies.]** They need an organization and are billed per minute.
  _Default: a label the owner configures, with its memory; no guided setup in P1._
- **[NEEDS CLARIFICATION: always propose the workflow as a pull request?]** Direct commits on repositories the App Work
  created start the first Build about 2 minutes sooner. _Default: direct commit per FR-7; a per-App-Work switch later._
- **[NEEDS CLARIFICATION: critical vulnerabilities on the managed tier.]** _Default: block deploys of images with a
  fixable critical finding (FR-58); the owner cannot override in Wave 3._
- **[NEEDS CLARIFICATION: build-minute caps for ordinary pushes.]** The App Provisioner caps its own runner minutes
  (240 per provisioning). _Default: no cap on pushes in P1; the receipt makes spend visible._
