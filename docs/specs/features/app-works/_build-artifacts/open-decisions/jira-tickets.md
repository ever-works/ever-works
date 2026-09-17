# App Works — Jira ticket drafts (ready to file)

**Status:** draft for owner approval. Nothing has been filed. **Analysis only** — no existing file was modified.
**Prepared:** 2026-09-17 against the `plan/any-repo-as-work` worktree of `ever-works-platform`.

**Project:** `EW` at <https://evertech.atlassian.net> (the project every other Ever Works spec uses — see
`docs/specs/features/schedules/tasks.md:122`, `docs/specs/features/tenants-and-organizations/tasks.md:285`).
**Newest existing id:** `EW-816` (`docs/specs/features/app-works/TRACKER.md:10`).

> **Ids below are placeholders.** `EW-817`…`EW-830` are the next free numbers after `EW-816` on 2026-09-17.
> Jira assigns the real keys at creation; replace the placeholders in `TRACKER.md:14-26` with whatever Jira
> returns, and keep the epic → story links the same.

---

## 0. What to file, in one table

| #   | Type  | Proposed key | Title                                                   | Wave (TRACKER) | Owns (acceptance ids)                            |
| --- | ----- | ------------ | ------------------------------------------------------- | -------------- | ------------------------------------------------ |
| 1   | Epic  | `EW-817`     | **App Works — any GitHub repository as a Work**         | 0–3            | `ACC-E2E-01…14`, `ACC-NEG-01…16` (program-level) |
| 2   | Story | `EW-818`     | APW-01 — App Work kind & create from any repository URL | 1              | `ACC-01-01…20`                                   |
| 3   | Story | `EW-819`     | APW-02 — Fork lifecycle                                 | 0 · 1          | `ACC-02-01…23`                                   |
| 4   | Story | `EW-820`     | APW-03 — App spec, Apps catalog, licence gate           | 1              | `ACC-03-01…49`                                   |
| 5   | Story | `EW-821`     | APW-04 — App Provisioner                                | 1              | `ACC-04-01…38`                                   |
| 6   | Story | `EW-822`     | APW-05 — Builds                                         | 1 · 3          | `ACC-05-01…30`                                   |
| 7   | Story | `EW-823`     | APW-06 — App runtime on Kubernetes                      | 1–3            | `ACC-06-01…49`                                   |
| 8   | Story | `EW-824`     | APW-07 — App env & dependencies                         | 1 · 2          | `ACC-07-01…31`                                   |
| 9   | Story | `EW-825`     | APW-08 — Evolve loop                                    | 0 · 1          | `ACC-08-01…32`                                   |
| 10  | Story | `EW-826`     | APW-09 — Upstream pull requests                         | 1 · 2          | `ACC-09-01…23`                                   |
| 11  | Story | `EW-827`     | APW-10 — Ever Works Apps hosting tier (launch gate)     | 2 · 3          | `ACC-10-01…48`                                   |
| 12  | Story | `EW-828`     | APW-11 — App Launcher & Apps registry API               | 1 · 3          | `ACC-11-01…40`                                   |
| 13  | Story | `EW-829`     | APW-12 — Ever ID                                        | 2 · 3          | `ACC-12-01…40` + `XP-T-01…06`, `XP-G-01…06`      |
| 14  | Story | `EW-830`     | APW-13 — Golden paths & acceptance suite                | 1 · 2          | `ACC-13-01…20`                                   |

Counts are the id sweep recorded in `ACCEPTANCE.md:1269-1270` ("APW-01 20 · APW-02 23 · APW-03 49 · APW-04 38 ·
APW-05 30 · APW-06 49 · APW-07 31 · APW-08 32 · APW-09 23 · APW-10 48 · APW-11 40 · APW-12 40 + 12 cross-platform ·
APW-13 20 — every id has exactly one row"), re-verified here by extracting every `ACC-NN-nn` id from each epic's
`spec.md` §8. `ACC-12-40` is the one id with no automated test — it is a manual cross-repository gate
(`ACCEPTANCE.md:1272-1277`).

---

## 1. Labels and components

> **Not verified against the live Jira project.** No Jira credential, MCP server or component list is present in
> this workspace (`.mcp.json` does not exist at the repo root; the only reference to ticket tooling is
> `knowledge/runbooks/JIRA_ATLASSIAN_MCP.md` in the _operator workspace repository_, which is not this repo —
> `docs/specs/features/tenants-and-organizations/tasks.md:300`). Everything below is a **proposal** derived from
> the repo's own vocabulary. Confirm or adjust the component names at filing time; the labels are safe to use
> as-is because they are all lower-case, hyphenated strings no Jira project can conflict with.

**Labels (same set on the epic and on all 13 stories):**

| Label                               | Meaning                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `app-works`                         | Program membership — every ticket in this program carries it.                                                          |
| `spec-kit`                          | Governed by the Spec Kit process (`docs/specs/README.md`, Constitution cited in `README.md:8`).                        |
| `wave-0` `wave-1` `wave-2` `wave-3` | One per wave **the ticket touches** (a story may carry two: APW-02 carries `wave-0` and `wave-1`).                     |
| `epic-apw-01` … `epic-apw-13`       | One per story, so the epic's slice is filterable without a component.                                                  |
| `needs-owner-decision`              | Only on tickets held by an open item in `decision-sheet.md` that is marked **owner must decide**. Remove when decided. |
| `cross-repo`                        | APW-12 only — its acceptance tests live in `ever-co/ever-teams` and `ever-co/ever-gauzy` (`ACCEPTANCE.md:1281-1282`).  |
| `operator-action`                   | Ticket contains an owner/operator action that no PR can complete (APW-13 T20, T21; APW-10 ship gates).                 |

**Components (proposed — confirm against the project):**

| Component          | Used by                                              |
| ------------------ | ---------------------------------------------------- |
| `API`              | APW-01, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12       |
| `Web`              | APW-01, 02, 05, 06, 07, 08, 10, 11, 12, 13           |
| `Agent`            | APW-04, 05, 06, 07, 08, 12                           |
| `Plugins`          | APW-04, 05, 06, 07, 10, 12                           |
| `Platform / Infra` | APW-06, 10, 13                                       |
| `Cross-repo`       | APW-12                                               |
| `Docs / Spec`      | every story (each ships spec-kit artefacts and i18n) |

**Fix version:** none. The program is not scheduled to a release; waves are the scheduling axis
(`README.md:245-252`, `TRACKER.md:28-35`).

**Links to create at filing time:**

- Epic `EW-817` **has child** stories `EW-818`…`EW-830` (Jira "child issue" / epic-link, not "relates to").
- `EW-818` (APW-01) **is blocked by** `EW-819` (APW-02) — P0 only (`README.md:266`, `TRACKER.md:15`).
- `EW-821` (APW-04) **is blocked by** `EW-818`, `EW-820`, `EW-822`, `EW-823` (`README.md:269`).
- `EW-822` (APW-05) **is blocked by** `EW-820` (`README.md:270`).
- `EW-823` (APW-06) **is blocked by** `EW-820`, `EW-822`, `EW-824` (`README.md:271`).
- `EW-824` (APW-07) **is blocked by** `EW-820` (`README.md:272`).
- `EW-825` (APW-08) **is blocked by** `EW-818`, `EW-822`, `EW-823` (`README.md:273`).
- `EW-826` (APW-09) **is blocked by** `EW-819`, `EW-825` (`README.md:274`).
- `EW-828` (APW-11 P2) **is blocked by** `EW-823` (`README.md:276`).
- `EW-830` (APW-13) **is blocked by** `EW-818`…`EW-825` (`README.md:278`).

---

## 2. Epic `EW-817`

**Title:** App Works — any GitHub repository as a Work

**Type:** Epic · **Labels:** `app-works`, `spec-kit`, `wave-0`, `wave-1`, `wave-2`, `wave-3`

**Description:**

> Any GitHub repository can be the starting point of a Work. Paste a URL; if the repository is not yours, Ever
> Works forks it into your account. Ever Works then works out how to run it — from a curated App Blueprint if one
> exists, otherwise by having an agent study the repository — and runs it as a Work: live on a subdomain or your
> own domain, on the shared Ever Works cluster or on your own Kubernetes cluster, or not deployed at all. From
> then on you chat with your agents and they keep changing that software for you, pushed to your fork,
> redeployed, and — when you want — proposed back upstream as a pull request.
>
> **Program folder:** [`docs/specs/features/app-works/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/README.md)
> — 13 epics (APW-01…APW-13), plus `CONTRACTS.md` (shared names + 25 binding audit resolutions R-1…R-25),
> `EXISTING-SUBSTRATE.md`, `ACCEPTANCE.md` (the executable end-to-end suite), `TRACKER.md` (status).
> **Implementation plan:** [`docs/internal/app-works-implementation-plan.md`](https://github.com/ever-works/ever-works/blob/develop/docs/internal/app-works-implementation-plan.md).
>
> **Additive only.** Nothing existing is removed or renamed. The Repository Work kind (`repo`) keeps its
> "never generate, never deploy, never write" guarantee (`README.md:45-47`, `README.md:106-112`).
>
> **Wave 0 (prerequisite fixes, ship first):** APW-08 P0 agent git tools · APW-02 P0 checkout keys and fork
> readiness (`README.md:249`, `implementation-plan.md:57-62`).
> **Wave 1 exit:** the Cal.diy example green end to end on a user cluster (`ACCEPTANCE.md:595-649`).
> **Wave 2 / 3:** managed hosting tier behind the APW-10 launch gate, upstream pull requests, Ever ID.

**Acceptance:** the program's own suite is `ACC-E2E-01…14` (`ACCEPTANCE.md:166-649`) and `ACC-NEG-01…16`
(`ACCEPTANCE.md:650-669`); the epic is done when the Wave 1 exit criteria in
`implementation-plan.md:82-84` hold and every story's ids are `Verified` in `TRACKER.md`.

---

## 3. Stories

Every story follows the same shape. Titles, descriptions, acceptance ids and waves are given per story below;
the **Definition of Done** is identical for all thirteen and is stated once here:

> **DoD (all stories).** Every task's "Done when" line in the epic's `tasks.md` is observable; the epic's own
> `ACC-NN-nn` ids pass in the lane(s) `ACCEPTANCE.md` §3 assigns them; the epic's migrations are forward-only in
> the reserved `1792` block (`README.md:304-308`); every new user-visible string exists in all locale files
> (`README.md:321-322`); every table the epic adds is classified for the workspace backup (Resolution R-25,
> `CONTRACTS.md:68`); `TRACKER.md` is updated to `Merged`/`Verified`; the PR links the epic folder and this
> ticket.

---

### `EW-818` — APW-01 · App Work kind & create from any repository URL

**Wave:** 1 · **Size:** L · **Depends on:** APW-02 P0 (`README.md:266`)

**Description:**

> A new Work kind `app` (**App Work**), created from any GitHub repository URL, in one of three relations —
> **Link** (the caller can push), **Fork** (into the caller's own account or organization) or **Private copy**
> (a non-fork duplicate). Adds the create/inspect endpoints, the capability flags, the refusal reasons (eight
> codes), the `sourceRepository` block, and the delete semantics that keep the fork and the upstream by default.
> The `repo` kind is untouched.
>
> **Epic folder:** [`APW-01-app-work-kind/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-01-app-work-kind/)
> (`spec.md` · `plan.md` · `tasks.md`).
> **Contracts:** `CONTRACTS.md` §1 (`source`), §2 (`Work.kind = 'app'`, `WorkAppSpecState`), §7 (`works-app`,
> `EVER_WORKS_APP_WORKS_ENABLED`); Resolutions R-6, R-7, R-12, R-15.

**Acceptance ids owned:** `ACC-01-01` … `ACC-01-20` (20 ids, all Wave 1 · P1 — `spec.md:601-642`).
Exercised end to end by `ACC-E2E-01`, `ACC-E2E-02`, `ACC-E2E-03`, `ACC-E2E-04`, `ACC-E2E-11`;
`ACC-NEG-07`, `ACC-NEG-08`, `ACC-NEG-09`, `ACC-NEG-13`, `ACC-NEG-15` (`ACCEPTANCE.md:686`).

**Labels:** `app-works`, `spec-kit`, `wave-1`, `epic-apw-01` · **Components:** `API`, `Web`, `Agent`, `Docs / Spec`

---

### `EW-819` — APW-02 · Fork lifecycle

**Wave:** 0 · 1 · **Size:** L · **Depends on:** —

**Description:**

> Everything that happens to the fork after it is requested: readiness (with timeout and Try again), Actions
> hygiene on inherited workflows, scheduled upstream sync (fast-forward vs. one reusable sync pull request),
> divergence reporting, the Upstream tab, checkout-directory keys, and the conflict Task that APW-08's
> agent-resolution rule assigns. **P0** (checkout keys, must-exist clones, non-blocking fork request) ships
> independently, before anything else in the program.
>
> **Epic folder:** [`APW-02-fork-lifecycle/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-02-fork-lifecycle/).
> **Contracts:** §2 `WorkUpstreamState`; R-8 (the one Upstream tab), R-14 (public wording of existing defects),
> R-21 (conflict Task ownership), R-25.

**Acceptance ids owned:** `ACC-02-01` … `ACC-02-23` (23 ids — `spec.md:481-543`).
Exercised by `ACC-E2E-02`, `ACC-E2E-09`, `ACC-E2E-14`; `ACC-NEG-07`, `ACC-NEG-09`, `ACC-NEG-14`
(`ACCEPTANCE.md:712-742`).

**Labels:** `app-works`, `spec-kit`, `wave-0`, `wave-1`, `epic-apw-02` · **Components:** `API`, `Web`, `Agent`, `Docs / Spec`

---

### `EW-820` — APW-03 · App spec, Apps catalog, licence gate

**Wave:** 1 · **Size:** L · **Depends on:** —

**Description:**

> The App spec — the `spec` block of `.works/works.yml` for `kind: app` — plus its JSON Schema and validator, the
> runtime-loaded Apps catalog (`ever-works/apps`), Blueprint resolution (manifest match → topic scan →
> Provisioner), and the licence gate: `licenses.yml` classes green/amber/red, the owner's attestation record, and
> the eligibility APW-06 reads. Nothing else in the program can start without this epic's shared contracts.
>
> **Epic folder:** [`APW-03-app-spec-and-catalog/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-03-app-spec-and-catalog/)
> (`spec.md` · `plan.md` · `tasks.md` · `schema.md` · `catalog.md` · `user-doc-draft.md`).
> **Contracts:** `CONTRACTS.md` §1 (the whole App spec), §2A, §4, §8; Resolutions R-3 (attestation), R-4 (first
> write), R-11, R-13.

**Acceptance ids owned:** `ACC-03-01` … `ACC-03-49` (49 ids — `spec.md` §8).
Exercised by `ACC-E2E-01`, `ACC-E2E-05`, `ACC-E2E-14`; `ACC-NEG-01`, `ACC-NEG-02`, `ACC-NEG-06`
(`ACCEPTANCE.md:743-801`).

**Labels:** `app-works`, `spec-kit`, `wave-1`, `epic-apw-03` · **Components:** `API`, `Web`, `Agent`, `Docs / Spec`

> **Blocked by an owner action at filing time:** the catalog repositories `ever-works/apps` and
> `ever-works/app-fixture-hello` must exist (`implementation-plan.md:47`, `CONTRACTS.md:430-432`).

---

### `EW-821` — APW-04 · App Provisioner

**Wave:** 1 · **Size:** XL · **Depends on:** APW-01, APW-03, APW-05, APW-06 (`README.md:269`)

**Description:**

> The "AI decides how to run it" path for repositories with no App Blueprint: an Agent created from the
> **App Provisioner** template running the **`provision-app`** Skill in an isolated sandbox with no secrets and
> restricted egress, which studies the repository and delivers an App spec (plus an overlay Dockerfile only when
> needed) as a pull request, then drives the verification loop — schema validation, a Build, an ephemeral boot
> and the spec's smoke tests — before the proposal is verified.
>
> **Epic folder:** [`APW-04-app-provisioner/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-04-app-provisioner/).
> **Contracts:** §2 `WorkAppProvisioning`; §3 capability interfaces; §7 `EVER_WORKS_APP_PROVISION_TOKEN_CAP`,
> `EVER_WORKS_APP_PROVISION_RUNNER_MINUTE_CAP`; Resolutions R-10 (verification hooks), R-17 (safety rails).

**Acceptance ids owned:** `ACC-04-01` … `ACC-04-38` (38 ids — `spec.md` §8).
Exercised by `ACC-E2E-06`; `ACC-NEG-05` (`ACCEPTANCE.md:802-846`).

**Labels:** `app-works`, `spec-kit`, `wave-1`, `epic-apw-04` · **Components:** `Agent`, `API`, `Plugins`, `Web`, `Docs / Spec`

---

### `EW-822` — APW-05 · Builds

**Wave:** 1 · 3 · **Size:** L · **Depends on:** APW-03 (`README.md:270`)

**Description:**

> The `build` capability and its first plugin: one Ever Works workflow written into the Work Repository, building
> on GitHub-hosted runners in the user's own repository (the user's minutes, the user's blast radius), reporting
> through the existing GitHub event intake with polling as a fallback, producing an image by digest, with a cost
> receipt on every Build and the checks matrix (Resolution R-9). Wave 3 adds the sandboxed in-zone builder for
> the managed tier.
>
> **Epic folder:** [`APW-05-builds/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-05-builds/).
> **Contracts:** §2 `WorkBuild`, §9 (names written into the Work Repository); Resolutions R-9, R-13, R-24.

**Acceptance ids owned:** `ACC-05-01` … `ACC-05-30` (30 ids — `spec.md` §8). `ACC-05-26…28` are Wave 3 and carry
operator evidence (`ACCEPTANCE.md:1280`). Exercised by `ACC-E2E-07`, `ACC-E2E-14`; `ACC-NEG-10`
(`ACCEPTANCE.md:847-888`).

**Labels:** `app-works`, `spec-kit`, `wave-1`, `wave-3`, `epic-apw-05` · **Components:** `Plugins`, `API`, `Web`, `Agent`, `Docs / Spec`

---

### `EW-823` — APW-06 · App runtime on Kubernetes

**Wave:** 1–3 · **Size:** XL · **Depends on:** APW-03, APW-05, APW-07 (`README.md:271`)

**Description:**

> Renders an App spec into workloads on the existing `k8s` deploy plugin: several components (web, worker),
> init/migrate Jobs, CronJobs, probes, volumes, resource hints and App dependencies, across three deploy targets
> — **None**, **Your cluster** (custom kubeconfig) and **Ever Works Apps** (managed, gated and handed to APW-10's
> controller as desired state, never applied by the platform — Resolution R-5). Adds managed subdomains and
> custom domains, in-cluster smoke tests, health and status, pause/resume, and deletion that keeps stored data
> unless explicitly told otherwise.
>
> **Epic folder:** [`APW-06-app-runtime/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-06-app-runtime/).
> **Contracts:** §2 `WorkDeployment` extensions + `WorkAppRuntimeState`, §7 `EVER_WORKS_APPS_*`; Resolutions
> R-5, R-12, R-15, R-16, R-24.

**Acceptance ids owned:** `ACC-06-01` … `ACC-06-49` (49 ids — `spec.md` §8). Exercised by `ACC-E2E-05`,

> `ACC-E2E-10`, `ACC-E2E-11`, `ACC-E2E-14`; `ACC-NEG-01`, `ACC-NEG-02`, `ACC-NEG-03`, `ACC-NEG-07`,
> `ACC-NEG-11`, `ACC-NEG-12` (`ACCEPTANCE.md:889-947`).

**Labels:** `app-works`, `spec-kit`, `wave-1`, `wave-2`, `wave-3`, `epic-apw-06` · **Components:** `Plugins`, `API`, `Web`, `Agent`, `Platform / Infra`, `Docs / Spec`

---

### `EW-824` — APW-07 · App env & dependencies

**Wave:** 1 · 2 · **Size:** L · **Depends on:** APW-03 (`README.md:272`)

**Description:**

> The schema-driven env and secret store — generated (typed generators with validation), derived, prompted and
> defaulted values, each flagged build-time or run-time, stored encrypted per App Work and rendered into a
> Secret — plus per-App-Work dependencies: Postgres, Redis, S3-compatible object storage and SMTP, provisioned
> in-namespace on a user cluster (operator-backed when the operator exists) and on tenant-only data servers on
> the managed tier. Generated values are generated once and never rotated implicitly.
>
> **Epic folder:** [`APW-07-app-env-and-dependencies/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-07-app-env-and-dependencies/).
> **Contracts:** §2 `WorkAppEnvValue`, `WorkAppDependency`; Resolution R-11 (keypair formats), R-25 (backup
> classification — env values and connection outputs are dropped or redacted).

**Acceptance ids owned:** `ACC-07-01` … `ACC-07-31` (31 ids — `spec.md` §8). Exercised by `ACC-E2E-05`,
`ACC-E2E-14`; `ACC-NEG-07`, `ACC-NEG-12` (`ACCEPTANCE.md:948-988`).

**Labels:** `app-works`, `spec-kit`, `wave-1`, `wave-2`, `epic-apw-07` · **Components:** `API`, `Agent`, `Plugins`, `Web`, `Docs / Spec`

---

### `EW-825` — APW-08 · Evolve loop

**Wave:** 0 · 1 · **Size:** L · **Depends on:** APW-01, APW-05, APW-06 (`README.md:273`)

**Description:**

> "Chat → change → live" on an App Work: a Task on the Work Repository, task isolation, the App spec's checks as
> quality gates, the existing merge policy, then a delivery chain — merge to the default branch → Build →
> Deployment — with Goals and Missions scoped to App Works and every step in Activity. **P0** is the agent git
> tools fix (`commitToRepo` / `openPullRequest` bindings), which ships as its own independent PR before
> anything else.
>
> **Epic folder:** [`APW-08-evolve-loop/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-08-evolve-loop/).
> **Contracts:** §2 `Task` extensions, `Goal.workId`, `Mission.outputMode`; Resolutions R-17 (safety rails),
> R-21 (agent-resolution rule), R-25.

**Acceptance ids owned:** `ACC-08-01` … `ACC-08-32` (32 ids — `spec.md` §8). Exercised by `ACC-E2E-07`,
`ACC-E2E-11`; `ACC-NEG-04`, `ACC-NEG-05`, `ACC-NEG-14` (`ACCEPTANCE.md:989-1030`).

**Labels:** `app-works`, `spec-kit`, `wave-0`, `wave-1`, `epic-apw-08` · **Components:** `Agent`, `API`, `Web`, `Docs / Spec`

---

### `EW-826` — APW-09 · Upstream pull requests

**Wave:** 1 · 2 · **Size:** M · **Depends on:** APW-02, APW-08 (`README.md:274`)

> **Wave note.** `TRACKER.md:31-32` records that APW-09 **P1** belongs to the Wave 1 foundations lane, not
> Wave 2 — its own spec says so (`APW-09-upstream-pull-requests/spec.md:7`: "Wave 1 (P1 foundations), Wave 2
> (P2–P3)"), and the tracker row was corrected to match on 2026-09-17. The story therefore carries `wave-1`
> **and** `wave-2` labels. `README.md:251`'s wave table does not yet list APW-09 under Wave 1 — see
> `contradictions.md` D-1.

**Description:**

> Opt-in, always human-approved, rate-limited proposals back to the upstream project: preparation reads the
> upstream's `CONTRIBUTING` / `AGENTS.md` and AI-disclosure rules, the platform never signs a CLA or DCO on the
> user's behalf, never merges upstream, and adds the "Upstream pull requests" section to APW-02's Upstream tab
> (Resolution R-8). Withdraw deletes the fork branch.
>
> **Epic folder:** [`APW-09-upstream-pull-requests/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-09-upstream-pull-requests/).
> **Contracts:** §2 `UpstreamPullRequest`; Resolutions R-8, R-18 (approval maps to the `publish` rung and is never
> approvable in bulk).

**Acceptance ids owned:** `ACC-09-01` … `ACC-09-23` (23 ids — `spec.md` §8).
Exercised by `ACC-E2E-08`; `ACC-NEG-06` (`ACCEPTANCE.md:1031-1061`).

**Labels:** `app-works`, `spec-kit`, `wave-2`, `epic-apw-09` · **Components:** `API`, `Agent`, `Web`, `Docs / Spec`

---

### `EW-827` — APW-10 · Ever Works Apps hosting tier (launch gate)

**Wave:** 2 · 3 · **Size:** XL · **Depends on:** — for P1; APW-03/06/07 for P2; APW-05 for P3 (`README.md:275`)

**Description:**

> The tier that runs user-controlled code: a closed, versioned launch gate (items `LG-01`…`LG-25`) where every
> item is either an automated check run from inside a real tenant sandbox or an expiring operator attestation,
> and the platform refuses to open the tier unless the latest self-check is green, under 24 hours old and every
> attestation is current. Around the gate: an in-zone controller the platform instructs only by writing desired
> state (platform servers hold no cluster-admin credential), per-App-Work **Quarantine** with an admin surface,
> quota profiles, per-tenant metering that becomes usage receipts, and abuse signals.
>
> **Epic folder:** [`APW-10-apps-hosting-tier/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-10-apps-hosting-tier/).
> **Contracts:** §2 `apps_tier_*` tables + `works.appsTierQuotaProfile`; §7 `EVER_WORKS_APPS_MANAGED_ENABLED`,
> `EVER_WORKS_APPS_MAX_SCOPE`, `EVER_WORKS_APPS_CONTROL_*`; Resolutions R-5, R-20, R-24.

**Acceptance ids owned:** `ACC-10-01` … `ACC-10-48` (48 ids — `spec.md` §8). Operator-evidence ids:
`ACC-10-02, 05, 06, 08…19, 21, 29, 32…34, 46` (`ACCEPTANCE.md:1279-1280`). Exercised by `ACC-E2E-10`;
`ACC-NEG-03` (`ACCEPTANCE.md:1062-1118`).

**Labels:** `app-works`, `spec-kit`, `wave-2`, `wave-3`, `epic-apw-10`, `operator-action` · **Components:** `Platform / Infra`, `Plugins`, `API`, `Web`, `Docs / Spec`

> **Held by open items:** the tier's location, its apex domain, prices, sandbox compatibility, the abuse rota and
> the post-removal retention window are all unresolved in `spec.md:618-629` — see `decision-sheet.md` §B. Two of
> them (location, domain) are already answered by the owner and now _contradict_ the text in this epic — see
> `contradictions.md`.

---

### `EW-828` — APW-11 · App Launcher & Apps registry API

**Wave:** 1 · 3 · **Size:** M · **Depends on:** APW-06 for P2 (`README.md:276`)

**Description:**

> The cross-platform switcher, shipped **before** single sign-on (D14): a framework-neutral web component fed by
> a static platform catalog plus the signed-in person's App Works that expose a URL (`GET /api/me/apps`), with
> per-person visibility and ordering, and a delegated read-only `apps:read` token for other Ever products in P2.
> Phase 1 is the in-product launcher; P2 is the publishable component.
>
> **Epic folder:** [`APW-11-app-launcher/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-11-app-launcher/).
> **Contracts:** §2 `AppLauncherPreference`, `Work.appLauncherExposed`; §7 `app-launcher`,
> `EVER_WORKS_APP_LAUNCHER_ENABLED`, `EVER_WORKS_PLATFORM_CATALOG_*`; Resolution R-19 (delegated auth method).

**Acceptance ids owned:** `ACC-11-01` … `ACC-11-40` (40 ids — `spec.md` §8).
Exercised by `ACC-E2E-12`; `ACC-NEG-11` (`ACCEPTANCE.md:1119-1166`).

**Labels:** `app-works`, `spec-kit`, `wave-1`, `wave-3`, `epic-apw-11` · **Components:** `Web`, `API`, `Agent`, `Docs / Spec`

---

### `EW-829` — APW-12 · Ever ID

**Wave:** 2 · 3 · **Size:** XL · **Depends on:** — · **Labels add:** `cross-repo`

**Description:**

> One identity across Ever platforms, integrated only through standard OpenID Connect, as a **pure addition**:
> every platform keeps its own authentication and its own user database, duplicated profiles are accepted, and no
> existing sign-in flow changes. The provider is **ZITADEL**, self-hosted as-is and unmodified (owner decision,
> 2026-09-17 — `idp-options.md` §6–§7). Ever Gauzy's integration is a **per-provider plugin, not core**; provider
> plugins are named per provider (`zitadel`, `keycloak`, `supertokens`, `auth0`), with Keycloak's existing core
> scaffolding moved into a plugin and SuperTokens added as an optional self-hoster plugin. Ships "Sign in with
> Ever ID" on Ever Works first (Wave 2), then Ever Teams, then Ever Gauzy behind an off-by-default flag.
>
> **Epic folder:** [`APW-12-ever-id/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-12-ever-id/)
> (`spec.md` · `plan.md` · `tasks.md` · `idp-options.md` · `cross-platform.md`).
> **Contracts:** §2 `ExternalIdentity`; §7 `ever-id`; Resolution R-19 (`authMethod` gains `'ever-id-delegated'`,
> admitted only on `@DelegatedRead(scope)` routes).

**Acceptance ids owned:** `ACC-12-01` … `ACC-12-40` (40 ids — `spec.md:481-582`) **plus** the 12 cross-repository
ids `XP-T-01…06` and `XP-G-01…06` (`cross-platform.md`), whose tests live in `ever-co/ever-teams` and
`ever-co/ever-gauzy` and are therefore **not** deliverable by an Ever Works PR alone. Exercised by `ACC-E2E-13`;
`ACC-12-40` is the manual production-flag gate (`ACCEPTANCE.md:1275-1277`).

**Labels:** `app-works`, `spec-kit`, `wave-2`, `wave-3`, `epic-apw-12`, `cross-repo` · **Components:** `API`, `Web`, `Plugins`, `Cross-repo`, `Docs / Spec`

> **Held by open items:** six in `spec.md:588-600`, of which the **provider is answered** (ZITADEL) and the
> **domain is not**. Three further questions in `cross-platform.md:352-360` and the configuration rows D2–D9 in
> `idp-options.md` §6 are also open. See `decision-sheet.md` §A.

---

### `EW-830` — APW-13 · Golden paths & acceptance suite

**Wave:** 1 · 2 · **Size:** L · **Depends on:** APW-01…08 (`README.md:278`)

**Description:**

> The proof: a fixture application, Umami and **Cal.diy** App Blueprints, the fake-GitHub harness, and the four
> CI lanes (PR, PR — cluster, nightly, golden path) that run the program's acceptance scenarios end to end —
> culminating in **the owner's Cal.diy example green on a user cluster** (Wave 1 exit,
> `implementation-plan.md:80-84`). Owns `ACCEPTANCE.md`'s live scenarios, the Blueprint `verified` state machine
> (pass streaks), and the catalog evidence PRs.
>
> **Epic folder:** [`APW-13-golden-paths/`](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-13-golden-paths/)
> (`spec.md` · `plan.md` · `tasks.md` · `blueprints/`).
> **Contracts:** §7 `EVER_WORKS_E2E_FAKES`; Resolution R-23 (fixture branches).

**Acceptance ids owned:** `ACC-13-01` … `ACC-13-20` (20 ids — `spec.md` §8), plus ownership of the live half of
`ACC-E2E-01…14` and `ACC-NEG-01…16` and of the regression pack in `ACCEPTANCE.md` §5.

**Labels:** `app-works`, `spec-kit`, `wave-1`, `wave-2`, `epic-apw-13`, `operator-action` · **Components:** `Platform / Infra`, `Web`, `API`, `Docs / Spec`

> **Held by open items:** the test estate (GitHub test organization, test user, test clusters, model-spend
> budget) is an **owner action** that no PR can complete — `tasks.md:221-237` T20/T21, `ACCEPTANCE.md:80-97`,
> `implementation-plan.md:48`. See `decision-sheet.md` §J (rows J-01, J-02, J-03, J-08).

---

## 4. Filing checklist (owner actions inside these tickets)

| Ticket   | Owner action                                                                                                                                                                                                                            | Source                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `EW-817` | File the epic + 13 stories; paste the real keys into `TRACKER.md:14-26` (replacing `EW-TBD`).                                                                                                                                           | `TRACKER.md:9-10`, `implementation-plan.md:46`   |
| `EW-820` | Create `ever-works/apps`, `ever-works/app-fixture-hello`, `ever-works/cal-diy-template`, `ever-works/umami-template`.                                                                                                                   | `implementation-plan.md:47`                      |
| `EW-829` | Approve the Ever ID **domain**; confirm ZITADEL's configuration rows D2–D9.                                                                                                                                                             | `spec.md:588`, `idp-options.md` §6               |
| `EW-827` | Approve the tier's location wording, the addressing decision (no PSL apex), prices, the abuse rota, the retention window.                                                                                                               | `spec.md:618-629` + `contradictions.md`          |
| `EW-830` | Create the GitHub test organization, `<e2e-user>` machine user, test cluster(s), canary sink, DNS test zone and the dedicated model-spend budget; add the `app-works-dev` / `app-works-stage` environments and their secrets/variables. | `tasks.md:221-237`, `ACCEPTANCE.md:80-123`       |
| `EW-828` | Approve the publishing home of the App Launcher web component and the `ever-works/platforms` catalog.                                                                                                                                   | `README.md:349-350`, `implementation-plan.md:52` |

---

## 5. What is _not_ in these tickets

- **No ticket per task.** Each epic's `tasks.md` is the granular breakdown (e.g. APW-01 `tasks.md:42-609`,
  T1…T39). If the project wants task-level Jira issues, they are filed from those files after the story keys
  exist — they are not drafted here.
- **No ticket for the private operations work.** The managed-tier infrastructure plan, the operator drills and
  the estate addresses live in the private operations repository by program rule 10 (`README.md:317-320`) and are
  tracked there, not in `EW`.
- **No ticket for the Cross-platform (Ever Teams / Ever Gauzy) work.** `XP-T-*` and `XP-G-*` are those repos'
  own work; `EW-829` references them and `ACC-12-40` gates on them.
