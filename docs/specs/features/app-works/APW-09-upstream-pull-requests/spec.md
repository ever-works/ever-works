# Feature Specification: Upstream pull requests

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-09-upstream-pull-requests`
**Program**: [App Works](../README.md) — Wave 1 (P1 foundations), Wave 2 (P2–P3)
**Wave placement**: P1 → **Wave 1**; P2 and P3 → **Wave 2**. This is the same placement the wave table in
[`ACCEPTANCE.md`](../ACCEPTANCE.md) uses for ACC-09-02, 03, 12, 14, 15, 17 and 23 (Wave 1) and for ACC-E2E-08
(Wave 2, golden path), and the same one [`plan.md`](./plan.md) §11 and [`tasks.md`](./tasks.md) phase headings
carry — P1 ships foundations only and sends nothing upstream.
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

- **FR-26.** Per member: at most **1** upstream pull request opened per upstream repository per 24 hours; at most the
  App Work's own limit for open pull requests per upstream repository at once — the App spec's
  `upstreamPullRequests.maxOpen` (default **3**, hard ceiling **10**) — and never more than **10** whatever the spec
  says; at most **3** opened across all upstream repositories
  per 24 hours; at most **10** preparations started per 24 hours. Per App Work: at most **1** preparation running at
  a time. Per open upstream pull request: at most **5** approved pushes per 24 hours. Every number in this requirement
  is a **default**: an operator may raise one for the installation without a redeploy (program Resolution R-31 — the
  caps and their overrides are tabulated there), and filling one is a refusal with copy, never a silent drop. Raising a
  limit never removes FR-39's platform-wide ceiling, and no setting in the product may raise a limit at will.
- **FR-27.** A refusal by limit says which limit and when the next slot opens (S20), and the response names **which**
  of FR-26's limits was reached so the copy can say what to do about it.

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
  withdrawn, merged, closed — with the upstream repository, number and link, never the diff or body.- **FR-38.** Telemetry holds counts, states and ids only: proposals by outcome and refusal code, time from approval
  to open, reviews, merges. Never titles, bodies, diffs, logins or repository names.

### 4.10 Additions (2026-09-17 — consideration, the credential of record, cost, accessibility, the switches)

Every requirement below is an **addition**: none of FR-1…FR-38 is narrowed, no state, code, limit or default is
removed, and the two switches it introduces fail closed so they can only stop work that would otherwise happen.

- **FR-39.** **One upstream is never flooded by the platform as a whole.** Besides the per-member limits of FR-26
  there is a **platform-wide** ceiling on how many upstream pull requests Ever Works opens against one upstream
  repository per 24 hours, counted across every App Work, member and organization. Crossing it refuses
  `platformCapReached` with the next slot time, whatever the member's own allowance still permits. The ceiling is
  an operator value with its own override (program Resolution R-31's table), is shown to the member in the refusal,
  and is never zero by default. This bounds one popular
  project's exposure to the platform; it does not replace, relax or raise any per-member limit.
- **FR-40.** **A maintainer can say no without saying it to us.** When an upstream repository declares that it does
  not want automated or agent-authored contributions — a repository topic, a flag in the contribution guide, or a
  file the project documents for that purpose — the proposal is refused `maintainerOptOut` before preparation and
  again before opening, with the evidence the platform read and a link to it. The check is additive to every other
  eligibility rule; a repository that declares nothing keeps today's behaviour exactly.
- **FR-41.** **An operator can deny an upstream.** An operator can add a repository to a platform deny list. Every
  proposal targeting a denied repository is refused `deniedUpstream`, the repository is not preparable and not
  openable, and existing rows for it stop polling and read **Refused** with the operator reason. The list is
  additive to the App Work's own setting: an App Work cannot be configured around it, and removing an entry
  restores the previous behaviour with nothing else changed.
- **FR-42.** **Keyboard and accessibility.** Every surface this epic adds — the **Propose changes upstream** toggle,
  the Upstream pull requests list and its state, check and review chips, the propose dialog, the approval (and its
  update variant), the Inbox approval, review, signature and suggestion items, and the refusal messages — meets the
  program's accessibility bar: an axe scan reports no new violations on each; every state (refused, needs
  signature, waiting for maintainers, expired) is exposed as text and never by colour alone; every action is
  reachable and operable by keyboard with a visible focus ring; a dialog closes on `Esc` and returns focus to the
  control that opened it; progress (**Preparing**, **Opening**) and the arrival of a review or a refusal are
  announced in a polite live region; and every layout renders in a right-to-left locale (`ar`, `he`) without
  mirroring errors or clipped chips.
- **FR-43.** **One GitHub connection is the credential of record for background work.** Forking (FR-15 of APW-01)
  is done with the member who created the App Work, and that member's connection is recorded as the App Work's
  **credential of record**. Every background job that acts on the member's behalf without a member present —
  scheduled sync, Actions hygiene and secret sync, build polling, and upstream pull request status polling
  (FR-29, which runs for months) — uses the credential of record and **never** a different member's connection, and
  never a platform or installation token where the action is authored by a person. While the credential of record
  is unusable — the member left the organization, lost access, disconnected GitHub, or the connection's scope was
  withdrawn — the affected jobs **pause** and name the reason (**"Waiting for {member} to reconnect GitHub."**),
  with a handover action that lets another member with edit access make their own connection the credential of
  record, taking effect for work not yet started. Nothing already opened upstream is deleted, closed or rewritten
  by a pause, and a handover never re-authors an existing pull request. Contribution runs and preparation remain
  _member-token_ operations of the member who will publish (FR-21, FR-24) and are unaffected by the handover.
- **FR-44.** **One budget per App Work, contribution runs included.** Preparation runs, review follow-up runs and
  every other agent run an App Work causes are booked against **that App Work's own budget** through the platform's
  budget guard, exactly as its other runs are, with an alert at the Work's alert threshold and the month's cap and
  remaining amount on the App Work's overview. A refusal by budget is a **wait** with the reset time, not a
  failure of the proposal, and it opens nothing upstream; the row keeps its state and says why it is waiting. No
  separate contribution-spend account is introduced, and the existing per-feature caps (FR-26's limits, APW-08's
  per-Mission cap) all keep applying — the budget is a further bound, never a replacement.
- **FR-45.** **Deleting an account or an organization stops upstream tracking.** When a member's account or an
  organization that owns App Works is deleted, every upstream pull request they authored stops being polled, its
  scheduled work is cancelled, the fork branches this epic created for it are removed within the same 10 minutes
  FR-33 allows, and the member's GitHub connection is no longer used by any job. Nothing that already reached the
  upstream project is deleted, closed, commented on or edited by the platform (FR-32 stands), and the rows are
  removed with the account as the platform's account-deletion cascade requires (program Resolution R-35).
- **FR-46.** **An operator can stop upstream pull requests.** An operator kill switch turns this epic off and
  **fails closed** (program Resolution R-30): with it off, no preparation is started, no approval opens or pushes
  anything, no suggestion is sent and no status poll is dispatched. Whatever is already open upstream is left exactly
  as it is — the switch stops new work, it never withdraws, closes or deletes anything — and every surface stays
  readable, the Upstream tab showing **"Upstream pull requests are paused by the platform."** with the existing rows
  and their last known state. Turning it back on resumes polling and preparation with no state rewritten.
- **FR-47.** **The preparation run reports through a contract, and the platform enforces FR-12.** The preparation
  Agent's result is a structured **preparation report** with a fixed shape and fixed caps (title, body, agreement
  link, the project's stated limits, the AI-policy quotation, the pieces that did not port, and the checks it ran).
  A missing, oversized or malformed report **fails** the preparation with `reportInvalid` — it is never guessed at,
  and the report itself never reaches the prepared branch or the pull request. The platform refuses a report whose
  checks break FR-12's bounds (more than 10 commands, any command longer than 30 minutes, more than 60 minutes in
  total, or a result tail beyond the stated cap) and refuses a report whose `doesNotPort` list exceeds 10 pieces.
  Check evidence is **agent-reported** and the approval says so in words; it is shown as evidence, never as a
  platform-run verification, and the platform never claims to have run a command it did not run.
- **FR-48.** **Switching the setting on or off is a platform-authored App spec change with a recorded pending
  state.** The App spec stays the source of truth (D3) and switching still opens no upstream pull request (FR-1).
  The change to `upstreamPullRequests` is written by the platform through the App spec write path — a branch plus
  one commit through `commitFiles`, and a setup pull request where R-4 requires one — so the toggle works
  **deterministically** and does not depend on an Agent being resolvable or on an isolated runtime being free;
  APW-08's `evolve` path stays available and is used when the member's own Agent is available and an isolated
  runtime exists. The value the member asked for and the change that carries it are **recorded**, so the toggle
  reads **"Waiting for the App spec change to merge."** across reloads and devices until that change merges, and
  reads the applied value afterwards. When no write path can be used — the member may not push and no pull request
  can be opened, or the platform cannot write at all — the toggle refuses with a named code and changes nothing.
- **FR-49.** **The extra-files acknowledgement is part of the decision, not the screen.** The tick FR-10 and S22
  require (**I've reviewed the extra files**) is recorded against the proposal and is required by **every** door
  that can approve it — the approval screen, the approvals queue, the Inbox reply and the approvals API. While the
  prepared diff marks one or more files **Not in the original change** and no acknowledgement is recorded, the
  approval cannot be decided in the affirmative: it stays awaiting approval and says **"Review the extra files
  before approving."** A decision arriving through a door that does not present the tick is refused the same way.
  This adds a precondition; it removes no existing way to approve a proposal whose diff has no extra files.

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

| Entity                      | Why it must exist                                                                                                                                                                                                                                                                                                                                    | Shape                                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream pull request**   | A Task's pull request lives in the Work's own repository and completes when merged; an upstream pull request lives in someone else's repository, is authored by one member, needs approval before it exists, is polled for months, and must be rate-limited per member per project. No existing record can hold that without changing what it means. | One record per proposal: App Work, source Task, author member, upstream repository and base, fork head branch and commit, number and link, state, check and review summaries, approval, fingerprint, disclosure text, refusal reason, timestamps.       |
| **Upstream setting change** | Added 2026-09-17 (FR-48). The toggle has to read **waiting** across reloads while a platform-authored App spec change is in flight, and the App spec cannot say so itself.                                                                                                                                                                           | The App Work, the value the member asked for, the change carrying it (branch, pull request, number), when it was requested and when it was applied. The App spec stays the source of truth; this record is the in-flight state, never a second setting. |
| **Upstream suggestion**     | Added 2026-09-17 (FR-34, G20). FR-34's limits ("at most 1 per Task and 3 per App Work per 7 days", "dismissed suggestions are not repeated") have to be counted and a dismissal has to be remembered.                                                                                                                                                | One record per suggestion: App Work, Task, the member it was sent to, when it was sent and when it was dismissed.                                                                                                                                       |

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

| Element           | Copy                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle            | `Propose changes upstream`                                                                                                                                                  |
| Toggle help       | `You approve every pull request before it is sent. Limits: 1 per day per project.`                                                                                          |
| Empty list        | `No upstream pull requests yet. Propose one from a merged Task.`                                                                                                            |
| States            | `Preparing` · `Needs your signature` · `Awaiting your approval` · `Opening` · `Open` · `Merged` · `Closed` · `Refused` · `Failed` · `Expired — prepare again` · `Withdrawn` |
| Checks            | `Checks: passing` · `Checks: failing` · `Checks: running` · `Checks: waiting for maintainers` · `Checks: unknown`                                                           |
| Reviews           | `Approved by maintainers` · `Changes requested` · `Commented`                                                                                                               |
| Tracking paused   | `Tracking paused — no activity for 90 days.` · `Check now`                                                                                                                  |
| Merged note       | `The next upstream sync will bring this change back into your fork.`                                                                                                        |
| Link repository   | `This repository is the project itself — your Tasks' pull requests already go to it.`                                                                                       |
| Private copy      | `A private copy isn't connected to {upstream} on GitHub, so it can't propose pull requests there. Use a fork to contribute.`                                                |
| Paused platform   | `Upstream pull requests are paused by the platform.` (FR-46; the list, its rows and their last known states stay visible)                                                   |
| Credential paused | `Waiting for {member} to reconnect GitHub.` with `Hand over this App Work's GitHub connection` (FR-43)                                                                      |

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

Two notes on the approval (added 2026-09-17, FR-47 and FR-49):

- The **CHECKS** block is **agent-reported** evidence: it shows the command, the exit status and the last lines the
  preparation run recorded, with the line **"Reported by the preparation agent."** underneath. The platform
  validates the report's shape and FR-12's bounds (FR-47) and shows what it was given; it never presents a command
  as one it ran itself.
- When the diff marks extra files, the tick is a precondition of the decision and not only of this screen: an
  affirmative decision arriving from the Inbox reply or the approvals API without a recorded acknowledgement is
  refused and the item stays awaiting approval, reading **"Review the extra files before approving."** (FR-49).

### 6.4 Inbox items

| Item              | Copy                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval          | `Approve pull request to {upstream}: {title}`                                                                                                                                           |
| Changes requested | `{upstream} #{number}: changes requested by @{reviewer}` · `Address review` · `Open on GitHub`                                                                                          |
| Signature         | `{upstream} requires a Contributor License Agreement. Ever Works never signs agreements for you. Sign it yourself, then continue.` · `Open the agreement` · `I've signed it — continue` |
| Suggestion        | `This change might help everyone who uses {upstream}. Propose it upstream?` · `Propose` · `Dismiss`                                                                                     |
| Merged / closed   | `{upstream} merged #{number}.` / `{upstream} closed #{number} without merging.`                                                                                                         |

### 6.5 Refusal copy

| Code                    | Copy                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archived`              | `{upstream} is archived and no longer accepts pull requests.`                                                                                                          |
| `collaboratorsOnly`     | `{upstream} only accepts pull requests from collaborators right now.`                                                                                                  |
| `blocked`               | `GitHub refused: your account can't open pull requests on {upstream}.`                                                                                                 |
| `networkMismatch`       | `This fork is no longer connected to {upstream} on GitHub.`                                                                                                            |
| `aiNotAccepted`         | `{upstream} asks contributors not to submit AI-generated changes.`                                                                                                     |
| `dcoRequired`           | `{upstream} requires you to sign off each commit yourself. Ever Works never adds a sign-off for you.`                                                                  |
| `tooLarge`              | `This change is too large to propose upstream ({lines} changed lines; limit {limit}). Split it into smaller Tasks first.`                                              |
| `rateLimited`           | `You can open {count} pull request on {upstream} per day. Next one available at {time}.`                                                                               |
| `doesNotPort`           | `This change depends on customisations in your fork that {upstream} doesn't have.`                                                                                     |
| `checksRed`             | `A check {upstream} documents failed: {command}.`                                                                                                                      |
| `tooManyExtraFiles`     | `The prepared change touches more files than the original change.`                                                                                                     |
| `connectionScope`       | `Your GitHub connection needs permission to open pull requests. Reconnect GitHub.`                                                                                     |
| `notForkPusher`         | `Only someone whose GitHub account can push to {fork} can propose upstream.`                                                                                           |
| `notFork`               | `Only a fork can propose changes upstream. This App Work links to {upstream} instead of forking it.`                                                                   |
| `disabled`              | `Upstream pull requests are turned off for this workspace. An administrator can enable them.`                                                                          |
| `sourceNotMerged`       | `This change has to be merged into your fork before it can be proposed upstream.`                                                                                      |
| `excludedPath`          | `This change touches {path}, which {upstream} asks contributors not to change.`                                                                                        |
| `secretDetected`        | `Something in this change looks like a secret. Remove it before proposing it upstream.`                                                                                |
| `notSingleCommit`       | `Proposing upstream needs a single commit; this change has {count}.`                                                                                                   |
| `fingerprintMismatch`   | `The change is no longer the one that was approved. Review it and approve it again.`                                                                                   |
| `approvalExpired`       | `The approval expired before the pull request was opened. Approve it again.`                                                                                           |
| `timedOut`              | `Preparation took too long.`                                                                                                                                           |
| `providerUnsupported`   | `{upstream}'s host does not support opening pull requests from Ever Works yet.`                                                                                        |
| `publishingOff`         | `Publishing is switched off in your autonomy settings, so Ever Works didn't open this pull request. Turn publishing on, then propose it again.`                        |
| `pullRequestsDisabled`  | `{upstream} has switched pull requests off, so nothing can be opened there right now.`                                                                                 |
| `outsideContributorCap` | `{upstream} limits how many pull requests people outside the project can have open at once, and you've reached it. Close or merge one of yours there, then try again.` |
| `platformCapReached`    | `Ever Works has opened its daily limit of {count} pull requests on {upstream}. Next one available at {time}.`                                                          |
| `maintainerOptOut`      | `{upstream} asks not to receive automated contributions, so Ever Works won't open a pull request there.`                                                               |
| `deniedUpstream`        | `Ever Works has been asked not to open pull requests on {upstream}.`                                                                                                   |
| `reportInvalid`         | `The preparation run didn't report what it found, so nothing was proposed. Try again.`                                                                                 |

Placeholders available to this copy: `{upstream}`, `{fork}`, `{path}`, `{count}`, `{lines}`, `{limit}`, `{time}`,
`{command}`. **Every value in `UPSTREAM_REFUSAL_CODES` has copy here** (30 of 30) — the plan requires one locale key
per code in all 21 locales, and before 2026-09-17 nine codes had none, which made that requirement impossible to
satisfy. The 2026-09-17 additions (G10, G16, XC-22) append seven further codes and add no behaviour to the copy
that was already there: `publishingOff` is the proposal refused because **publishing is switched off** (FR-21) and
is deliberately not `blocked`, whose copy stays the provider's own refusal; `pullRequestsDisabled` and
`outsideContributorCap` separate the two repository-level controls §2.3 cites from the temporary interaction limit
`collaboratorsOnly` already covers; `platformCapReached`, `maintainerOptOut` and `deniedUpstream` are FR-39…FR-41;
`reportInvalid` is FR-47.

**Error bodies that are not refusals** (added 2026-09-17, G10). Two responses carry a code the member must read but
are not `UPSTREAM_REFUSAL_CODES` values, because the proposal is not refused — it is either already in flight or
asked to wait:

| Status | Body                                          | Copy                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `409`  | `{ code: 'activeProposal', id }`              | `This Task already has a proposal. Open it instead of starting another.`                                                                                                                                                                                                                                                                                                                                                                                                |
| `429`  | `{ code: 'rateLimited', limit, nextSlotAt? }` | `{upstream} per day: ` `You can open {count} pull request on {upstream} per day. Next one available at {time}.` · `openPerUpstream`: `You already have {count} open pull request on {upstream}.` · `openedOverallPer24h` / `preparationsPer24h` / `pushesPerPrPer24h`: `You've reached this limit for now (limit: {count} per 24 hours). Next one available at {time}.` · `runningPreparationsPerWork`: `An agent is already preparing one proposal for this App Work.` |

`limit` names which of FR-26's limits was reached, and is what selects the copy row above (FR-27). `nextSlotAt` is
present for every windowed limit and absent for `openPerUpstream`, which opens a slot when a pull request there
merges or closes rather than after a fixed time.

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
- [ ] **ACC-09-24** — The prepared branch's single commit is squashed onto the commit the branch was cut from on the
      upstream default branch — never onto the fork's own branch head — and the same commit is what the diff, the
      extra-file marking and the changed-file count are measured against (FR-7, FR-8, FR-10).
- [ ] **ACC-09-25** — A review follow-up Task finalizes into the review service: no merge simulation, no same-repository
      pull request and no `createPullRequest` call for it, and its commits reach the pull request branch only as the
      approved fast-forward (FR-31).
- [ ] **ACC-09-26** — With extra files marked, an affirmative decision through the Inbox reply or the approvals API
      without a recorded acknowledgement changes nothing and leaves the proposal awaiting approval; the same decision
      after the acknowledgement approves it (FR-49).
- [ ] **ACC-09-27** — Switching the setting files a platform-authored App spec change with no Agent and no isolated
      runtime required, records the pending state, reads **Waiting for the App spec change to merge.** until it merges,
      opens no upstream pull request, and refuses with a named code when no write path is available (FR-48).
- [ ] **ACC-09-28** — Every value of `UPSTREAM_REFUSAL_CODES` has its own copy key in all 21 locales; a `429` names
      which FR-26 limit was reached; `publishingOff` is refused with its own code and copy rather than as `blocked`
      (FR-21, FR-27, FR-36).
- [ ] **ACC-09-29** — A platform-wide per-upstream ceiling refuses the next proposal with `platformCapReached` even when
      the member's own allowance remains; a repository declaring it does not want automated contributions is refused
      `maintainerOptOut`; a repository on the operator deny list is refused `deniedUpstream` and its existing rows stop
      polling (FR-39, FR-40, FR-41).
- [ ] **ACC-09-30** — Every surface listed in FR-42 passes an axe scan with no new violations, is operable by keyboard
      with a visible focus ring, states refusal and waiting states as text and not by colour alone, announces progress
      in a polite live region, returns focus when a dialog closes, and renders in `ar` and `he` without clipped chips
      (FR-42).
- [ ] **ACC-09-31** — Deleting the author's account or the owning organization stops that member's upstream tracking,
      cancels its scheduled work, removes the fork branches this epic created within the same 10 minutes, and edits
      nothing upstream (FR-32, FR-45).
- [ ] **ACC-09-32** — Every background job that acts without the member present uses the App Work's recorded credential
      of record; when it is unusable the jobs pause with the named reason and a handover lets another member with edit
      access supply theirs for work not yet started, re-authoring nothing already opened (FR-43).
- [ ] **ACC-09-33** — A preparation run and a review follow-up run are booked against the App Work's own budget, raise
      the Work's alert at its threshold, and a budget refusal waits with the reset time, opens nothing upstream and
      leaves the existing per-feature caps in force (FR-44).
- [ ] **ACC-09-34** — With the operator switch off, no preparation starts, no approval opens or pushes, no suggestion is
      sent and no status poll is dispatched; open pull requests are untouched and every surface stays readable (FR-46).
- [ ] **ACC-09-35** — An API-key caller (and any non-session actor) is refused with `403` on the approval decision and on
      `…/signed`, and the refusal is recorded as a rail refusal — while the same call in a session succeeds (FR-21).
- [ ] **ACC-09-36** — Every route in plan §5 appears in the OpenAPI document with its `@ApiOperation`, and each is
      reachable exactly as plan §5's parity table states (MCP tool or an explicit not-exposed reason, CLI command, chat
      tool), with a registry-parity test that fails when a route is added without its row (FR-35).
- [ ] **ACC-09-37** — The PR-lane specs of this epic run against the fake GitHub with its new endpoints and a seeded
      `upstream_pull_requests` row plus approval proposal, and a preparation reaches `awaiting_approval` in that lane
      without any provider call leaving the fake (FR-6, FR-22).
- [ ] **ACC-09-38** — Preparation ends at 90 minutes of **running** time: a run parked by a hold is not timed out, the
      paused intervals are recorded, and the sweeper times out a `preparing` row that has spent 90 running minutes
      while leaving a parked row `preparing` (FR-13).
- [ ] **ACC-09-39** — A missing, oversized or malformed preparation report fails the preparation with `reportInvalid` and
      proposes nothing; a report beyond FR-12's bounds or with more than 10 missing pieces is refused; the report never
      appears in the prepared diff; and the approval labels its check evidence as reported by the preparation agent
      (FR-12, FR-47).
- [ ] **ACC-09-40** — A suggestion is counted and a dismissal remembered: at most 1 per Task and 3 per App Work per 7
      days hold across restarts, and a dismissed suggestion is not sent again for that Task (FR-34).

---

## 9. Open questions

> **Register (added 2026-09-17, SK-05).** Each marker below is one row of the program clarification register
> ([`CLARIFICATIONS.md`](../CLARIFICATIONS.md)) — the four APW-09 rows are `CL-38`…`CL-41`, in this order. A row
> records the question, the default this spec assumes, the wave it blocks, who decides and its status
> (`open` · `resolved-by R-n` · `default accepted`). A marker is never deleted: when a binding resolution settles
> it, the resolution line is added underneath and the question stays. **No APW-09 marker blocks P1 (Wave 1)**:
> `CL-40` is already resolved by `R-8`, and `CL-38`, `CL-39` and `CL-41` gate **P2 (Wave 2)** — the three the owner
> still owes before this epic opens anything upstream.

- **[NEEDS CLARIFICATION: detecting "no AI contributions".]** The Agent reads the guide and quotes the sentence. A false
  positive only refuses (safe); a false negative sends a pull request the project did not want. Should the approval also
  show a **"Checked the contribution guide for AI policy"** line with the quoted evidence either way?
  _Register `CL-38` — status: open · owner (product/legal); blocks Wave 2 · P2._ The default this spec already
  builds is agent-read detection whose quotation lands in `refusalDetail` and on the approval's notes (FR-47), and
  FR-40's maintainer opt-out is additive to it. The owner's answer selects one of two additions — always showing
  the evidence line, or keeping it refusal-only — and neither removes the detection or the refusal.
- **[NEEDS CLARIFICATION: daily limit numbers.]** 1 per project per day and 3 overall are conservative. Organizations with
  a contribution program may want higher limits; per-plan limits would be additive.
  _Register `CL-39` — status: open · owner; blocks Wave 2 · P2._ The defaults this spec already builds are FR-26's
  numbers — 1 per upstream per 24 hours, 3 opened overall per 24 hours, 10 preparations started per 24 hours and the
  App spec's `maxOpen` (default 3, hard ceiling 10) — plus FR-39's platform-wide ceiling, which is additive to all of
  them. Per-plan overrides, if the owner asks for them, are an **addition** on top of these numbers.
- **[NEEDS CLARIFICATION: Upstream tab ownership.]** APW-02 shows sync status and APW-09 the pull requests. One tab, two
  sections — whichever epic ships first creates the tab.
  _Register `CL-40` — status: **resolved-by `R-8`** (2026-09-17)._ **Resolved (R-8, CONTRACTS §0):** there is exactly
  one route, `/works/:id/upstream`, and **APW-02 creates the tab** — its entry, its route and its relation,
  readiness, sync-status and Actions-hygiene cards. APW-09 adds only the **Upstream pull requests** section below
  them (§6.1) and creates no page, no tab entry and no relation card of its own. The question above stays as asked
  (owner rule, R-26); this line settles it.
- **[NEEDS CLARIFICATION: who pays for preparation?]** Preparation and review follow-ups are agent runs billed like any
  Task. Should contribution runs have their own monthly cap?
  _Register `CL-41` — status: open · owner; blocks Wave 2 · P2._ The default this spec already builds is that
  contribution runs are booked against the App Work's own budget through the platform's budget guard — FR-44 makes
  that explicit and introduces **no** separate contribution-spend account, because a second account would make the
  App Work's total unreadable. A cap specific to contribution runs, if the owner asks for one, is an **addition**
  beside the Work budget and the existing per-feature caps, never a replacement for them.

---

## 10. Non-functional requirements

Added 2026-09-17 (SK-15). Every number below is one already stated in a requirement or in [`plan.md`](./plan.md);
this section lifts them into measurable lines rather than inventing new ones.

- **NFR-1** Preparation start: the preparation Task is dispatched within **60 seconds** of **Prepare**, or refused
  like any App Work Task when no isolated environment is available (FR-6).
- **NFR-2** Preparation deadline: **90 minutes** of **running** time, holds excluded; a hold leaves the row
  `preparing` with the clock paused (FR-13, R-17).
- **NFR-3** Checks: at most **10** documented commands, each at most **30 minutes**, **60 minutes** in total, each
  result tail at most **50 lines / 8 KB**, all inside the isolated environment that holds no secret (FR-12, FR-47).
- **NFR-4** Prepared size: at most **1,000** changed lines (lockfiles excluded) and **30** files, or the project's
  smaller stated limit; at most **3** files outside the original change (FR-10, FR-25).
- **NFR-5** Text caps: title **72** characters, body **8,000** characters, AI-policy quotation **300** characters,
  the pieces that did not port **10**, each upstream guide file **64 KB** (FR-11, FR-14, FR-15, FR-16, FR-47).
- **NFR-6** Approval screen: the complete diff is shown up to **300 files / 1 MB** of patch, and a proposal beyond
  that is refused before an approval exists (FR-22, FR-25).
- **NFR-7** Approval lifetime: **72 hours**, then `expired` and **prepare again**; the decision is bound to the
  fingerprint and a stale one opens nothing (FR-23, S23, S24).
- **NFR-8** Opening: one provider call per approved open, **1 retry on 5xx only**, and the row is `opening` for the
  duration; a dropped dispatch is re-dispatched by the status job after **15 minutes** (plan §7, §9.2).
- **NFR-9** Polling: every **30 minutes** for the first **7 days**, then every **6 hours**, paused after **90 days**
  without upstream activity; at most **4** provider requests per read and at most **100** rows per sweep (FR-29,
  plan §7).
- **NFR-10** Limits: **1** opened per upstream per 24 hours, **3** opened overall per 24 hours, **10** preparations
  started per 24 hours, **1** preparation running per App Work, **5** approved pushes per open pull request per
  24 hours, the App spec's `maxOpen` (default **3**, ceiling **10**) open per upstream, and FR-39's platform-wide
  ceiling per upstream per 24 hours (FR-26, FR-39).
- **NFR-11** Cleanup: a withdrawn or terminal row's fork branch is deleted within **10 minutes**, and the same bound
  applies to the account-deletion cascade (FR-33, FR-45).
- **NFR-12** Degraded paths stay available: a provider that implements none of the optional methods is refused
  `providerUnsupported` with its own copy and never a `500`; a status read that fails leaves the last known state
  and the polling cadence intact rather than failing the row (plan §4, §9.2).
- **NFR-13** Every read in this epic is App-Work-scoped and answers **not found** for a foreign identifier; every
  mutation needs edit access and FR-3's GitHub condition (FR-35).
- **NFR-14** Every user-visible string is translatable, one locale key per refusal code across all 21 locales, never
  assembled from fragments, and every surface added here passes FR-42's accessibility bar (FR-36, FR-42, FR-49).
- **NFR-15** Telemetry carries counts, states and ids only — never a title, body, diff, login or repository name —
  and the typed event module refuses a forbidden property key before capture (FR-38, plan §9.1).
- **NFR-16** Both operator controls — the upstream kill switch (FR-46) and the deny list (FR-41) — are read by the
  job dispatchers themselves and **fail closed**, so their effect is bounded by the job cadence and never by a page
  that forgot to check.

---

## 11. Constitution gates

| Principle                              | How this epic complies                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I — Plugin-first**                   | All provider work goes through `GitFacadeService` and `WorkspaceFacadeService`; every new provider method — cross-repository head fields, reviews, interaction limits, `createBranchFromSha`, `updateBranchRef`, the workspace report vehicle — is an **optional** addition to an existing capability, and a provider without them degrades to `providerUnsupported` rather than to a core special case (plan §4).                       |
| **II — No hard-coded plugin ids**      | The member token is resolved by the provider id passed in, never a literal; no plugin id appears in core, and the denial of Fleet runs reads the dispatcher's own delegation-scope rule rather than naming a plugin (plan §2.3, §2.5).                                                                                                                                                                                                   |
| **III — Source-of-truth repositories** | The enable switch lives in the App spec and is changed by a platform-authored write into the Work Repository (FR-48, R-4); the database holds proposal, tracking, setting-pending and suggestion state only (plan §3.1–§3.2).                                                                                                                                                                                                            |
| **IV — Job runtime**                   | Open, push and status are dispatched and scheduled jobs behind `202` endpoints, bound through the existing runtime provider list; nothing calls a queue directly (plan §5, §7).                                                                                                                                                                                                                                                          |
| **V — Forward-only migrations**        | Three additive migrations in the reserved block `179209…`, each guarded so a re-run is a no-op and each `down()` dropping only what its `up()` added; no existing table, column or index is altered or dropped (plan §3.2).                                                                                                                                                                                                              |
| **VI — Tests first**                   | Unit, plugin, API and e2e specs are named in plan §10, including the structural "never merges / member token only" spec and the fake-GitHub PR lane this epic now needs (plan §10.1–§10.4, ACC-09-37).                                                                                                                                                                                                                                   |
| **VII — Secret hygiene**               | Only the member's token is used, never stored on the row, logged or returned (FR-24, plan §2.3); the prepared diff, title and body are screened and a match records the pattern name only (plan §3.1, FR-9); the preparation report never reaches the branch; telemetry carries no content (FR-38).                                                                                                                                      |
| **VIII — Plugin counts**               | No plugin is added or removed.                                                                                                                                                                                                                                                                                                                                                                                                           |
| **IX — Behaviour-first spec**          | This document names no class, no file and no endpoint; every path, constant and code lives in `plan.md`.                                                                                                                                                                                                                                                                                                                                 |
| **X — Backwards compatibility**        | Every provider addition is optional and `createPullRequest` behaves identically without the new fields; every existing id — FR, scenario, ACC, task, resolution — is kept; new behaviour is added alongside the old and both switches fail closed (program Resolutions R-26, R-27).                                                                                                                                                      |
| **Program rules 9 and 10**             | Upstream guides, templates, review comments and the preparation report are untrusted content, fenced and never placed in a system prompt; no third-party product or vulnerability is named in this epic's copy.                                                                                                                                                                                                                          |
| **Program resolutions (CONTRACTS §0)** | R-1 shared types in `packages/contracts/src/apps/`; R-2 Activity family `app_upstream_pr`; R-4 the first write into the Work Repository; R-8 one Upstream tab created by APW-02; R-17 holds and rail refusals; R-18 the `publish` rung, `off` blocks, never bulk-approvable; R-22 no `apps/api/test/` suites; R-25 backup classification of every table added; R-26 additive-only; R-27 the deploy-shape family is kept (plan §11, §12). |

---

## 12. References

- [App Works program overview](../README.md) — decisions **D3** (the App spec is the source of truth), **D12**
  (upstream is followed, never pushed to; every upstream pull request is opt-in, human-approved, rate-limited and
  never merged by the platform), **D13** (the license gate protects hosting, not forking) and §7 rule 9 (repository
  content is untrusted).
- [Cross-epic contracts](../CONTRACTS.md) — §0 resolutions R-1…R-27 (R-18 governs this epic's approval), §1 the
  App spec (`upstreamPullRequests.enabled` / `requireApproval` / `maxOpen`), §2 entities, §2A shared types, §3
  capability interfaces (the optional git and workspace additions), §4 HTTP API, §6 Activity events, §7 flags and
  environment variables (the switch FR-46 wires), §8 catalog repositories.
- [Acceptance](../ACCEPTANCE.md) — the wave table, ACC-E2E-04, ACC-E2E-08 and ACC-NEG-05/06, which walk this
  epic's ACC-09 ids.
- [Existing substrate](../EXISTING-SUBSTRATE.md) — task isolation, the approvals queue and `merge_pull_request` as
  the subject-keyed precedent, the Inbox producer port, the Live Feed kind table and `assertNoSecrets`.
- [APW-01 — App Work kind](../APW-01-app-work-kind/) — the Work Repository role, the kind switch, the deletion
  cascade FR-45 joins, and the create-from-URL fork that FR-43 records as the credential of record.
- [APW-02 — Fork lifecycle](../APW-02-fork-lifecycle/) — upstream metadata, sync status, the one Upstream tab
  (R-8), `createBranchFromSha` / `updateBranchRef` (whichever epic lands first) and the fork permission matrix
  `GITHUB-PERMISSIONS.md` carries.
- [APW-03 — App spec and catalog](../APW-03-app-spec-and-catalog/) — `getEffectiveSpec`, `validateDraft`,
  `diffGuardedSpecBlocks`, `isProtectedPath`, `commitFiles`, `schema.md` §20 (`upstreamPullRequests`) and FR-26
  (a spec change to `upstreamPullRequests` needs a person).
- [APW-04 — App provisioner](../APW-04-app-provisioner/) — the agent-run tool policy and the untrusted-content
  containment this epic's preparation run reuses.
- [APW-05 — Builds](../APW-05-builds/) — the build receipt the credential-of-record rule (FR-43) also governs.
- [APW-06 — App runtime](../APW-06-app-runtime/) — deploy shapes and the workload deletion path the account
  deletion cascade (FR-45) joins.
- [APW-07 — App env & dependencies](../APW-07-app-env-and-dependencies/) — `EW_` Actions secrets and webhooks the
  account deletion cascade removes.
- [APW-08 — Evolve loop](../APW-08-evolve-loop/) — isolated-run admission, `finalizeRun` / `simulateMerge`, the
  `AppChangeGuard`, `classifyAppWorkRunStop` (the hold semantics FR-13 and NFR-2 depend on), the `evolve` request
  builder FR-48 keeps as an option, and FR-73/FR-74, the budget and operator-switch precedents FR-44 and FR-46
  follow.
- [APW-10 — Ever Works Apps hosting tier](../APW-10-apps-hosting-tier/) — quarantine and the operator surfaces the
  deny list (FR-41) sits beside.
- [APW-11 — App launcher](../APW-11-app-launcher/) — `HumanActorGuard` and the human-only convention ACC-09-35
  uses, and the delegated-read routes that must not reach this epic's writes.
- [APW-12 — Ever ID](../APW-12-ever-id/) — `authMethod` and the delegated tokens the human-only rule refuses.
- [APW-13 — Golden paths](../APW-13-golden-paths/) — the fake GitHub and `EVER_WORKS_E2E_FAKES` the PR lane needs
  (ACC-09-37), the harness interlocks and the fixture branches (R-23).
- User documentation — `docs/features/app-works-upstream-pull-requests.md` is the page T32 writes for the member
  (behaviour, limits, signatures, disclosure, the publishing setting) and is not in the repository yet, so it is
  named here rather than linked.
- [Constitution](../../../../../.specify/memory/constitution.md) — Principles I–X, in particular VI (tests), VII
  (secret hygiene) and IX (behaviour-first spec). The program also cites **ADR-014**, **ADR-015** and **ADR-017**
  (plugin-first, capability interfaces, the job runtime); no `docs/adr/` folder exists in this repository at the
  time of writing, so they are named here rather than linked.
- [`plan.md`](./plan.md) · [`tasks.md`](./tasks.md) · [`skill-draft/SKILL.md`](./skill-draft/SKILL.md)
