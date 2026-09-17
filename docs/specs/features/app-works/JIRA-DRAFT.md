# App Works — Jira draft (program epic + one story per epic)

**Program:** [App Works](./README.md) (`app-works`) · **Status:** `Draft` · **Created:** 2026-09-17
**Nothing here has been filed.** No Jira ticket for this program exists; [TRACKER.md](./TRACKER.md) carries
`EW-TBD` for all thirteen epics. This file is the copy-pasteable body text, ready for the owner to file.
**Companion documents:** [README.md](./README.md) (§0 why, §4 waves, §5 epics) · [TRACKER.md](./TRACKER.md)
(status, merge order `:28-63`, the `EW-TBD` column `:14-26`, and §"Spec status criteria" `:65-79`) ·
[ACCEPTANCE.md](./ACCEPTANCE.md) (the acceptance ids each story owns) · [CONTRACTS.md](./CONTRACTS.md)
(§0 Resolutions `R-1`…`R-39`) · [CLARIFICATIONS.md](./CLARIFICATIONS.md) (the markers still open per epic)

> **There is an earlier draft.** [`_build-artifacts/open-decisions/jira-tickets.md`](./_build-artifacts/open-decisions/jira-tickets.md)
> already drafts the same fourteen tickets with bodies, using `EW-817`…`EW-830` as its placeholders. It is
> **kept at that path** — this file does not move, rename or overwrite it, and nothing in it is deleted. This
> file is the **programme-level** revision of that draft: it sits beside [TRACKER.md](./TRACKER.md) where the
> `EW-TBD` column points, and its epic numbers are recounted from the epics' own `spec.md` files (§5 shows what
> moved). Where the two differ, this file is current and the earlier draft is the record of what was believed
> on 2026-09-17.

---

## 0. The id-allocation rule (why every key here is `EW-TBD`)

[TRACKER.md](./TRACKER.md) `:9-10`: _"Jira tickets do not exist yet: every epic carries `EW-TBD` until the
owner files the program epic and one story per epic (the newest id on 2026-09-17 was EW-816)."_
[BUILD-READINESS.md](./BUILD-READINESS.md) `:154` records the earlier draft's `EW-817`…`EW-830` as
_"deliberately **not** filed"_.

**No real key is invented here.** The rule the owner applies at filing time:

1. **Jira assigns the key**, not this document. A key proposed in a draft is a guess about which numbers are
   free, and the earlier draft's own header says so (`_build-artifacts/open-decisions/jira-tickets.md:10-12`:
   _"Ids below are placeholders… Jira assigns the real keys at creation"_).
2. **File the program epic first** (`§1`). It takes the lowest free key in project `EW` at that moment.
3. **Then the thirteen stories** (`§2`), which take the next thirteen keys in the order they are listed. Each
   story is created as a **child of the program epic** — a Jira child-issue / epic-link, not a "relates to" —
   and the epic link is the only parent any story has.
4. **Replace every `EW-TBD`** in [TRACKER.md](./TRACKER.md) `:14-26` with the key Jira returns, keeping the
   epic → story mapping identical to `§2`'s table. The `EW-TBD` placeholder is the whole reason the column is
   safe to write before the tickets exist — never overwrite it with a guessed number.
5. **If the number `EW-816` has moved** by the time the owner files, the newest-id fact in
   [TRACKER.md](./TRACKER.md) `:9-10` and in the earlier draft's header is stale; the allocation rule above is
   unaffected, because it never depends on a specific number.

**Correct the two drafts the same way, in the same change:** [TRACKER.md](./TRACKER.md) `:9-10` (the
newest-id date) and the Jira column of its epic table. A suggested replacement for both is in the shared-file
requests delivered with this document.

---

## 1. Program epic

| Field            | Value                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| **Issue type**   | Epic                                                                                                    |
| **Key**          | `EW-TBD` (the first key Jira returns; see §0)                                                           |
| **Summary**      | App Works — any repository as a Work: run it, evolve it, deploy it                                      |
| **Labels**       | `app-works`, `spec-kit`, `wave-0`, `wave-1`, `wave-2`, `wave-3`                                         |
| **Components**   | `API`, `Web`, `Agent`, `Plugins`, `Platform / Infra`, `Docs / Spec` (confirm names against the project) |
| **Fix version**  | none — waves are the scheduling axis, not releases                                                      |
| **Child issues** | the thirteen stories in §2                                                                              |

**Summary (copy into Jira):**

> [App Works] Any repository as a Work — run it, evolve it, deploy it

**Description (copy into Jira):**

> Any repository on GitHub can be the starting point of a Work. A person pastes a repository URL; if the
> repository is not theirs, Ever Works forks it into their own account or organization, with their own Git
> connection. Ever Works then works out how to build and run it — from a curated App Blueprint when one
> exists, otherwise by having an agent study the repository and propose a spec as a pull request — and runs it
> as a Work: live on a subdomain or the person's own domain, on the person's own Kubernetes cluster or on the
> managed Ever Works Apps tier, or not deployed at all.
>
> From then on the person chats with their agents and the agents keep changing that software: a change becomes
> a Task, the Task becomes a pull request, a merge becomes a build and a deployment, and the Task closes when
> the change is live. Upstream is followed on a schedule and never pushed to; when a change would help
> everyone, the person can propose it back to the original project as a pull request that they approve first.
>
> Hosting open-source software is common. Hosting it **and** continuously evolving your own fork of it with
> agents — while staying in sync with upstream and able to contribute back — is the gap this program closes.
>
> **Additive only.** Nothing existing is deleted, renamed, weakened or narrowed. The existing Repository Work
> kind keeps its "never generate, never deploy, never write" guarantee; every other Work kind keeps its
> capabilities; every existing sign-in method, deploy option and catalogue keeps working. Where this program
> needs a new noun, the noun is added beside the old one.
>
> **Delivered in four waves.** Wave 0: two small prerequisite fixes, independently shippable. Wave 1: create an
> App Work from any repository URL, the App spec and Apps catalog, the App Provisioner agent, builds on the
> repository's own GitHub Actions, the app renderer, env and dependencies on the person's own cluster, the
> evolve loop, upstream sync and the App Launcher phase 1 — **the flagship example runs end to end on a user
> cluster**. Wave 2: the isolated managed hosting tier behind its launch gate, upstream pull requests, and
> Ever ID for Ever Works. Wave 3: any provisioned repository on the managed tier with sandboxed in-zone builds,
> preview deployments per pull request, Ever ID adopted by the other platforms, and the App Launcher reading
> apps across them.
>
> **Acceptance.** The program's own suite is the end-to-end flow scenarios and the negative/safety scenarios in
> the acceptance document; each epic's story in §2 owns its own numbered acceptance ids. The program epic is
> complete when the wave exit criteria hold and every story's ids are `Verified` in the tracker.

**Grounding (not part of the ticket):** [README.md](./README.md) `:17-49` (§0 why the program exists, the
owner's product idea and the user-question table), `:47-49` (additive), `:300-310` (§4 waves),
[ACCEPTANCE.md](./ACCEPTANCE.md) `:176-201` (the owner's eight-step flow) and `:667-689` (negative and safety
scenarios), [TRACKER.md](./TRACKER.md) `:28-36` (merge order).

---

## 2. The thirteen stories

Every story is a **child of the program epic** in §1. The Definition of Done is identical for all thirteen and
is stated once, below; each story's own acceptance criteria reference it rather than repeating it.

### 2.0 Definition of Done (identical for every story — copy into Jira once, or link this section)

> Every task's "Done when" line in the epic's task list is observable. The epic's own numbered acceptance ids
> pass in the lane the acceptance document assigns each one. Any migration is forward-only and inside the
> epic's reserved timestamp block. Every new user-visible string exists in all locale files. Every table the
> epic adds is classified for the workspace backup, so account export either carries it or drops it with a
> recorded reason, and secret-bearing values are never exported. The tracker is updated to `Merged`, then to
> `Verified` when the acceptance scenarios are green on the development branch. The pull request links the
> epic folder and this ticket.

### 2.1 Index — summary, wave, labels and acceptance ids

| Story | Epic   | Summary                                                                                     | Wave               | Owns (acceptance ids)                                  | Labels                                                                        |
| ----- | ------ | ------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| §2.2  | APW-01 | App Work kind — create a Work from any repository URL (link · fork · private copy)          | 1 (polish in 2)    | `ACC-01-01`…`ACC-01-27`                                | `app-works`, `spec-kit`, `wave-1`, `epic-apw-01`                              |
| §2.3  | APW-02 | Fork lifecycle — readiness, Actions hygiene, upstream sync, divergence, checkout keys       | 0 · 1              | `ACC-02-01`…`ACC-02-30`                                | `app-works`, `spec-kit`, `wave-0`, `wave-1`, `epic-apw-02`                    |
| §2.4  | APW-03 | App spec, Apps catalog and licence gate                                                     | 1                  | `ACC-03-01`…`ACC-03-59`                                | `app-works`, `spec-kit`, `wave-1`, `epic-apw-03`                              |
| §2.5  | APW-04 | App Provisioner — repository analysis to an App spec pull request, with a verification loop | 1 (Wave 2 in 3)    | `ACC-04-01`…`ACC-04-44`                                | `app-works`, `spec-kit`, `wave-1`, `epic-apw-04`                              |
| §2.6  | APW-05 | Builds — the build capability and the GitHub Actions build plugin                           | 1 · 3              | `ACC-05-01`…`ACC-05-32`                                | `app-works`, `spec-kit`, `wave-1`, `wave-3`, `epic-apw-05`                    |
| §2.7  | APW-06 | App runtime on Kubernetes — renderer, deploy targets, domains, smoke tests, health          | 1 · 2 · 3          | `ACC-06-01`…`ACC-06-58`                                | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `wave-3`, `epic-apw-06`          |
| §2.8  | APW-07 | App env and App dependencies — the env store, Postgres, Redis and object storage            | 1 · 2              | `ACC-07-01`…`ACC-07-34`                                | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `epic-apw-07`                    |
| §2.9  | APW-08 | Evolve loop — chat to Task to pull request to merge to build to deployment                  | 0 · 1              | `ACC-08-01`…`ACC-08-45`                                | `app-works`, `spec-kit`, `wave-0`, `wave-1`, `epic-apw-08`                    |
| §2.10 | APW-09 | Upstream pull requests — prepare, approve, open as the user, track                          | 1 (P1) · 2 (P2–P3) | `ACC-09-01`…`ACC-09-40`                                | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `epic-apw-09`                    |
| §2.11 | APW-10 | Ever Works Apps — the isolated hosting tier and its launch gate                             | 2 · 3              | `ACC-10-01`…`ACC-10-48`                                | `app-works`, `spec-kit`, `wave-2`, `wave-3`, `operator-action`, `epic-apw-10` |
| §2.12 | APW-11 | App Launcher and the Apps registry API                                                      | 1 · 3              | `ACC-11-01`…`ACC-11-54`                                | `app-works`, `spec-kit`, `wave-1`, `wave-3`, `epic-apw-11`                    |
| §2.13 | APW-12 | Ever ID — single sign-on across the Ever platforms                                          | 2 · 3              | `ACC-12-01`…`ACC-12-40`, plus the cross-platform gates | `app-works`, `spec-kit`, `wave-2`, `wave-3`, `cross-repo`, `epic-apw-12`      |
| §2.14 | APW-13 | Golden paths and the acceptance lanes — fixture app, Umami, Cal.diy                         | 1 · 2              | `ACC-13-01`…`ACC-13-25`                                | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `operator-action`, `epic-apw-13` |

Labels common to the epic and to every story: **`app-works`** (program membership), **`spec-kit`** (governed by
the Spec Kit process), **`wave-N`** (one per wave the ticket touches — a story may carry two),
**`epic-apw-NN`** (one per story, so an epic's slice is filterable without a component). Add
**`needs-owner-decision`** to a story that is held by an open `open` row in
[CLARIFICATIONS.md](./CLARIFICATIONS.md) for that wave, and remove the label when the row is decided — the
register is the single source for which rows are open.

The counts in the "Owns" column are the ids **defined by each epic's own `spec.md`**, recounted for this
draft — see §5.

### 2.2 APW-01 — App Work kind and create from any repository URL

| Field          | Value                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **Summary**    | App Work kind — create a Work from any repository URL (link · fork · private copy)                    |
| **Wave**       | Wave 1 (P1), polish in P2                                                                             |
| **Size**       | L                                                                                                     |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                                           |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `epic-apw-01`                                                      |
| **Owns**       | `ACC-01-01`…`ACC-01-27`                                                                               |
| **Depends on** | APW-02 (P0 readiness; P1), APW-03 (App spec and its Wave 1 catalog seam), APW-06 (T1–T3), APW-13 (P0) |

**Description (copy into Jira):**

> A signed-in person pastes the URL of any GitHub repository and gets an **App Work**: a Work whose code is
> that repository, which Ever Works can later build, run and keep changing with agents. Before anything is
> written anywhere, the person sees a preview of the repository — owner and name, stars, default branch, a
> licence chip, whether a curated App Blueprint exists — and chooses how the code becomes theirs: **Link**
> (offered when they can push to it), **Fork** into their own account or one of their organizations, or
> **Private copy** for people who cannot have a public fork, with the trade-off (no upstream pull requests)
> stated before they choose.
>
> The epic adds the new Work kind and its capabilities, the inspect and create endpoints, the refusal reasons,
> the recorded repository relation, and the delete semantics that keep the fork and the upstream by default.
> The existing Repository Work kind and every other kind are untouched.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-01-01`…`ACC-01-27` pass in the lanes the acceptance document assigns them.
- [ ] Every end-to-end scenario that exercises creation, fork, link, private copy and "not deployed, still
      evolved" is green.
- [ ] A person can complete the create flow from a pasted URL without any other epic's UI.
- [ ] Deleting an App Work removes what it runs, keeps stored data and the fork unless separately confirmed,
      and never touches the upstream.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-01-app-work-kind/spec.md:34-46` (§1 overview — the three
relations and the preview), `:6-14` (feature id, wave, dependencies), `:16-19` (additive-only statement).
Acceptance ids: `APW-01-app-work-kind/spec.md` §7, `ACC-01-01`…`ACC-01-27`; the epic's section is
[ACCEPTANCE.md](./ACCEPTANCE.md#apw-01-app-work-kind-and-create-from-any-repository-url).

### 2.3 APW-02 — Fork lifecycle

| Field          | Value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| **Summary**    | Fork lifecycle — readiness, Actions hygiene, upstream sync, divergence, checkout keys |
| **Wave**       | Wave 0 (P0, independently shippable) · Wave 1 (P1)                                    |
| **Size**       | L                                                                                     |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                           |
| **Labels**     | `app-works`, `spec-kit`, `wave-0`, `wave-1`, `epic-apw-02`                            |
| **Owns**       | `ACC-02-01`…`ACC-02-30`                                                               |
| **Depends on** | — (nothing blocks it; P0 ships first in the whole program)                            |

**Description (copy into Jira):**

> A fork is not finished when GitHub accepts the request, and it does not stay useful on its own. This epic
> makes an App Work's repository behave like something a person can trust over months. **Ready means ready:**
> an App Work leaves _Preparing_ only when its repository can be read and its default branch has a commit —
> and, when its source is recorded through a setup pull request, only once that pull request is merged; slow
> forks time out visibly with a **Try again**, and nothing ever asks GitHub for a second fork. **Inherited
> automation is off:** workflows that came with the upstream are switched off in the fork so they neither
> spend the person's Actions minutes nor run code nobody reviewed, while the Ever Works build workflow stays
> allowed. **Upstream is followed, never pushed to:** on a schedule, or on **Sync now**, a fork is brought up
> to date, and a conflict never resolves itself — it becomes a Task.
>
> **Wave 0 ships alone and first:** the checkout-directory key fix and the fork-readiness fix are prerequisites
> for the rest of the program and are independently shippable as their own pull request.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-02-01`…`ACC-02-30` pass in the lanes the acceptance document assigns them.
- [ ] A slow or failed fork does not block the person: it times out visibly and offers **Try again**.
- [ ] No second fork request is ever made for the same upstream and account.
- [ ] Upstream sync never merges into a diverged fork on its own; a conflict opens a Task and notifies the
      owner when no agent resolves.
- [ ] The P0 fix ships independently, before any other epic in the program.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-02-fork-lifecycle/spec.md:31-44` (§1 overview — readiness,
hygiene, sync), `:6-15` (wave, dependencies), `:17-21` (what P0 changes and only that). Acceptance ids:
`APW-02-fork-lifecycle/spec.md` §7; [ACCEPTANCE.md](./ACCEPTANCE.md#apw-02-fork-lifecycle). The single Upstream
tab and the conflict-Task agent rule are binding resolutions `R-8` and `R-21`
([CONTRACTS.md](./CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)).

### 2.4 APW-03 — App spec, Apps catalog and licence gate

| Field          | Value                                               |
| -------------- | --------------------------------------------------- |
| **Summary**    | App spec, Apps catalog and licence gate             |
| **Wave**       | Wave 1                                              |
| **Size**       | L                                                   |
| **Epic link**  | `EW-TBD` (program epic, §1)                         |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `epic-apw-03`    |
| **Owns**       | `ACC-03-01`…`ACC-03-59`                             |
| **Depends on** | — (nothing blocks it; ten other epics depend on it) |

**Description (copy into Jira):**

> An App Work is only as good as its description of how to build and run the software. This epic makes that
> description — the **App spec** — a first-class, validated file in the person's own repository, and gives it
> three things around it. First, **validation that explains itself**: every problem names the exact field by
> its component or variable name, the line and column, and how to fix it, for a person in Settings and for the
> App Provisioner agent writing the file; an invalid file never takes a running app down, because the last
> valid spec stays in effect. Second, the **Apps catalog**: a curated list of App Blueprints — ready-made App
> specs for known open-source projects — browsable when creating an App Work and matched automatically when a
> repository URL is pasted, including repositories that were renamed. Third, a **licence gate** that reads the
> repository's licence, classifies it, and decides where the app may run, with the owner's recorded
> attestation where a licence restricts hosting.
>
> Nothing else in the program can start without this epic's shared contracts, so it lands first in Wave 1.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-03-01`…`ACC-03-59` pass in the lanes the acceptance document assigns them.
- [ ] An invalid App spec never takes a running app down, and the last valid spec stays in effect.
- [ ] A pasted repository URL is matched to a catalog entry, including through a rename.
- [ ] A restricted-hosting licence is refused where it must be, and allowed where an attestation or a recorded
      agreement exists — never silently.
- [ ] The catalog content lives outside the platform's own code and is read at runtime.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-03-app-spec-and-catalog/spec.md:22-35` (§1 overview — the spec,
the catalog, the licence gate), `:6-14` (wave, dependents), `:16-18` (additive-only). Acceptance ids:
`APW-03-app-spec-and-catalog/spec.md` §7; [ACCEPTANCE.md](./ACCEPTANCE.md#apw-03-app-spec-apps-catalog-licence-gate).
Licence attestation is `R-3`; first-write behaviour is `R-4`; keypair formats `R-11`; the zero-config build
strategy `R-13`; the catalog repository is `ever-works/templates`, not `ever-works/apps`
([CONTRACTS §8](./CONTRACTS.md#8-catalog-repositories-outside-this-monorepo)).

### 2.5 APW-04 — App Provisioner

| Field          | Value                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- |
| **Summary**    | App Provisioner — repository analysis to an App spec pull request, with a verification loop |
| **Wave**       | Wave 1 (P1–P2), Wave 2 (P3)                                                                 |
| **Size**       | XL                                                                                          |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                                 |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `epic-apw-04`                                            |
| **Owns**       | `ACC-04-01`…`ACC-04-44`                                                                     |
| **Depends on** | APW-01, APW-03, APW-05, APW-06, APW-07                                                      |

**Description (copy into Jira):**

> When someone creates an App Work from a repository with no App Blueprint, nobody has written down how to
> build and run that software. The **App Provisioner** works it out. A Task appears on the App Work, an agent
> created from the App Provisioner agent template picks it up with the provisioning Skill, and the agent
> studies the repository inside an isolated sandbox that holds **no secrets** and can reach only the
> repository host and public package and container registries. It writes an App spec and, only when the
> repository cannot be built without one, an overlay Dockerfile — never a change to the application's own
> source — and proposes both as a pull request.
>
> The pull request is not the finish line. A **verification loop** is the Task's quality gate: the platform
> validates the spec, builds the pull request branch, boots the result on a short-lived verification target
> with throwaway dependencies, runs the spec's smoke tests, and attaches the evidence. Red sends the agent
> back up to the gate-attempt budget and then escalates to the person through the existing ask-human path.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-04-01`…`ACC-04-44` pass in the lanes the acceptance document assigns them.
- [ ] The provisioning agent runs with no secrets and restricted egress, and treats every repository byte as
      untrusted input.
- [ ] The agent never modifies the application's own source; only the App spec and, when required, an overlay
      Dockerfile are proposed.
- [ ] A proposal that does not build, boot or pass its smoke tests does not reach a person as "ready".
- [ ] The value the person is asked for is asked for through the existing decisions path, not a new one.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-04-app-provisioner/spec.md:31-43` (§1 overview — the Task, the
sandbox, the pull request, the verification loop), `:6-15` (wave, dependencies, dependents), `:17-20` (the
binding decision that the Provisioner is an agent plus a Skill running a Task, not a service). Acceptance ids:
`APW-04-app-provisioner/spec.md` §7; [ACCEPTANCE.md](./ACCEPTANCE.md#apw-04-app-provisioner). Verification
hooks are `R-10`; the safety-rail behaviour is `R-17`.

### 2.6 APW-05 — Builds

| Field          | Value                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Summary**    | Builds — the build capability and the GitHub Actions build plugin                                                        |
| **Wave**       | Wave 1 (P1) · Wave 3 (P3)                                                                                                |
| **Size**       | L                                                                                                                        |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                                                              |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `wave-3`, `epic-apw-05`                                                               |
| **Owns**       | `ACC-05-01`…`ACC-05-32`                                                                                                  |
| **Depends on** | APW-03 (the build block and its validation), APW-02 (Actions hygiene, webhook installation), APW-07 (build-phase values) |

**Description (copy into Jira):**

> An App Work's code lives in the person's own repository. A **Build** turns one commit of that repository into
> one container image a Deployment can run. The platform never builds on its own servers: in Wave 1 the build
> runs on GitHub-hosted runners inside the person's own repository, from a single workflow file the platform
> writes there and generates from the App spec. The image is pushed to the container registry under the
> repository's owner and identified by an immutable digest. Build-time values travel as masked repository
> secrets whose names start with a platform prefix — never as text in the workflow file.
>
> Builds start on every push to the tracked branch, on pull requests into it, and on **Rebuild**. Every Build
> appears on a Builds tab with its status, commit, duration, image digest and a link to the logs on GitHub; a
> failed Build says _why_ in plain words and hands the same diagnosis to the agents that keep the app
> evolving. Wave 3 adds the in-cluster, rootless, sandboxed build plugin for the managed tier.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-05-01`…`ACC-05-32` pass in the lanes the acceptance document assigns them.
- [ ] No build ever runs on the infrastructure that hosts the platform.
- [ ] No secret value appears in the workflow file, the build log or the image metadata.
- [ ] A failed build states a reason a person can act on, and the same reason reaches the agent loop.
- [ ] The zero-config strategy is refused exactly where the programme says it is refused, and the builder
      behind it is never named in the App spec.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-05-builds/spec.md:23-35` (§1 overview — the workflow file, the
runner choice, the digest, the masked secrets, the Builds tab), `:6-15` (wave, dependencies, dependents),
`:17-19` (additive-only; the Repository Work still never builds). Acceptance ids:
`APW-05-builds/spec.md` §7; [ACCEPTANCE.md](./ACCEPTANCE.md#apw-05-builds). The zero-config strategy is `R-13`;
checks in the person's CI are `R-9`; the first-write rule is `R-4`; the sandboxed build arrives in Wave 3 by
`R-24`; the names written into the repository are [CONTRACTS §9](./CONTRACTS.md#9-names-written-into-a-work-repository-added-by-apw-05).

### 2.7 APW-06 — App runtime on Kubernetes

| Field          | Value                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| **Summary**    | App runtime on Kubernetes — renderer, deploy targets, domains, smoke tests, health                   |
| **Wave**       | Waves 1 (P1), 2 (P2), 3 (P3)                                                                         |
| **Size**       | XL                                                                                                   |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                                          |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `wave-3`, `epic-apw-06`                                 |
| **Owns**       | `ACC-06-01`…`ACC-06-58`                                                                              |
| **Depends on** | APW-03, APW-05, APW-07, APW-10 (the managed tier and its policy, P2+), APW-01 (deleting an App Work) |

**Description (copy into Jira):**

> An App Work is a real application — several processes, a database, background jobs, scheduled calls, files on
> disk — not a static site with one container. This epic runs it. The owner picks where it runs: **None**
> (build only, do not deploy yet), **Your cluster** (a kubeconfig they paste) or **Ever Works Apps** (managed;
> off until its launch gate passes). A Deployment takes a green Build and the App spec from the same commit,
> turns them into a locked-down set of Kubernetes objects in a namespace of its own, runs the app's migrations
> **before** new code starts, waits for every component to be healthy with numeric deadlines, runs first-time
> setup **before** the app is reachable from the internet, publishes it on its domains — the platform's own
> domain by default, the owner's custom domains through the existing add-verify-remove flow — and proves it
> works with the App spec's smoke tests, from inside the cluster and over the public address. If the new
> version fails, the previous one is put back automatically. Afterwards the platform keeps watching: a health
> card shows what is running, a sustained failure produces one notification rather than silence, and the owner
> can pause, resume and roll back.
>
> **Every deploy shape is kept.** A shared customer cluster, the internal admin cluster, a customer
> kubeconfig, a machine connected to Ever Works, a remote host reached over SSH and any further provider as a
> deployment plugin are a family; adding a shape never narrows an existing one.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-06-01`…`ACC-06-58` pass in the lanes the acceptance document assigns them.
- [ ] Migrations run before new code starts, and first-time setup completes before the app is publicly
      reachable.
- [ ] A failed new version is rolled back automatically, and the previous version keeps serving.
- [ ] All three address shapes work: the platform's own domain, the owner's custom domain through the
      existing flow, and a dedicated user-apps apex where an operator configures one.
- [ ] No deploy shape is removed, narrowed or deprecated by this epic.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-06-app-runtime/spec.md:35-48` (§1 overview — deploy targets, the
Deployment sequence, rollback, health), `:6-16` (waves, dependencies, dependents), `:18-21` (the resolutions
applied). Acceptance ids: `APW-06-app-runtime/spec.md` §7;
[ACCEPTANCE.md](./ACCEPTANCE.md#apw-06-app-runtime-on-kubernetes). The deploy-shape family is `R-27` (and
[`APW-06-app-runtime/deploy-shapes.md`](./APW-06-app-runtime/deploy-shapes.md)); the public URL shapes are
`R-16` and README §2 D10; the managed-tier handover is `R-5`; deletion is `R-15`; the address of the managed
tier is README §8 question 2, answered 2026-09-17.

### 2.8 APW-07 — App env and App dependencies

| Field          | Value                                                                                   |
| -------------- | --------------------------------------------------------------------------------------- |
| **Summary**    | App env and App dependencies — the env store, Postgres, Redis and object storage        |
| **Wave**       | Wave 1 (P1) · Wave 2 (P2)                                                               |
| **Size**       | L                                                                                       |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                             |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `epic-apw-07`                              |
| **Owns**       | `ACC-07-01`…`ACC-07-34`                                                                 |
| **Depends on** | APW-03 (the env and dependency schema), APW-06 (deploy target, cluster access, domains) |

**Description (copy into Jira):**

> An open-source app needs configuration before it can run: secrets it expects someone to generate, addresses
> it derives from its own domain, credentials only the owner can supply, and a database, cache, bucket or mail
> server to talk to. The App spec already **declares** all of it; this epic makes the declaration real.
> **Settings ▸ Environment** lists every variable the app reads, with where its value comes from — generated
> once by the platform with the exact shape the app needs, derived from the app's domain or a dependency,
> prompted from the owner, set by the owner, or a default written in the App spec — whether it is needed at
> build time or run time, and whether it is set. Values go in and never come out: no screen, endpoint, log or
> Activity entry ever shows one. Missing required values block a Build or a Deploy with a message that names
> each one. A pasted environment file is imported in one step. **Settings ▸ Dependencies** shows each
> database, cache, bucket and mail server as a card: which provider serves it, its version, whether it is
> ready, and — stated plainly — whether anything backs its data up.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-07-01`…`ACC-07-34` pass in the lanes the acceptance document assigns them.
- [ ] No generated or owner-supplied value is ever readable through a screen, an endpoint, a log or the
      Activity log.
- [ ] A generated value is generated once and is never rotated implicitly.
- [ ] Missing required values block the Build or Deploy and name every missing variable.
- [ ] A dependency's data-backup state is stated plainly on its card, including when nothing backs it up.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-07-app-env-and-dependencies/spec.md:29-41` (§1 overview — the
five origins, the values-never-come-out rule, the dependency cards), `:6-15` (wave, dependencies, dependents),
`:17-20` (resolutions applied; `:22` the additive-only statement). Acceptance ids:
`APW-07-app-env-and-dependencies/spec.md` §7;
[ACCEPTANCE.md](./ACCEPTANCE.md#apw-07-app-env-and-dependencies). Keypair formats are `R-11`; managed
dependencies are gated by `R-5`; ephemeral verification values are `R-10`; deletion keeps data by `R-15`; the
workspace-backup classification is `R-25`.

### 2.9 APW-08 — Evolve loop

| Field          | Value                                                                      |
| -------------- | -------------------------------------------------------------------------- |
| **Summary**    | Evolve loop — chat to Task to pull request to merge to build to deployment |
| **Wave**       | Wave 0 (P0), Wave 1 (P1–P2), Wave 1 tail (P3)                              |
| **Size**       | L                                                                          |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                |
| **Labels**     | `app-works`, `spec-kit`, `wave-0`, `wave-1`, `epic-apw-08`                 |
| **Owns**       | `ACC-08-01`…`ACC-08-45`                                                    |
| **Depends on** | APW-01, APW-03, APW-05, APW-06                                             |

**Description (copy into Jira):**

> A person who owns an App Work says what they want — in the App Work's chat, on its Tasks tab, through a Goal
> or through a Mission — and an agent makes the change **in the App Work's own repository**: on a branch cut
> from the branch the App Work builds and deploys, checked by the checks the App spec declares, kept away from
> the paths the App spec protects, and proposed as a pull request of a reviewable size. A human merges it,
> unless the merge policy says an agent may. From that moment the Task does not simply tick to _Done_: it
> **follows the change** — the Build of the merge commit, the Deployment that runs it, the smoke checks, and
> finally the live address — and shows that chain as chips on the board card and as a timeline on the Task.
> The Task closes when the change is live, or when the person explicitly accepts that it is not. If the Build
> or the Deployment of a merged change fails, the Task stays open and a follow-up Task is opened with the
> failure attached, up to a fixed number of times before a person is asked instead.
>
> Goals can be scoped to one App Work so every iteration is a Task on it, and Missions related to an App Work
> can file Tasks on it. **Wave 0 ships alone:** the agent Git-tool bindings that the whole loop depends on are
> fixed first, as an independent pull request.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-08-01`…`ACC-08-45` pass in the lanes the acceptance document assigns them.
- [ ] A Task closes only when its change is live, or when a person explicitly accepts that it is not.
- [ ] A failed Build or Deployment of a merged change leaves the Task open and opens a follow-up with the
      failure attached.
- [ ] The checks the App spec declares run sandboxed, and protected paths are never modified by an agent.
- [ ] The Wave 0 Git-tool fix ships independently, before the loop that needs it.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-08-evolve-loop/spec.md:25-37` (§1 overview — the change, the
delivery chain, the follow-up, Goals and Missions), `:6-14` (wave, dependencies, dependents), `:16-21`
(additive-only, and the binding decision that the loop reuses the existing machinery). Acceptance ids:
`APW-08-evolve-loop/spec.md` §7; [ACCEPTANCE.md](./ACCEPTANCE.md#apw-08-evolve-loop). Checks in the person's CI
are `R-9`; safety rails are `R-17`; the conflict-Task agent rule is `R-21`.

### 2.10 APW-09 — Upstream pull requests

| Field          | Value                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **Summary**    | Upstream pull requests — prepare, approve, open as the user, track                                              |
| **Wave**       | Wave 1 (P1 foundations) · Wave 2 (P2–P3)                                                                        |
| **Size**       | M                                                                                                               |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                                                     |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `epic-apw-09`                                                      |
| **Owns**       | `ACC-09-01`…`ACC-09-40`                                                                                         |
| **Depends on** | APW-02 (fork lifecycle, upstream metadata, sync status), APW-08 (merged changes, delivery state, isolated runs) |

**Description (copy into Jira):**

> When the owner of an App Work that is a fork has made a change that would help everyone using the original
> project, they can **propose it upstream**. From a merged Task they press **Propose upstream**. An agent using
> the upstream-contribution Skill prepares a **clean branch** in the fork, cut from the upstream project's
> default branch, that carries **only that change** — none of the fork's other customisations — follows the
> project's contribution guide and agent instructions, runs the checks the project documents in an isolated
> sandbox, and writes a title and description in the project's pull request template with a one-line
> AI-assistance disclosure. Nothing leaves the fork until the owner reviews an **approval** that shows the
> exact diff, title, description and target, and approves it. The pull request is then opened **as the owner,
> with their own GitHub account**.
>
> Ever Works tracks it: reviews, requested changes, checks (showing "waiting for maintainers" when the project
> must approve CI for a first-time contributor, never "failed"), merged or closed. When maintainers ask for
> changes, the owner can ask an agent to address them — and approves again before anything is pushed. Ever
> Works never signs a contributor agreement on anyone's behalf and never merges anything upstream.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-09-01`…`ACC-09-40` pass in the lanes the acceptance document assigns them.
- [ ] Nothing leaves the fork before the owner approves the exact diff, title, description and target.
- [ ] The prepared branch carries only the chosen change, never the fork's other customisations.
- [ ] No contributor agreement or sign-off is ever signed on the owner's behalf, and the platform never merges
      an upstream pull request.
- [ ] The pull request is opened under the owner's own account, and rate limits are enforced.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-09-upstream-pull-requests/spec.md:27-39` (§1 overview — the clean
branch, the approval, the tracking, the follow-up), `:6-14` (wave, dependencies, dependents), `:16-19`
(additive-only, and the binding decision that upstream is followed and never pushed to by the platform on its
own). Acceptance ids: `APW-09-upstream-pull-requests/spec.md` §7;
[ACCEPTANCE.md](./ACCEPTANCE.md#apw-09-upstream-pull-requests). The Upstream tab is `R-8` (APW-02 creates it;
this epic adds its section — see [CLARIFICATIONS.md](./CLARIFICATIONS.md) `CL-40`); the approval type is `R-18`.
Note that [TRACKER.md](./TRACKER.md) `:22` still shows this epic's wave as `2` alone, while its own spec header
and the tracker's own merge order both put its P1 in Wave 1 — a suggested correction is in the shared-file
requests.

### 2.11 APW-10 — Ever Works Apps hosting tier

| Field          | Value                                                                         |
| -------------- | ----------------------------------------------------------------------------- |
| **Summary**    | Ever Works Apps — the isolated hosting tier and its launch gate               |
| **Wave**       | Wave 2 (P1, P2) · Wave 3 (P3)                                                 |
| **Size**       | XL                                                                            |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                   |
| **Labels**     | `app-works`, `spec-kit`, `wave-2`, `wave-3`, `operator-action`, `epic-apw-10` |
| **Owns**       | `ACC-10-01`…`ACC-10-48`                                                       |
| **Depends on** | — (P1) · APW-03, APW-06, APW-07 (P2) · APW-05 (P3)                            |
| **Owner**      | Platform engineering and operations                                           |

**Description (copy into Jira):**

> Ever Works Apps is where App Works run when their owner picks **Ever Works Apps** as the deploy target:
> software the person — or their agents — changed, built and shipped, running on infrastructure Ever Works
> operates. That code is untrusted by definition. This epic defines the **launch gate**: a closed, numbered
> list of isolation and abuse controls, each verifiable either by an automated check or by an expiring
> operator attestation. A **self-check** runs every automated check from inside a real tenant sandbox — can a
> tenant reach a private network? the cloud metadata address? the cluster's control plane? another tenant? Is
> its token gone? Does quarantine actually stop it? — and the platform **refuses to open the tier** unless the
> latest self-check is green, less than 24 hours old, and every attestation is current. The tier closes itself
> to new deployments the moment that stops being true.
>
> Around the gate the epic delivers the platform side of the tier: an in-zone provisioning controller that the
> platform instructs by writing desired state, so platform servers hold no cluster-admin credential; a
> per-App-Work namespace with default-deny networking, quotas and restricted pod security; per-App-Work
> **Quarantine** as the stop mechanism; abuse controls; and receipts for managed compute.
>
> **This ticket contains operator actions no pull request can complete** — the gate's attestations, the
> quarantine drill and the ship gate. **Infrastructure specifics are deliberately absent:** this is a public
> repository, and addresses, host names, cluster and node names and vendor account details live in the private
> operations repository.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-10-01`…`ACC-10-48` pass in the lanes the acceptance document assigns them, with the operator
      evidence recorded in the private operations repository where the acceptance document says so.
- [ ] The tier refuses to open unless the latest self-check is green, less than 24 hours old, and every
      attestation is current; it closes itself to new deployments the moment that stops being true.
- [ ] Every gate item is either an automated check or an expiring attestation — none is skipped, and a shape
      that cannot satisfy an item is recorded failed with its reason rather than waived.
- [ ] Quarantining one App Work stops its workloads and network and is proven by the drill.
- [ ] Platform servers hold no cluster-admin credential.
- [ ] The epic adds no address, host name, cluster or node name, or vendor account detail to this repository.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-10-apps-hosting-tier/spec.md:34-47` (§1 overview — the gate, the
self-check, the in-zone controller, quarantine), `:6-13` (wave, dependencies, dependents, owner), `:15-18`
(additive-only), `:20-23` (public-repository hygiene). Acceptance ids:
`APW-10-apps-hosting-tier/spec.md` §7; [ACCEPTANCE.md](./ACCEPTANCE.md#apw-10-ever-works-apps-hosting-tier).
Quarantine naming is `R-20`; the managed-tier handover is `R-5`; the sandboxed runtime arrives in Wave 2 and
sandboxed builds in Wave 3 by `R-24`; the shape family is `R-27`.

### 2.12 APW-11 — App Launcher and Apps registry API

| Field          | Value                                                      |
| -------------- | ---------------------------------------------------------- |
| **Summary**    | App Launcher and the Apps registry API                     |
| **Wave**       | Wave 1 (P1) · Wave 3 (P2)                                  |
| **Size**       | M                                                          |
| **Epic link**  | `EW-TBD` (program epic, §1)                                |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `wave-3`, `epic-apw-11` |
| **Owns**       | `ACC-11-01`…`ACC-11-54`                                    |
| **Depends on** | — (P1) · APW-06, APW-12 (P2)                               |

**Description (copy into Jira):**

> A person working in Ever Works can reach every other Ever platform, and every app they have running, from one
> place. A new **App Launcher** control sits in the dashboard header. It opens a panel with two sections:
> **Ever apps** — Ever Works, Ever Gauzy, Ever Teams, Ever Rec and the rest of the family, read from a
> versioned, public platform catalog that lives outside the product code — and **Your apps** — the person's App
> Works that have a live address, plus any other Work with a live site that was switched on with **Show in App
> Launcher**. Each tile opens its address in a new browser tab; nothing about the person's session travels with
> it. People pin what they use most, hide what they never use and reorder the rest, and those choices follow
> them across devices.
>
> The same launcher, packaged as a framework-neutral web component, later drops into Gauzy, Teams and other
> Ever platforms, showing the platform list to anyone and the person's own apps once Ever ID lets that platform
> ask on their behalf.
>
> **No sign-on claims.** Until Ever ID ships, no string on any surface of this epic may say or imply single
> sign-on, "one login", "already signed in" or a shared account. Opening another Ever platform is a link, and
> the copy says the person may need to sign in.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-11-01`…`ACC-11-54` pass in the lanes the acceptance document assigns them.
- [ ] No session token, or anything derived from one, travels to another platform — in a URL or otherwise.
- [ ] Until Ever ID ships in production, no copy on any surface claims or implies single sign-on.
- [ ] Pin, hide and reorder choices persist and follow the person across devices.
- [ ] The existing Organization switcher, Work switcher, command palette, header controls and sidebar keep
      their position, behaviour and copy, and no sidebar entry is added.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-11-app-launcher/spec.md:26-37` (§1 overview — the two sections,
the tiles, the preferences, the web component), `:6-13` (wave, dependencies, dependents), `:15-18`
(additive-only; nothing adds a sidebar entry), `:20-22` (the no-sign-on-claims rule). Acceptance ids:
`APW-11-app-launcher/spec.md` §7; [ACCEPTANCE.md](./ACCEPTANCE.md#apw-11-app-launcher-and-apps-registry-api).
The launcher's delegated read is `R-19`; the platform catalog repository is `ever-works/platforms`
([CONTRACTS §8](./CONTRACTS.md#8-catalog-repositories-outside-this-monorepo)); the component's publication
location is README §8 question 7 (open — [CLARIFICATIONS.md](./CLARIFICATIONS.md) `CL-48`).

### 2.13 APW-12 — Ever ID

| Field          | Value                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| **Summary**    | Ever ID — single sign-on across the Ever platforms                                  |
| **Wave**       | Wave 2 (P1) · Wave 3 (P2, P3)                                                       |
| **Size**       | XL                                                                                  |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                         |
| **Labels**     | `app-works`, `spec-kit`, `wave-2`, `wave-3`, `cross-repo`, `epic-apw-12`            |
| **Owns**       | `ACC-12-01`…`ACC-12-40`, plus the cross-platform gates in Ever Teams and Ever Gauzy |
| **Depends on** | the owner decisions in the epic's identity-provider decision record (P1)            |
| **Owner**      | Product · Security                                                                  |

**Description (copy into Jira):**

> **Ever ID** is one identity a person uses across Ever platforms. It is a dedicated OpenID Connect identity
> provider, operated separately from every Ever platform. Ever Works, Ever Teams and Ever Gauzy become
> _relying parties_ of it and keep all of their current sign-in methods.
>
> For Ever Works: a **Sign in with Ever ID** button; account creation after an explicit confirmation;
> connecting from **Settings → Security → Connected identities** only while signed in and only after
> confirming — never because two e-mail addresses match; disconnecting while another way to sign in remains;
> sign-out at Ever ID ending the sessions it opened; terminal sign-in with a short code instead of a token in
> a redirect; and a narrow, read-only permission that lets another Ever platform list the person's App Works
> in the App Launcher — never a session.
>
> **Pure addition, never a replacement.** Every sign-in method that ships today keeps working exactly as it
> does: email and password, magic link, anonymous start and claim, GitHub, Google, Facebook, LinkedIn, API
> keys, and the browser hand-off the command-line tool and nodes use. Ever Works is **not** the identity root
> for any production platform. **This ticket spans repositories:** its acceptance gates are walked in Ever
> Teams and Ever Gauzy as well as here.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-12-01`…`ACC-12-40` pass in the lanes the acceptance document assigns them, and the cross-platform
      gates pass in Ever Teams and Ever Gauzy.
- [ ] Every sign-in method that ships today still works, unchanged.
- [ ] No account is ever linked because two e-mail addresses match; linking requires being signed in and an
      explicit confirmation.
- [ ] A person can always disconnect while at least one other way to sign in remains.
- [ ] The delegated permission is read-only, scoped, and never carries a session.
- [ ] No session token, and no credential of any kind, is ever placed in a URL by a new flow.
- [ ] The Definition of Done in §2.0 holds, including the production-flag gates walked by a person.

**Grounding (not part of the ticket):** `APW-12-ever-id/spec.md:32-43` (§1 overview — the provider, the
relying parties, the Ever Works surface), `:6-16` (wave, dependencies, companions), `:18-22` (additive-only,
and the token-in-redirect hand-off that must not be extended). Acceptance ids: `APW-12-ever-id/spec.md` §7;
[ACCEPTANCE.md](./ACCEPTANCE.md#apw-12-ever-id). The provider is `R-19` (`authMethod` appends
`'ever-id-delegated'` only) and the decision record
[`APW-12-ever-id/idp-options.md`](./APW-12-ever-id/idp-options.md) §6–§7 (ZITADEL, `auth.ever.co`, owner
decision 2026-09-17; D2–D9 remain recommendations). The five residual §9 markers are
[CLARIFICATIONS.md](./CLARIFICATIONS.md) `CL-53`…`CL-57`.

### 2.14 APW-13 — Golden paths and the acceptance lanes

| Field          | Value                                                                         |
| -------------- | ----------------------------------------------------------------------------- |
| **Summary**    | Golden paths and the acceptance lanes — fixture app, Umami, Cal.diy           |
| **Wave**       | Wave 1 (P1) · Wave 2 (P2)                                                     |
| **Size**       | L                                                                             |
| **Epic link**  | `EW-TBD` (program epic, §1)                                                   |
| **Labels**     | `app-works`, `spec-kit`, `wave-1`, `wave-2`, `operator-action`, `epic-apw-13` |
| **Owns**       | `ACC-13-01`…`ACC-13-25`                                                       |
| **Depends on** | APW-01…08 (Wave 1 scenarios), APW-09, APW-10, APW-12 (Wave 2 scenarios)       |

**Description (copy into Jira):**

> App Works promises that any repository can become a running, evolving Work. This epic is how the program
> **proves** that promise, every night, without a person clicking through it — and how a user can tell which
> ready-made App Blueprints have actually been proven.
>
> It delivers three golden paths and the machinery that runs them. A **fixture application**, purpose-built
> and tiny, makes every App spec feature observable from outside the cluster in minutes. **Umami** is the fast
> real-world path: a published image, a database, a first administrator, done in under fifteen minutes.
> **Cal.diy** is the flagship: the owner's own example, built from source, migrated, bootstrapped, scheduled,
> booked, and then changed by an agent and redeployed. A **prompt-injection fixture** proves that a hostile
> repository fails harmlessly.
>
> Around them sit the **acceptance lanes** — a deterministic lane that runs with the suite, a nightly lane
> against the development environment, and a weekly lane — plus the evidence a verified Blueprint badge is
> based on. **This ticket contains operator actions no pull request can complete:** the test clusters are
> claimed through the operations change process before each run, and their details live in the private
> operations repository.

**Acceptance criteria (copy into Jira):**

- [ ] `ACC-13-01`…`ACC-13-25` pass in the lanes the acceptance document assigns them.
- [ ] The fixture application makes every App spec feature observable from outside the cluster.
- [ ] A hostile repository fails harmlessly, and the prompt-injection fixture is never referenced from product
      documentation.
- [ ] A Blueprint's verified badge is backed by recorded evidence and expires; two consecutive failures
      unverify it.
- [ ] The existing end-to-end, Kubernetes end-to-end and deployed-smoke workflows keep running exactly as they
      do today — this epic adds rows and specs to them and removes none.
- [ ] The Definition of Done in §2.0 holds.

**Grounding (not part of the ticket):** `APW-13-golden-paths/spec.md:24-38` (§1 overview — the three golden
paths, the injection fixture, the lanes), `:6-15` (wave, dependencies, dependents), `:17-20` (additive-only).
Acceptance ids: `APW-13-golden-paths/spec.md` §7;
[ACCEPTANCE.md](./ACCEPTANCE.md#apw-13-golden-paths-and-acceptance-lanes). Fixture branches are owned here by
`R-23`; the lanes and the test-location rule are `R-22`. Seven §9 markers remain
([CLARIFICATIONS.md](./CLARIFICATIONS.md) `CL-58`…`CL-64`).

---

## 3. Links to create at filing time

Every story in §2 is a **child** of the program epic. Beyond that parent link, only these dependencies are
recorded as Jira links; the rest live in each epic's own dependency line and in
[TRACKER.md](./TRACKER.md#merge-order)'s merge order, and duplicating them all in Jira would create a second
source of truth that goes stale.

| Link                                                            | Why                                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| APW-04 **is blocked by** APW-01, APW-03, APW-05, APW-06, APW-07 | The Provisioner calls the build, renderer and env contracts; it cannot start before they land. |
| APW-05 **is blocked by** APW-03                                 | The build workflow is generated from the App spec's `build` block.                             |
| APW-06 **is blocked by** APW-03, APW-05, APW-07                 | The renderer consumes a Build, the App spec and the env/dependency contracts.                  |
| APW-07 **is blocked by** APW-03                                 | The env and dependency schema is APW-03's.                                                     |
| APW-08 **is blocked by** APW-01, APW-03, APW-05, APW-06         | The evolve loop ends in a Build and a Deployment.                                              |
| APW-09 **is blocked by** APW-02, APW-08                         | It starts from a merged change on a fork.                                                      |
| APW-11 (P2) **is blocked by** APW-06, APW-12                    | The launcher reads a deployed address, and the P2 read across platforms needs Ever ID.         |
| APW-13 **is blocked by** APW-01…APW-08                          | Its Wave 1 lanes exercise all of them.                                                         |
| APW-01 **relates to** APW-02 (P0 only)                          | APW-01's Wave 1 needs APW-02's P0 fixes, but only those.                                       |

The `Depends on` line in each epic's own `spec.md` is authoritative where this table and
[README §5](./README.md#5-epics) disagree — [TRACKER.md](./TRACKER.md) `:45-46` says the same.

---

## 4. Out of scope for filing

- **No sub-tasks.** Each story's `tasks.md` is the sub-task list, and it changes too often to mirror into Jira;
  Jira carries the story, the epic and the acceptance ids.
- **No separate ticket per phase.** A story spans its waves by design (APW-06 spans three); splitting it would
  break the acceptance-id ownership that makes `Verified` checkable.
- **No tickets for the programme documents.** [CONTRACTS.md](./CONTRACTS.md),
  [ACCEPTANCE.md](./ACCEPTANCE.md), [TRACKER.md](./TRACKER.md), [BUILD-READINESS.md](./BUILD-READINESS.md),
  [CLARIFICATIONS.md](./CLARIFICATIONS.md), [`checklists/requirements.md`](./checklists/requirements.md),
  `DOCS-PLAN.md` and this file are governed in the repository.
- **No customer-facing or support tickets.** The user documentation plan is `DOCS-PLAN.md`.
- **No sprint assignment.** The program is not scheduled to a release; waves are the axis (see §1).

---

## 5. What this draft corrects in the earlier draft

The earlier [`_build-artifacts/open-decisions/jira-tickets.md`](./_build-artifacts/open-decisions/jira-tickets.md)
is **kept unchanged**. Nine of its facts had moved by the time this revision was written; it is cited here so
the difference is visible rather than silently overwritten.

| Item                  | Earlier draft                           | Current, recounted here                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APW-01 acceptance ids | `ACC-01-01`…`ACC-01-20` (20)            | `ACC-01-01`…`ACC-01-27` (**27**) — `APW-01-app-work-kind/spec.md` defines ids 21–27, which `ACCEPTANCE.md` does not yet index; the verifier reports exactly those seven as findings                                                                                                                     |
| APW-06 acceptance ids | `ACC-06-01`…`ACC-06-49` (49)            | `ACC-06-01`…`ACC-06-58` (**58**) — the spec defines 58; the `49` comes from stale prose in the acceptance document's `### Coverage gaps` section, which the verifier's own count contradicts                                                                                                            |
| Other epics' ids      | its own 2026-09-17 sweep                | Recounted: APW-02 **30** · APW-03 **59** · APW-04 **44** · APW-05 **32** · APW-07 **34** · APW-08 **45** · APW-09 **40** · APW-10 48 · APW-11 **54** · APW-12 40 (+ the cross-platform gates) · APW-13 **25**. **The epics are still being extended** — re-derive before filing, with the command below |
| Catalog repository    | `ever-works/apps`                       | **`ever-works/templates`** ([CONTRACTS §8](./CONTRACTS.md#8-catalog-repositories-outside-this-monorepo) `:523`; the rename is recorded in [README §1](./README.md#1-vocabulary-no-new-synonyms) `:73`)                                                                                                  |
| Binding resolutions   | "25 binding audit resolutions R-1…R-25" | **39**: `R-1`…`R-39`. `R-26` is the owner's additive-only rule, `R-27` the deploy-shape family, `R-28` the Ever ID provider, `R-29` the catalog repositories, `R-30` operator kill switches, `R-31` quotas and caps                                                                                     |
| Placeholder keys      | `EW-817`…`EW-830`                       | `EW-TBD` (§0) — a proposed number is a guess, and the earlier draft's own header says Jira assigns the real keys                                                                                                                                                                                        |
| APW-09 wave           | `1 · 2` in its index table              | `1 (P1) · 2 (P2–P3)` — see §2.10; [TRACKER.md](./TRACKER.md) `:22` alone still shows `2`                                                                                                                                                                                                                |

**Re-derive the counts at filing time — the epics are still growing.** From the worktree root:

```bash
grep -ho 'ACC-[0-9][0-9]-[0-9][0-9]' docs/specs/features/app-works/APW-*/spec.md | sort -u | wc -l
```

At the time of this reading the tree holds **536** distinct ids across the thirteen epics, which is what the
spec-tree verifier reports as "defined"; `ACCEPTANCE.md` indexes **445** of them. The 91-id gap is exactly the
verifier's `ids` finding count, and closing it is another workstream's job — not something a Jira story can
absorb. The per-epic start-to-end ranges in §2.1 and in each story's **Owns** field are the ones to put in a
ticket, and they should be refreshed in the same pass.
