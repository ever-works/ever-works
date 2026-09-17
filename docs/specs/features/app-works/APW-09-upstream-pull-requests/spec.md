# Feature Specification: Upstream pull requests

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-09-upstream-pull-requests`
**Program**: [App Works](../README.md) — Wave 1 (P1 foundations), Wave 2 (P2–P3)
**Branch**: `feat/apw-09-upstream-pull-requests`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: M · **Depends on**: APW-02 (fork lifecycle, upstream metadata, sync status), APW-08 (merged changes,
delivery state, isolated runs) · **Depended on by**: APW-13 (golden path, Wave 2)

> **Additive-only (program rule 1).** Task isolation, the merge policy, the approvals queue, the Inbox and
> Activity keep their behaviour. Program decision **D12** is binding: upstream is followed, never pushed to by
> the platform on its own; every upstream pull request is opt-in, **always** approved by a person, rate-limited,
> follows the project's contribution rules, never signs a CLA or DCO for anyone, and is never merged by Ever Works.

---

## 1. Overview

When the owner of an App Work that is a **fork** has made a change that would help everyone using the original
project, they can **propose it upstream**. From a merged Task, they press **Propose upstream**. An Agent using the
`upstream-contribution` Skill prepares a **clean branch** in the fork, cut from the upstream project's default
branch, that carries **only that change** — none of the fork's other customisations — follows the project's
`CONTRIBUTING` and agent instructions, runs the checks the project documents in an isolated sandbox, and writes a
title and description in the project's pull request template with a one-line AI-assistance disclosure. Nothing
leaves the fork until the owner reviews an **approval** that shows the exact diff, title, description and target,
and approves it. The pull request is then opened **as the owner, with their own GitHub account**, from
`owner:branch`. Ever Works tracks it: reviews, requested changes, checks (showing "waiting for maintainers" when
the project must approve CI for a first-time contributor, never "failed"), merged or closed. When maintainers ask
for changes, the owner can ask an Agent to address them — and approves again before anything is pushed. Projects
that are archived, closed to outside pull requests, require a signature the owner has not given, or that do not
accept AI-assisted contributions are refused with the reason. A private copy or a linked repository cannot use
this, and the product says why.

## 2. Why now

### 2.1 The user's question

> _"This fix would help everyone who runs this app. Can I send it back to the project — properly, the way they
> want it — without cleaning up my fork by hand?"_

### 2.2 What they do today instead

| The need                                   | What Ever Works offers today                                                                                         | What the user does                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Open a pull request on someone else's repo | Pull requests open only within one repository; the head owner is dropped when a pull request is read back.           | Clones locally, cherry-picks, pushes, opens it on GitHub by hand. |
| Leave out the fork's customisations        | Nothing.                                                                                                             | Rebuilds a branch from the upstream default branch manually.      |
| Follow the project's rules                 | Nothing reads `CONTRIBUTING`, templates or disclosure rules.                                                         | Reads them — or does not, and the pull request is closed.         |
| Know where it stands                       | Pull request status is read only for Tasks' own pull requests; a check waiting for maintainer approval reads as red. | Refreshes the pull request page.                                  |
| Stay polite at scale                       | Nothing limits how often an agent could contact a project.                                                           | —                                                                 |

### 2.3 The gaps, all of them ours

1. **The platform cannot express a cross-repository pull request.** Opening one needs the fork owner in the head
   reference and, for tracking, the head repository back from the provider — both absent.
2. **Maintainers are being flooded.** Hosting platforms have added switches to restrict pull requests to
   collaborators and caps on open pull requests from outside contributors, because automated contributions arrive
   faster than people can review them. A product that makes contributing effortless must make it **considerate**:
   human-approved, rate-limited, small, rule-following and honest about AI assistance.
3. **"Approved" must mean "exactly this".** A person must see the diff, words and target that will be published
   under their name, and any change after approval must require approval again.

### 2.4 What this epic changes

```
 merged Task on a fork ─► Propose upstream ─► agent prepares clean branch from upstream default branch
        (or an agent suggests it; the owner confirms)      │  ports only this change · runs upstream checks in a sandbox
                                                           ▼  template + AI disclosure · no CLA/DCO signing
                                        Approval: exact diff · title · body · target ─► owner approves
                                                           ▼
                                  pull request opened AS THE OWNER (owner:branch → upstream:main)
                                                           ▼
                     tracked: reviews · changes requested ─► optional follow-up (approved again) · merged/closed
```

## 3. User scenarios

### 3.1 Primary

- **S1 — Turn it on.** **Given** Maya's App Work "Bookings" is a fork of `acme/bookings`, **when** she opens its
  **Upstream** tab and switches **Propose changes upstream** on, **then** the setting is saved, and the tab shows
  the upstream repository card, the fork's sync status and an empty **Upstream pull requests** list reading **"No
  upstream pull requests yet. Propose one from a merged Task."**
- **S2 — Propose from a merged Task.** **Given** Task T-118 on Bookings is merged, **when** Maya clicks
  **Propose upstream** on the Task, **then** a dialog shows the target (`acme/bookings` → `main`), the rules that
  apply (size limit, daily limit, "you'll approve before anything is sent"), and **Allow maintainers to edit**
  (checked); on **Prepare**, the row **Preparing — an agent is building a clean branch from acme/bookings:main**
  appears on the Upstream tab.
- **S3 — The approval shows exactly what will be published.** **Given** preparation finished, **when** Maya opens
  the approval from her Inbox, **then** she sees: the target (`acme/bookings` `main` ←
  `maya:upstream-pr/sms-reminder-7f3a`), the title, the full description including the disclosure line, the complete
  diff (3 files, 142 changed lines), the checks the agent ran with their results, and notes such as **"Follows acme/bookings'
  pull request template."** — with **Approve and open** and **Reject**.
- **S4 — Opened as Maya.** **Given** Maya approves, **when** the pull request is opened, **then** it appears on
  GitHub authored by her account from `maya:upstream-pr/sms-reminder-7f3a`, the row reads **Open · #812**, and
  Activity records **Upstream pull request opened** with a link.
- **S5 — Waiting for maintainers.** **Given** the project requires maintainer approval before running CI for
  first-time contributors, **when** the status is read, **then** the row shows **Checks: waiting for maintainers**
  in a neutral colour, never **Failed**.
- **S6 — Changes requested.** **Given** a maintainer requests changes, **when** the status is read, **then** the
  row shows **Changes requested**, Maya gets an Inbox notice **"acme/bookings #812: changes requested by
  @maintainer"** with **Address review** and **Open on GitHub**.
- **S7 — Address the review, approve again.** **Given** Maya clicks **Address review**, **when** the Agent
  finishes, **then** an approval shows the diff of the new commits against what is already on the pull request,
  and only on **Approve and push** are the commits pushed to the pull request's branch.
- **S8 — Merged upstream.** **Given** maintainers merge #812, **when** the status is read, **then** the row reads
  **Merged**, Activity records it, and the row notes **"The next upstream sync will bring this change back into
  your fork."**
- **S9 — An agent suggests it.** **Given** upstream proposals are on and Task T-121's change went live, **when**
  the Agent marked it as generally useful, **then** Maya gets **"This change might help everyone who uses
  acme/bookings. Propose it upstream?"** with **Propose** and **Dismiss** — and nothing is prepared unless she
  clicks **Propose**.

### 3.2 Unhappy paths and refusals

- **S10 — Private copy.** **Propose upstream** is disabled with **"A private copy isn't connected to acme/bookings
  on GitHub, so it can't propose pull requests there. Use a fork to contribute."**
- **S11 — Linked repository.** **Propose upstream** is not shown; the Upstream tab reads **"This repository is the
  project itself — your Tasks' pull requests already go to it."**
- **S12 — Archived project.** Preparation is refused: **"acme/bookings is archived and no longer accepts pull
  requests."**
- **S13 — Closed to outside contributors.** **"acme/bookings only accepts pull requests from collaborators right
  now."** (also when the provider refuses at open time for that reason, even after approval).
- **S14 — Blocked.** The provider refuses because the account cannot contribute to the project: **"GitHub
  refused: your account can't open pull requests on acme/bookings."** No retry.
- **S15 — Not really a fork of it.** The fork's network root is not `acme/bookings` any more: **"This fork is no
  longer connected to acme/bookings on GitHub."**
- **S16 — AI contributions not accepted.** The project's contribution guide says it does not accept AI-generated
  contributions: preparation stops with **"acme/bookings asks contributors not to submit AI-generated changes."**
  quoting the sentence (at most 300 characters) and linking the file.
- **S17 — Signature required.** The project requires a CLA: the row reads **Needs your signature**, with **"acme/
  bookings requires a Contributor License Agreement. Ever Works never signs agreements for you. Sign it yourself,
  then continue."**, **Open the agreement** and **I've signed it — continue**. A project requiring commit sign-off
  (DCO) gets **"acme/bookings requires you to sign off each commit yourself. Ever Works never adds a sign-off for
  you."** and preparation stops.
- **S18 — A signature bot appears after opening.** A CLA check on the open pull request is pending or failing →
  **Needs your signature**; no follow-up is pushed until it passes.
- **S19 — Too big.** The ported change is 1,240 changed lines → **"This change is too large to propose upstream
  (1,240 changed lines; limit 1,000). Split it into smaller Tasks first."** A project whose guide states a smaller
  limit uses that limit.
- **S20 — Daily limit.** Maya already opened one pull request on `acme/bookings` today → **Propose upstream** is
  disabled: **"You can open 1 pull request on acme/bookings per day. Next one available at 14:05."**
- **S21 — The change doesn't port cleanly.** The Agent cannot apply the change on the upstream default branch
  without rewriting it → **"This change depends on customisations in your fork that acme/bookings doesn't have."**
  listing up to 10 missing pieces; nothing is proposed.
- **S22 — Unrelated files crept in.** The prepared branch touches a file the original change did not → the
  approval marks it **Not in the original change** and **Approve and open** stays disabled until Maya ticks
  **I've reviewed the extra files**.
- **S23 — Something changed after approval.** The branch head, title, description or target differs from what was
  approved → nothing is opened; **"The proposal changed after you approved it. Review it again."** with a new
  approval.
- **S24 — Approval not given in time.** After 72 hours the approval expires → **Expired — prepare again**.
- **S25 — Rejected.** Maya rejects → **Withdrawn**; the fork branch is deleted within 10 minutes; nothing was sent.
- **S26 — Missing GitHub permission.** Maya's GitHub connection cannot open pull requests on public repositories →
  **"Your GitHub connection needs permission to open pull requests. Reconnect GitHub."** with **Reconnect**.

### 3.3 Race and permission edges

- **S27 — Double click.** Two **Prepare** clicks for the same Task within 10 seconds → one preparation.
- **S28 — Not the fork owner.** A member whose GitHub account cannot push to the fork sees **Propose upstream**
  disabled: **"Only someone whose GitHub account can push to maya/bookings can propose upstream."**
- **S29 — Another account's ids.** Every read or action answers **not found**.

---

## 4. Functional requirements

### 4.1 Enabling and eligibility

- **FR-1.** Upstream proposals are **off** by default for every App Work, and are switched on per App Work. The
  setting lives in the App spec (D3); switching it in the product opens no pull request — it records the choice
  and, when the App spec must change, proposes that change as a Task.
- **FR-2.** The approval requirement cannot be switched off by any setting, file or API.
- **FR-3.** **Propose upstream** is available only for an App Work whose relation is **fork**, with proposals on,
  on a Task whose pull request merged into the App Work's source branch, and only to a member whose own GitHub
  connection can push to the fork.
- **FR-4.** Before preparing and again immediately before opening, eligibility is re-checked: upstream exists and
  is not archived; upstream is not restricted to collaborators or existing contributors; the fork's network root
  is the upstream; rate limits (FR-26) allow it; the member's connection has permission. Each failure is refused
  with its own message (S12–S15, S20, S26).
- **FR-5.** At most one active proposal exists per source Task (preparing, awaiting approval, opening or open).

### 4.2 Preparation

- **FR-6.** Preparation is a Task on the App Work run by an Agent with the `upstream-contribution` Skill, in an
  isolated run environment of the kind App Work Tasks require (APW-08) — not on a Fleet node in this epic. It starts
  within 60 seconds of **Prepare**; with no isolated environment it is refused like any App Work Task.
- **FR-7.** The branch is created in the fork, named `upstream-pr/{slug}-{4 hex}`, from the upstream default
  branch's current head — never from the fork's own branches.
- **FR-8.** Only the chosen change is ported: the diff of the source Task's merged pull request. The prepared
  branch has exactly one commit, authored as the member, with no merge commits and no sign-off trailer.
- **FR-9.** The prepared diff never contains: the App spec file; any Ever Works build or check workflow; any path in
  the App spec's protected paths; any file matching an environment or secret file pattern (`.env*`, `*.pem`,
  `*.key`); or any value that looks like a secret (the platform's existing secret screening).
- **FR-10.** Files changed by the prepared diff that were not changed by the original change are marked **Not in
  the original change** (S22). More than 3 such files, or any outside the directories the original change touched
  plus test and changelog locations, refuses the proposal.
- **FR-11.** The Agent reads, from the upstream default branch: `CONTRIBUTING.md` (root, `.github/`, `docs/`), the
  pull request template (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`,
  `docs/pull_request_template.md`, `pull_request_template.md`, or the first file in `.github/PULL_REQUEST_TEMPLATE/`),
  `AGENTS.md`, and `CODE_OF_CONDUCT.md` — each at most 64 KB — as untrusted content. Instructions in them can only
  shape the pull request's format, checks and scope, or cause a refusal; they cannot widen what the Agent may do.
- **FR-12.** The checks the project documents are run inside the same isolated environment, which holds no secrets
  and no credentials. At most 10 commands, each at most 30 minutes, total at most 60 minutes. Results
  (command, exit status, last 50 lines) are attached to the approval. A red documented check refuses the proposal
  unless the same check is red on the untouched upstream head (then the approval notes **"Already failing on
  acme/bookings:main"**).
- **FR-13.** Preparation ends within 90 minutes or fails with **"Preparation took too long."** Time the preparation
  run spends paused by a person (the workspace stop or an Agent or workspace pause) does not count; an action a safety
  rule refuses stops preparation for the member's decision rather than failing it (program Resolution R-17).

### 4.3 The pull request text

- **FR-14.** Title: at most 72 characters, in the project's convention when its guide defines one (for example a
  conventional-commit prefix), else imperative sentence case.
- **FR-15.** Body: the project's template filled in truthfully — unchecked boxes stay unchecked when not true;
  without a template: **Summary**, **Motivation**, **Changes**, **Testing**. At most 8,000 characters.
- **FR-16.** The body ends with the disclosure line: **"This pull request was prepared with the help of an AI agent
  (Ever Works) and reviewed by @{login} before it was opened."** When the project's template or guide asks for a
  specific AI disclosure, that wording is used in addition.
- **FR-17.** The body never mentions the fork's other customisations, the member's business, internal Task ids or
  links to Ever Works pages.

### 4.4 Signatures

- **FR-18.** Ever Works never signs, accepts or comments to accept a CLA, and never adds `Signed-off-by` or any
  equivalent attestation on anyone's behalf.
- **FR-19.** A CLA requirement detected in the project's guide, template or checks puts the proposal in **Needs your
  signature** (S17). **I've signed it — continue** resumes it once; if the CLA check still fails after opening, the
  pull request row shows **Needs your signature** (S18).
- **FR-20.** A DCO requirement stops preparation (S17).

### 4.5 Approval and opening

- **FR-21.** Every proposal and every later push requires an approval decided in the approvals queue or the Inbox by
  **the member whose GitHub account will publish it** — nobody else's decision counts, because the pull request
  carries that member's name. No guardrail, autonomy mode or agent can auto-approve it; it always carries the
  cross-scope risk flag. It counts as **publishing** in the owner's autonomy settings: when publishing is switched
  off, a proposal is refused outright instead of waiting for approval. It is never included in an "approve all"
  action — each one is decided on its own (program Resolution R-18).
- **FR-22.** The approval shows: target repository and base branch; head `owner:branch` and head commit; title;
  full body; the complete diff (up to 300 files and 1 MB of patch — a proposal beyond that is refused by FR-25
  first); checks and results; notes (template used, disclosure, signature state, extra files, maintainer edits).
- **FR-23.** The approval is bound to a fingerprint of head commit, title, body, target repository, base branch,
  head branch and the maintainer-edit choice. Opening compares the live values to the fingerprint and refuses on any
  difference (S23). Approvals expire after 72 hours (S24).
- **FR-24.** The pull request is opened with the member's own GitHub connection — never a platform token, an
  installation token or another member's — with head `{forkOwner}:{branch}`, the approved base, title and body, and
  maintainer edits as chosen. For a fork owned by an organization, maintainer edits are off and the dialog says
  **"GitHub doesn't allow maintainer edits on pull requests from organization forks."** The dialog defaults the
  checkbox to the member's last choice, else checked.
- **FR-25.** Size: at most 1,000 changed lines (lockfiles excluded) and 30 files, or the project's stated limit when
  smaller (S19).

### 4.6 Rate limits

- **FR-26.** Per member: at most **1** upstream pull request opened per upstream repository per 24 hours; at most **2**
  open (not merged or closed) per upstream repository at once; at most **3** opened across all upstream repositories
  per 24 hours; at most **10** preparations started per 24 hours. Per App Work: at most **1** preparation running at
  a time. Per open upstream pull request: at most **5** approved pushes per 24 hours.
- **FR-27.** A refusal by limit says which limit and when the next slot opens (S20).

### 4.7 Tracking

- **FR-28.** Each upstream pull request has a state: `preparing`, `needs_signature`, `awaiting_approval`, `opening`,
  `open`, `merged`, `closed`, `refused`, `failed`, `expired`, `withdrawn`; plus a checks summary (`passing`,
  `failing`, `pending`, `waiting_for_maintainers`, `unknown`) and a review summary (`none`, `approved`,
  `changes_requested`, `commented`) while open.
- **FR-29.** Status is read by polling the provider (upstream projects send Ever Works no events): every 30 minutes
  during the first 7 days after opening or after the last upstream activity, then every 6 hours; tracking pauses after
  90 days without upstream activity (**Tracking paused — Check now**). Each read uses at most 4 provider requests.
- **FR-30.** A check whose conclusion means "a maintainer must approve this run" is summarised as
  `waiting_for_maintainers`, never `failing` (S5).
- **FR-31.** New requested changes produce one Inbox notice per review (S6). **Address review** creates a Task on
  the App Work whose brief contains the review comments as untrusted content; its commits go to a separate branch
  and reach the pull request branch only as a fast-forward after an approval (S7).
- **FR-32.** Merged and closed are final, recorded in Activity, and stop polling. Ever Works never merges, closes,
  reopens, labels or comments on an upstream pull request.
- **FR-33.** **Withdraw** is available before opening; it deletes the fork branch within 10 minutes. After opening,
  the product links to GitHub for closing — it does not close for the member.

### 4.8 Agent suggestions

- **FR-34.** When a Task on a fork App Work with proposals on reaches **Live** and its Agent marked the change as
  generally useful, one suggestion is sent (S9). At most 1 per Task and 3 per App Work per 7 days. Dismissed
  suggestions are not repeated for that Task.

### 4.9 Cross-cutting

- **FR-35.** Reading needs view access to the App Work; enabling, proposing, approving, addressing reviews and
  withdrawing need edit access and FR-3's GitHub condition. Another account's ids answer **not found**.
- **FR-36.** Every user-visible string is translatable and never assembled from fragments.
- **FR-37.** Activity records: proposed, approved, opened, updated, changes requested, needs signature, refused,
  withdrawn, merged, closed — with the upstream repository, number and link, never the diff or body.
- **FR-38.** Telemetry holds counts, states and ids only: proposals by outcome and refusal code, time from approval
  to open, reviews, merges. Never titles, bodies, diffs, logins or repository names.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity              | Today                                                   | This epic adds                                                                         |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **App Work** (fork) | A fork with an upstream, sync status (APW-02).          | The **Propose changes upstream** setting and an **Upstream pull requests** list.       |
| **Task**            | A change on the App Work (APW-08).                      | **Propose upstream**; preparation and review follow-ups are Tasks too.                 |
| **Approval**        | A decision record in the approvals queue and the Inbox. | A new kind: publish or update an upstream pull request, bound to an exact fingerprint. |
| **Inbox**           | Questions, approvals, escalations, notices.             | Review notices, signature notices, suggestions.                                        |
| **Skill**           | Catalog capability.                                     | The `upstream-contribution` Skill.                                                     |

### 5.2 New

| Entity                    | Why it must exist                                                                                                                                                                                                                                                                                                                                    | Shape                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream pull request** | A Task's pull request lives in the Work's own repository and completes when merged; an upstream pull request lives in someone else's repository, is authored by one member, needs approval before it exists, is polled for months, and must be rate-limited per member per project. No existing record can hold that without changing what it means. | One record per proposal: App Work, source Task, author member, upstream repository and base, fork head branch and commit, number and link, state, check and review summaries, approval, fingerprint, disclosure text, refusal reason, timestamps. |

### 5.3 States

```
 preparing ─┬─► needs_signature ──"I've signed it"──► preparing
            ├─► refused (eligibility, AI policy, DCO, size, port)      failed (preparation error/timeout)
            └─► awaiting_approval ─┬─ reject ─► withdrawn
                                   ├─ 72 h ──► expired
                                   └─ approve ─► opening ─┬─ provider refuses ─► refused
                                                          └─► open ─┬─► merged
                                                                    └─► closed
   open: checks {passing | failing | pending | waiting_for_maintainers | unknown}
         reviews {none | approved | changes_requested | commented} ─ Address review ─► update approval ─► push
```

---

## 6. UX

All copy below is final English copy, ready to be keyed for translation.

### 6.1 Upstream tab (App Works that are forks)

The Upstream tab itself — its repository card, sync status, readiness and Actions hygiene — is created by the fork
lifecycle epic (APW-02) as the App Work's single Upstream page (program Resolution R-8). This epic adds only the
**Propose changes upstream** toggle and the **Upstream pull requests** section below those cards; the two top cards
in the sketch are shown for context.

```
╔════════════════════════════════════════════════════════════════════════════════════╗
║ UPSTREAM                                                                           ║
║ ┌──────────────────────────────────────┐  ┌────────────────────────────────────┐   ║
║ │ acme/bookings ↗                       │  │ Sync (from APW-02)                 │   ║
║ │ Default branch main · MIT             │  │ 12 commits behind · synced 2 d ago │   ║
║ └──────────────────────────────────────┘  └────────────────────────────────────┘   ║
║ Propose changes upstream   [● On ]                                                 ║
║ You approve every pull request before it is sent. Limits: 1 per day per project.   ║
╟────────────────────────────────────────────────────────────────────────────────────╢
║ UPSTREAM PULL REQUESTS                                                             ║
║ #812 Add SMS reminders before bookings   Open · Checks: waiting for maintainers    ║
║      from T-118 · opened 3 h ago                        [ Open on GitHub ↗ ]       ║
║ —    Fix timezone in reminder email      Awaiting your approval  [ Review ]        ║
║ #790 Support 24-hour clock               Merged · 5 d ago                          ║
╚════════════════════════════════════════════════════════════════════════════════════╝
```

| Element         | Copy                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle          | `Propose changes upstream`                                                                                                                                                  |
| Toggle help     | `You approve every pull request before it is sent. Limits: 1 per day per project.`                                                                                          |
| Empty list      | `No upstream pull requests yet. Propose one from a merged Task.`                                                                                                            |
| States          | `Preparing` · `Needs your signature` · `Awaiting your approval` · `Opening` · `Open` · `Merged` · `Closed` · `Refused` · `Failed` · `Expired — prepare again` · `Withdrawn` |
| Checks          | `Checks: passing` · `Checks: failing` · `Checks: running` · `Checks: waiting for maintainers` · `Checks: unknown`                                                           |
| Reviews         | `Approved by maintainers` · `Changes requested` · `Commented`                                                                                                               |
| Tracking paused | `Tracking paused — no activity for 90 days.` · `Check now`                                                                                                                  |
| Merged note     | `The next upstream sync will bring this change back into your fork.`                                                                                                        |
| Link repository | `This repository is the project itself — your Tasks' pull requests already go to it.`                                                                                       |
| Private copy    | `A private copy isn't connected to {upstream} on GitHub, so it can't propose pull requests there. Use a fork to contribute.`                                                |

### 6.2 Task detail action and dialog

```
 Task T-118 · Done · Live ✓                                [ Propose upstream ]
 ╔══════════════════════════════════════════════════════════════════════╗
 ║ Propose upstream                                                [×]  ║
 ║ To        acme/bookings → main                                       ║
 ║ Change    T-118 Add an SMS reminder 2 hours before each booking      ║
 ║ An agent builds a clean branch from acme/bookings:main with only    ║
 ║ this change and follows the project's contribution guide.           ║
 ║ Nothing is sent until you approve the exact diff and text.          ║
 ║ [✓] Allow maintainers to edit this pull request                      ║
 ║ Limits: 1 per day on acme/bookings · up to 1,000 changed lines       ║
 ║                                          [ Cancel ]  [ Prepare ]     ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

Disabled reasons (tooltip): FR-3/S10/S20/S28 copy. Org fork note:
`GitHub doesn't allow maintainer edits on pull requests from organization forks.`

### 6.3 The approval

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║ Open a pull request on acme/bookings?                             expires in 71 h    ║
║ acme/bookings  main  ←  maya:upstream-pr/sms-reminder-7f3a  @ 9c41e2d                 ║
║ As @maya · Maintainers can edit                                                      ║
╟──────────────────────────────────────────────────────────────────────────────────────╢
║ TITLE        feat(reminders): send an SMS 2 hours before each booking                ║
║ DESCRIPTION  (full text, scrollable, exactly as it will appear)                      ║
║ DIFF         3 files · +128 −14            [ Unified | Split ]                        ║
║   ✓ apps/api/reminders/sms.ts   ✓ apps/api/reminders/sms.test.ts                      ║
║   ⚠ CHANGELOG.md — Not in the original change                                         ║
║ CHECKS       ✓ yarn lint (exit 0)  ✓ yarn test reminders (exit 0)                     ║
║ NOTES        Follows acme/bookings' pull request template. Includes AI disclosure.   ║
║ [ ] I've reviewed the extra files                                                    ║
║                                         [ Reject ]  [ Approve and open ]             ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
```

Update variant title: `Push {count} commits to acme/bookings #812?`; primary `Approve and push`. Stale variant:
`The proposal changed after you approved it. Review it again.`

### 6.4 Inbox items

| Item              | Copy                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval          | `Approve pull request to {upstream}: {title}`                                                                                                                                           |
| Changes requested | `{upstream} #{number}: changes requested by @{reviewer}` · `Address review` · `Open on GitHub`                                                                                          |
| Signature         | `{upstream} requires a Contributor License Agreement. Ever Works never signs agreements for you. Sign it yourself, then continue.` · `Open the agreement` · `I've signed it — continue` |
| Suggestion        | `This change might help everyone who uses {upstream}. Propose it upstream?` · `Propose` · `Dismiss`                                                                                     |
| Merged / closed   | `{upstream} merged #{number}.` / `{upstream} closed #{number} without merging.`                                                                                                         |

### 6.5 Refusal copy

| Code                | Copy                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `archived`          | `{upstream} is archived and no longer accepts pull requests.`                                                             |
| `collaboratorsOnly` | `{upstream} only accepts pull requests from collaborators right now.`                                                     |
| `blocked`           | `GitHub refused: your account can't open pull requests on {upstream}.`                                                    |
| `networkMismatch`   | `This fork is no longer connected to {upstream} on GitHub.`                                                               |
| `aiNotAccepted`     | `{upstream} asks contributors not to submit AI-generated changes.`                                                        |
| `dcoRequired`       | `{upstream} requires you to sign off each commit yourself. Ever Works never adds a sign-off for you.`                     |
| `tooLarge`          | `This change is too large to propose upstream ({lines} changed lines; limit {limit}). Split it into smaller Tasks first.` |
| `rateLimited`       | `You can open {count} pull request on {upstream} per day. Next one available at {time}.`                                  |
| `doesNotPort`       | `This change depends on customisations in your fork that {upstream} doesn't have.`                                        |
| `checksRed`         | `A check {upstream} documents failed: {command}.`                                                                         |
| `tooManyExtraFiles` | `The prepared change touches more files than the original change.`                                                        |
| `connectionScope`   | `Your GitHub connection needs permission to open pull requests. Reconnect GitHub.`                                        |
| `notForkPusher`     | `Only someone whose GitHub account can push to {fork} can propose upstream.`                                              |
| `timedOut`          | `Preparation took too long.`                                                                                              |

---

## 7. Out of scope

- Proposing changes from a private copy or to any repository other than the fork's upstream.
- Closing, commenting on, labelling or merging upstream pull requests; responding to maintainers in their thread.
- Signing CLAs or DCOs, or storing signatures.
- Webhooks from upstream projects (they cannot be installed on repositories the member does not administer).
- Contributing to non-GitHub upstreams (the capability is optional; other providers may implement it later).
- Splitting a large change automatically into several upstream pull requests.

---

## 8. Acceptance criteria

- [ ] **ACC-09-01** — Proposals are off on a new fork App Work; switching on never opens a pull request.
- [ ] **ACC-09-02** — **Propose upstream** is absent for a link, disabled with the S10 copy for a private copy, and
      disabled for a member whose GitHub account cannot push to the fork.
- [ ] **ACC-09-03** — Archived, collaborators-only, network-mismatch and missing-scope upstreams are refused with their
      codes both before preparing and at open time.
- [ ] **ACC-09-04** — The prepared branch is cut from the upstream default branch head and has exactly one commit with no
      sign-off trailer.
- [ ] **ACC-09-05** — A fork with 40 unrelated customisation commits produces a prepared diff containing only the source
      change's files (plus ≤ 3 marked extras).
- [ ] **ACC-09-06** — The App spec, Ever Works workflows, protected paths, `.env*`/`*.pem`/`*.key` and secret-shaped
      values never appear in a prepared diff.
- [ ] **ACC-09-07** — A project template is filled; the disclosure line ends the body; the body contains no Ever Works
      link or Task id.
- [ ] **ACC-09-08** — A CLA requirement yields **Needs your signature**; DCO stops preparation; no agreement or sign-off
      is ever created by the platform.
- [ ] **ACC-09-09** — A project stating it refuses AI contributions stops preparation with `aiNotAccepted`.
- [ ] **ACC-09-10** — The approval shows target, head, title, body, full diff, checks and notes; extra files require the
      tick before approval.
- [ ] **ACC-09-11** — No guardrail or autonomy setting auto-approves the proposal; it carries the cross-scope flag.
- [ ] **ACC-09-12** — Changing the head commit, title, body, base or maintainer-edit choice after approval opens nothing.
- [ ] **ACC-09-13** — An approval older than 72 hours cannot open anything.
- [ ] **ACC-09-14** — The pull request is opened with the member's own GitHub token, head `owner:branch`; a test proves
      platform and installation tokens are never used.
- [ ] **ACC-09-15** — A second opened pull request on the same upstream within 24 hours is refused with the next slot time;
      the other FR-26 limits hold.
- [ ] **ACC-09-16** — A 1,240-line port is refused; a project stating 300 lines refuses 400.
- [ ] **ACC-09-17** — `action_required` checks show **waiting for maintainers**, not failing.
- [ ] **ACC-09-18** — Changes requested produces one Inbox notice per review; **Address review** pushes nothing before its
      approval, then fast-forwards the pull request branch.
- [ ] **ACC-09-19** — Merged and closed stop polling and are recorded in Activity; no code path merges, closes or comments
      upstream.
- [ ] **ACC-09-20** — Polling cadence is 30 minutes in the first 7 days, 6 hours after, paused after 90 days; ≤ 4 requests
      per read.
- [ ] **ACC-09-21** — An agent suggestion prepares nothing until **Propose** is clicked; limits of FR-34 hold.
- [ ] **ACC-09-22** — Withdraw deletes the fork branch within 10 minutes; nothing reached upstream.
- [ ] **ACC-09-23** — Every id from another account answers not found; every string is translated; telemetry holds no
      titles, bodies, diffs, logins or repository names.

---

## 9. Open questions

- **[NEEDS CLARIFICATION: detecting "no AI contributions".]** The Agent reads the guide and quotes the sentence. A false
  positive only refuses (safe); a false negative sends a pull request the project did not want. Should the approval also
  show a **"Checked the contribution guide for AI policy"** line with the quoted evidence either way?
- **[NEEDS CLARIFICATION: daily limit numbers.]** 1 per project per day and 3 overall are conservative. Organizations with
  a contribution program may want higher limits; per-plan limits would be additive.
- **[NEEDS CLARIFICATION: Upstream tab ownership.]** APW-02 shows sync status and APW-09 the pull requests. One tab, two
  sections — whichever epic ships first creates the tab.
- **[NEEDS CLARIFICATION: who pays for preparation?]** Preparation and review follow-ups are agent runs billed like any
  Task. Should contribution runs have their own monthly cap?
