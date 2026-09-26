# Feature Specification: App Work kind & create from any repository URL

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-01-app-work-kind`
**Program**: [App Works](../README.md) — Wave 1 (P1), polish in P2
**Branch**: `feat/apw-01-app-work-kind`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: L · **Depends on**: APW-02 (P0, P1), APW-03 (P1 **and its Wave 1 catalog seam in P2**), APW-06 (T1–T3),
APW-13 (P0) · **Depended on by**: APW-04…06, 08, 09, 11, 13

> **Additive-only (program rule 1).** Nothing here removes, renames or loosens an existing surface. The
> **Repository Work** keeps every refusal it has today, its create form, its chip and its 409 rule. Every
> other kind keeps its capabilities. The create endpoint keeps its route, its status code and every field
> it accepts today. The new kind is additional vocabulary plus an additional branch of the create path.

> **Program audit resolutions applied (2026-09-17).** This spec follows
> [CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5):
> R-3 (license classes at creation), R-4 (the first write into the Work Repository), R-6 (the kind switch refuses
> every client), R-7 (Builds and App environment capabilities), R-12 (deploy target **None**) and R-15 (deleting an
> App Work). Where older text in this epic disagreed, the resolution wins and the text below was aligned.

> **Merge-order correction (2026-09-17).** This epic compiles against symbols APW-03 ships in **P2**, APW-06 ships
> in **T1–T3** and APW-13 ships in **P0**. Those are named task by task in [`tasks.md`](./tasks.md) and ordered
> ahead of this epic's P1 in the program merge order; nothing was removed from this epic's own phases. The
> per-phase list is in [plan §11](./plan.md).

---

## 1. Overview

A signed-in member pastes the URL of any GitHub repository into the create-Work surface and gets an
**App Work**: a Work whose Work Repository is that code, which Ever Works can later build, run and keep
changing with agents. Before anything is written anywhere, the member sees a **preview** of the
repository — owner and name, stars, default branch, a license chip, whether a curated **App Blueprint**
exists — and a clear choice of how the code becomes theirs:

- **Link** — the repository itself becomes the Work Repository (offered when they can push to it);
- **Fork** — a GitHub fork is made in their own account or one of their organizations, with their own
  GitHub connection, so they can follow upstream and later propose changes back;
- **Private copy** — a private repository with the same code, for people who cannot have a public fork,
  with the trade-off (no upstream pull requests) stated before they choose.

A member who does not have a URL yet can pick an app from the **Apps catalog** instead; the catalog fills
in the repository and the Blueprint. Every check that can fail runs before a repository is created or a
row is written. A forked App Work shows a **Preparing** state until GitHub has finished the fork; then
Ever Works records `.works/works.yml` — where the code came from and, when a Blueprint applies, how to run
it. A fork or private copy that Ever Works just created gets that as one commit; a linked repository, or a
fork the member already had, gets it as one setup pull request, because Ever Works never pushes to a default
branch it did not create. The App Work is ready once the source is on the default branch. With no Blueprint,
the App Provisioner starts working out how to run it. The member also picks where it runs: **None** (default,
"don't deploy yet"), **Your cluster**, or **Ever Works Apps** (visible, disabled with its reason until managed
hosting opens). Deleting an App Work removes what it runs on its deploy target, keeps its stored data unless
the member asks otherwise, never deletes the linked repository or the upstream, and deletes a fork or private
copy only when the member ticks that separate box and types its name.

## 2. Why now

### 2.1 The user's question

> _"I found an open-source app I love. Can I have my own copy that my agents keep improving?"_ — and, the
> moment they paste the link: _"Will this fork it into my account, or change the original? Where will it run?"_

### 2.2 What they do today instead

| The need                                     | What Ever Works offers today                                                                                     | What the user actually does                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Start a Work from somebody else's repository | A **Repository Work** wraps a repository the member can read — but never forks, builds or deploys it, by design. | Forks by hand on GitHub, then registers the fork as a Repository Work. |
| Start from their own repository and run it   | Work Import (`link existing`) is directory-shaped; a Repository Work refuses deploy.                             | Keeps the app outside Ever Works.                                      |
| Know whether the code is safe to host        | Nothing shows a license or a curated recipe at creation.                                                         | Reads the LICENSE file and guesses.                                    |
| Keep a fork private                          | Nothing. Forks of public repositories are always public on GitHub.                                               | Clones and pushes a copy manually.                                     |
| Tell Ever Works "don't deploy this yet"      | Content Works seed a deploy provider from onboarding.                                                            | Ignores the Deploy tab.                                                |

### 2.3 The gaps, all of them ours

1. **The only "bring your code" kind is deliberately inert.** The Repository Work never generates, deploys
   or writes — a promise the platform's own repositories rely on, which "run this app" would break.
2. **Forking exists but is wired only to built-in templates.** The fork call blocks the request for up to
   two minutes and only finds an existing fork when a name is given.
3. **Nothing says what will happen to a repository before it happens.** Existing flows create, then report.

### 2.4 What this epic changes

```
   BEFORE  [Repository] ─► URL ─► registered, inert (no fork, no build, no deploy)
   AFTER   [App] ─► URL or Apps catalog ─► preview (owner/repo · ★ · license · Blueprint)
                 ─► Link | Fork into [owner ▾] | Private copy ─► where it runs (None)
                 ─► App Work: Preparing ─► Ready  ·  header "Upstream acme/tasks-app · Fork my-org/tasks-app"
```

## 3. User scenarios

### 3.1 Primary

- **S1 — Fork a public app into my account.**
  **Given** a member with GitHub connected who cannot push to `acme/tasks-app`,
  **when** they paste its URL on the App form and press **Check repository**,
  **then** the preview shows `acme/tasks-app`, its star count, default branch, license chip and Blueprint
  badge; **Fork** is pre-selected with **Fork into** set to their own account; **Link** is disabled with
  **"You can't push to this repository."**; and pressing **Fork and create App Work** returns within
  10 seconds on the App Work page showing **Preparing your fork**.

- **S2 — The fork becomes ready.**
  **Given** the App Work from S1 is preparing,
  **when** GitHub finishes the fork,
  **then** within 30 seconds of the fork's default branch having a commit the card disappears, the header
  reads **Upstream: acme/tasks-app · Fork: <login>/tasks-app**, the fork contains `.works/works.yml`
  recording kind `app` and the source, and Activity shows one "fork ready" and one "source forked" entry.

- **S3 — Fork into an organization.**
  **Given** the member belongs to organization `my-org`,
  **when** they open **Fork into** and pick `my-org`,
  **then** the fork is created as `my-org/tasks-app` with the member's own connection, and nothing is
  created in any organization the platform operates.

- **S4 — Link a repository I can push to.**
  **Given** the member can push to `me/booking`,
  **when** they check it,
  **then** **Link** is pre-selected with **"You can push to this repository, so changes land here
  directly."**, and creating it makes no new repository and pushes nothing to the default branch: Ever Works
  opens one setup pull request adding `.works/works.yml`, the App Work shows **"Merge the setup pull request
  to finish."**, and it is ready once that pull request is merged.

- **S5 — Use my existing fork.**
  **Given** the member already forked `acme/tasks-app` long ago and renamed the fork `tasks-fork`,
  **when** they check `acme/tasks-app` with **Fork into** set to their account,
  **then** the preview says **"You already have a fork: <login>/tasks-fork. Ever Works will use it."**,
  and creating the App Work makes no fork request; because Ever Works did not create that fork, its source is
  recorded through a setup pull request, exactly as for a linked repository (S4).

- **S6 — Private copy.**
  **Given** a public repository of 40 MB,
  **when** the member picks **Private copy**,
  **then** the card shows **"A private copy is not linked to the original on GitHub, so it can't open pull
  requests to the original project. Upstream changes arrive as pull requests in your copy."**, and
  creating it makes a private repository with the default branch's full history, then the App Work
  becomes ready.

- **S7 — Paste my own fork.**
  **Given** the member pastes `me/tasks-fork`, a fork of `acme/tasks-app` they can push to,
  **when** they check it,
  **then** **Fork** is pre-selected with **"This is your fork of acme/tasks-app. Ever Works will follow
  acme/tasks-app as upstream."**, and **Link** stays available as **"Link — don't follow upstream"**. Either
  way Ever Works did not create that repository, so its source is recorded through a setup pull request.

- **S8 — Pick where it runs.**
  **Given** the preview is showing,
  **when** the member reaches **Where should it run?**,
  **then** **None — don't deploy yet** is selected, **Your cluster** is selectable when the instance has a
  deployment option that can run apps, and **Ever Works Apps** is disabled with **"Coming soon — managed
  hosting for apps isn't open yet."**

- **S9 — Create from chat.**
  **Given** a member in platform chat says "fork github.com/acme/tasks-app into my-org and make it an app",
  **when** the assistant prepares the create call,
  **then** it asks for confirmation naming the repository that will be created on GitHub, and only after
  the member confirms does the App Work get created exactly as in S3.

- **S9b — Start from the Apps catalog.**
  **Given** the App form is open,
  **when** the member switches to **Browse the Apps catalog** and picks an app,
  **then** the URL field is filled with that app's upstream repository, the preview runs automatically and
  shows **Verified Blueprint** or **Blueprint available** for exactly the app they picked, and the App Work
  they create gets that Blueprint's App spec together with its source — in the same commit for a fork or
  private copy Ever Works created, in the same setup pull request otherwise.

- **S10 — Recognise an App Work anywhere.**
  **Given** an App Work exists,
  **when** the member sees it in the Works list, the Work switcher or the Work header,
  **then** it carries the **App** chip, the Overview shows no Items, Generator, Comparisons or community
  pull-request surfaces, and the Tasks, Knowledge base and Deploy surfaces are present.

### 3.2 Unhappy paths

- **S11 — Not a GitHub repository URL.** A GitLab URL, an SSH remote, a URL with a token in it or a
  deeper path shows **"Enter a GitHub repository URL like https://github.com/owner/repo"** under the field;
  **Check repository** stays disabled; no request leaves the browser.
- **S12 — Repository not found or not readable.** **"We couldn't find this repository, or your GitHub
  account can't read it."** No mode is offered.
- **S13 — GitHub not connected.** **"Connect GitHub to create an App Work."** with **Connect GitHub**.
  Nothing else renders.
- **S14 — Owner disallows forking.** For a private repository whose owner turned forking off: **Fork**
  and **Private copy** are disabled with **"The owner of this repository doesn't allow forks or copies."**;
  **Link** is offered only if the member can push.
- **S15 — Archived repository.** The preview shows **"This repository is archived. Upstream sync stays
  off."**; **Link** is disabled with **"Archived repositories are read-only."**; **Fork** and **Private copy**
  stay available.
- **S16 — Empty repository.** **"This repository has no commits yet."** No mode is offered.
- **S17 — Organization restricts third-party access.** Picking `locked-org` in **Fork into** marks it
  **"locked-org restricts third-party access. Ask an owner of locked-org to approve Ever Works, or pick
  another account."**; create stays disabled for that owner.
- **S18 — The member can't create repositories in the organization.** GitHub refuses the fork at create
  time: the form shows **"You can't create repositories in my-org."**, no App Work row exists, and nothing
  was created on GitHub.
- **S19 — Too large for a private copy.** For a 2.1 GB repository **Private copy** is disabled with
  **"Too large for a private copy (2.1 GB). Fork it instead."**
- **S20 — Uses Git LFS.** **Private copy** is disabled with **"Uses Git LFS, which a private copy can't
  carry over. Fork it instead."**
- **S21 — Fork is slow.** After 15 minutes of preparing, the card reads **"Your fork is taking longer than
  15 minutes."** with **Try again** and **Open on GitHub**; **Try again** resumes waiting and never asks
  GitHub for a second fork.
- **S22 — GitHub access revoked mid-fork.** The member disconnects GitHub while preparing: the card reads
  **"Ever Works lost access to GitHub while preparing this App Work."** with **Reconnect GitHub**; after
  reconnecting, **Try again** adopts the fork that already exists.
- **S23 — Rate limited.** **"GitHub is rate-limiting your account. Try again at 14:05."** (the reset time,
  in the member's time zone). No partial App Work exists.
- **S24 — App Works turned off on this instance.** The **App** chip is absent; a direct attempt to check or
  create an App Work — from the web app, chat, the MCP server or the command-line client — answers **"App
  Works are not available on this instance."** and creates nothing.

### 3.3 Race and permission edges

- **S25 — Double-click.** Two create requests from one click burst produce exactly one App Work and at
  most one fork; the second request answers **"This App Work is already being created."** and the page
  follows the first.
- **S26 — Retry after a lost response.** A client that times out and re-sends the identical request
  within 10 minutes receives the App Work the first request created, marked as already existing.
- **S27 — Another account already linked it.** Member B checks `me/booking`, which member A registered
  as a Repository Work or linked as an App Work: **Link** is disabled with **"Another account already uses
  this repository in Ever Works. Ask its owner to add you as a member."** **Fork** stays available — forks
  are per account.
- **S28 — Same member, same repository again.** A member who already has an App Work on `<login>/tasks-app`
  and asks for another after 10 minutes gets **"You already have an App Work for <login>/tasks-app: Tasks
  App."** with a link to it; no second App Work shares that repository.
- **S29 — The fork exists but another account's App Work uses it.** In a shared organization, member B
  tries to use `my-org/tasks-app` that member A's App Work already uses: **"Another account already uses
  my-org/tasks-app in Ever Works."**; B can pick another owner or a private copy.
- **S30 — Repository renamed.** `acme/old-name` redirects to `acme/tasks-app`: the preview shows
  **"Moved to acme/tasks-app"** and everything is recorded under the new name.
- **S31 — Default branch is not `main`.** A repository whose default branch is `develop` shows
  **"Default branch: develop"**, and the source file and every later step use `develop`.
- **S32 — The setup pull request.** For a linked repository or a fork the member already had, the App Work
  shows **"Merge the setup pull request to finish."** with **Open pull request** until it is merged, whatever
  the branch's protection rules; a retry reuses the open pull request. If the member closes it without
  merging, the card reads **"The setup pull request was closed without merging."** with **Try again**, which
  opens a new one.
- **S33 — Someone else's App Work.** No message reveals another account's App Work; conflicts name only the repository.

- **S34 — A Blueprint the member never named.** **Given** the App form is open on **Paste a URL** and the member
  pastes `acme/tasks-app`, which the Apps catalog lists, **when** the preview renders, **then** the Blueprint badge
  reads **Verified Blueprint** and creating the App Work records that Blueprint on it — the member never picks it,
  and a later reader sees which Blueprint applies and how it was matched. Clearing the URL clears the match.

- **S35 — Values I already know, typed before the app exists.** **Given** a Blueprint whose App spec prompts for a
  mail server and an admin password, **when** the preview renders, **then** the form shows those prompts with their
  descriptions and which of them are required; **then** the member types them and presses **Fork and create App
  Work**, and the values are stored encrypted on the App Work once its App spec exists, so the first deploy uses
  them without the member typing them again. Leaving a required prompt empty keeps the submit button disabled with
  **"Fill in the values the app needs first."**; no prompt is ever rendered with a value already in it.

- **S36 — Reconnecting a workspace does not create App Works.** **Given** a workspace export whose Works include a
  crafted entry claiming kind `app`, **when** the member imports it, **then** no App Work is created or converted:
  the entry keeps the kind it has today (or is skipped when it has none), the import report lists it as skipped with
  **"App Works aren't restored by import — create them from the repository URL."**, and no cluster workload, build or
  repository write happens.

## 4. Functional requirements

Every threshold below is a number on purpose.

### 4.1 Kind and capabilities

- **FR-1.** The system MUST add the Work kind **app** (chip label **App**) to the kinds a member can pick
  at creation, gated by the `works-app` feature flag in the web app and by an instance setting in the API.
- **FR-2.** An App Work MUST have: Deploy, Builds, App environment, Tasks, Knowledge base and schedules
  **on**; Items, taxonomy, comparisons, community pull-request intake, item import/export, source validation
  and the website generator **off**; exactly one repository role — the **Work Repository** (persisted
  `website`), which holds the app code and is what Tasks, Builds and Deployments target; **never** the `data`
  role, which holds a Work's data (`README.md` §1 repository-role note). The capability set is therefore
  `repos: { data: false, work: false, website: true }`. Builds and App
  environment MUST be off for every other kind (Resolution R-7).
- **FR-3.** The Repository Work kind MUST keep exactly its current capabilities and refusals.
- **FR-4.** Every content pipeline that clones the Work Repository and writes generated content into it
  MUST refuse an App Work with a message naming the refused action (see §4.9).

### 4.2 Inspect — the preview (no side effects)

- **FR-5.** The system MUST offer an inspect operation that takes a repository URL and returns, without
  creating, forking, copying, writing or recording anything: canonical owner/name, default branch, star
  count, size, visibility, archived flag, fork parentage, whether forking is allowed, the caller's push and
  admin permission, the modes available with a stable reason code for each unavailable one, the default
  mode, the owners the caller can fork into, any existing fork per owner, the Blueprint match, and a license
  preview.
- **FR-6.** URL parsing MUST reuse the Repository Work rules exactly: GitHub only, `owner/repo` only, no
  credentials, query or fragment, at most 400 characters.
- **FR-7.** Inspect MUST make at most 15 provider API calls — the existing-fork scan of FR-9 counting toward that
  same budget — complete within 8 seconds at p95, cache its answer per member and repository for 60 seconds, and be
  rate-limited to 30 requests per minute per member.
- **FR-8.** When the Blueprint or license lookup is unavailable, inspect MUST still answer, with the
  Blueprint marked unavailable and the license class **unknown** — never a guessed class. The license chip
  states what the class allows (Resolution R-3): **green** — hosting allowed on every target; **amber** and
  **red** — Your cluster after the owner's attestation (amber reaches Ever Works Apps only with a recorded
  upstream agreement, red never does); **unknown** — treated as needing attestation.
- **FR-9.** Existing-fork detection MUST recognise a fork by its upstream network, not by name. Within the FR-7
  call budget it MUST check the caller's own account first, then the organizations offered in **Fork into** in A–Z
  order (up to 30 offered in P1, up to 200 in P2). The fixed checks that precede the scan are bounded so the scan
  always has room: repository read 1, default-branch read at most 1 (only when the repository reports size 0),
  caller read 1, organizations read 1, `.gitattributes` read 1 — at most 5. Each owner is charged the calls it
  actually made and a new owner is started only while at least 3 calls remain. An owner the budget did not reach
  MUST stay selectable with its availability unchanged, MUST be reported as **not checked** — never as having no
  fork, and never with a reason code — and the response MUST say the scan was incomplete. Creating into that owner
  still adopts an existing fork (FR-19, APW-02 FR-10).
- **FR-10.** A 403 from GitHub MUST be classified — not found, SAML authorization required, third-party
  access restricted, rate limited — and never reported as a generic "no access".

### 4.3 Create — validation before side effects

- **FR-11.** Creating an App Work MUST accept the repository URL, a mode (`link`, `fork`, `private-copy`)
  and, for `fork` and `private-copy`, a target owner.
- **FR-12.** Before any repository is created, any file is written or any row is persisted, the system MUST
  re-run every inspect check for the chosen mode and target owner, validate the slug, the deploy target and
  the instance setting, and refuse with the same reason codes inspect uses.
- **FR-13.** A member who is not connected to GitHub, whose connection lacks repository scope, or whose
  connection belongs to a different provider than the URL MUST be refused before any provider write.
- **FR-14.** A target owner MUST be the member's own GitHub login or an organization their connection
  reports; any other value MUST be refused.
- **FR-15.** Forks and copies MUST be made with the member's own connection. The platform's own GitHub
  organizations MUST never be a fork or copy target through this flow.
- **FR-16.** Creating an App Work MUST never delete, rename, archive or change the visibility of the
  upstream repository, and MUST never push to it.

### 4.4 Modes

- **FR-17.** **Link** MUST be available only when the member can push, the repository is not archived and
  no other account already uses it (FR-26). The default mode is **Link** when the member can push to a
  repository that is not a fork.
- **FR-18.** **Fork** MUST be available when forking is allowed, the repository is not empty and the
  member does not own the repository in the target account. It is the default when the member cannot push,
  or when the pasted repository is itself a fork the member can push to (then that fork is used and its
  parent is the upstream).
- **FR-19.** When a fork of the upstream already exists in the target owner, the system MUST use it and
  MUST NOT request another.
- **FR-20.** **Private copy** MUST be available only when the repository is at most 500 MB as GitHub
  reports it, does not use Git LFS, and — for a private upstream — its owner allows forking. The copy is
  private, carries the default branch with its full history, and is named after the upstream, adding
  `-copy`, then `-copy-2` up to `-copy-5` when taken.
- **FR-20a.** The App Work's **Work Repository** name MUST be chosen once, at creation, from the template it was
  created from: **`<slug>-app`** when that template is an app template, and **`<slug>-website`** otherwise (the
  unchanged default for Website/Work Templates and for every non-`app` kind). The chosen name and owner MUST be
  persisted, never re-derived by a reader when the coordinates are recorded. A Work whose recorded name uses the
  other suffix, or that the user renamed, MUST be respected and never renamed, and the platform MUST NOT rename a
  repository it created. **The suffix is a naming convention only — the persisted role stays `website` and no new
  repository-role value is added** (owner decision, 2026-09-17). A name conflict follows FR-24 (adopt, or the
  existing conflict code) and is never resolved by adding a numeric suffix; `-copy` variants remain **Private
  copy** only (FR-20).
- **FR-21.** The create response MUST return within 10 seconds and MUST NOT wait for a fork or copy to
  finish.

### 4.5 Idempotency and conflicts

- **FR-22.** Concurrent create requests for the same member, upstream, mode and target owner MUST be
  serialised for up to 120 seconds; a request that finds one in flight answers **already being created**.
- **FR-23.** A create request identical in member, Work Repository and slug to an App Work created in the
  last 10 minutes MUST return that App Work, marked as already existing, and create nothing.
- **FR-24.** Outside that window, a member MUST NOT get a second App Work on a Work Repository they
  already use; the answer names their existing App Work.
- **FR-25.** Every create step that talks to GitHub MUST be safe to repeat: a retried fork adopts the
  existing fork; a retried copy adopts a repository of the chosen name that is empty or already a copy of
  this upstream by this member, and refuses any other repository of that name.
- **FR-26.** **Link** MUST be refused with a conflict when another account already uses the same repository
  as a Repository Work or an App Work. A fork or copy MUST be refused with a conflict only when another
  account's App Work already uses that exact fork or copy.

### 4.6 Preparing and the initial source file

- **FR-27.** A fork or copy App Work MUST be persisted in a **preparing** state immediately and shown as
  such on its page, in the Works list and to chat tools.
- **FR-28.** Readiness MUST be handed to the fork lifecycle background job (APW-02); this epic MUST NOT
  poll GitHub inside the create request.
- **FR-29.** Only after the Work Repository is ready MUST the system record `.works/works.yml` with version
  2, kind `app` and the source block (relation, upstream owner/name/default branch when not linked, branch).
  Any other content already in that file MUST be preserved. How it lands is fixed by Resolution R-4: (a) a
  fork or private copy that this App Work's creation made MUST receive it as exactly one direct commit on the
  default branch, made without cloning the repository; (b) a linked repository, and a fork that already
  existed (pasted or adopted), MUST receive it through one setup pull request — the system MUST NEVER push to
  a default branch it did not create. When a Blueprint was matched or picked, the source block and the
  Blueprint's App spec MUST land together, in that one commit or that one pull request (the Blueprint
  application itself belongs to APW-03); the Blueprint applied MUST be the one the member saw in the preview.
- **FR-29b.** The Blueprint an App Work carries MUST be settled at create time by the server, from the resolution
  order the program fixed (manifest match, then alias, then fork network, then probe, then an explicit id) — no
  client has to send one. When the member did send an id and it is not the one the server resolved, creation MUST
  be refused with `blueprint_mismatch` and nothing is written. Which Blueprint applies, and how it was matched,
  MUST be persisted on the App Work's source record and returned to every caller, so chat, MCP and command-line
  callers see the same Blueprint as the form.
- **FR-29a.** When no Blueprint applies and the repository carries no valid App spec, the system MUST start
  the App Provisioner (APW-04) once the source is on the default branch (after the commit, or after the setup
  pull request is merged), and MUST NOT start it twice for one App Work. A file holding only the source block is
  **not** an App spec, so the minimal path always starts provisioning; the question is asked of the commit the
  source was recorded on, synchronously, and never of the asynchronous evaluation state. The member MAY decline
  that start at creation, with **Let an agent work out how to run it** (offered when no Blueprint applies, ticked
  by default): the choice is persisted on the App Work's source record and honoured until the source reaches the
  default branch, including after a setup pull request is merged, so a declined App Work stays **Not started**
  with **Provision** on the Overview (APW-04) instead of spending agent runs and build minutes; the form MUST
  state that spend beside the checkbox. Declining never removes the Provisioner — APW-04's card and its
  **Provision** action stay available, and nothing else about the App Work changes.
- **FR-30.** While a setup pull request is open the App Work MUST show as waiting for that merge; once it is
  merged the App Work MUST become ready; closed without merging, the App Work MUST show that and offer **Try
  again**, which opens a new setup pull request.
- **FR-31.** Recording the source MUST be idempotent: an identical existing source block is a no-op, and an
  open setup pull request is reused rather than duplicated.
- **FR-32.** Each outcome MUST record exactly one Activity entry: linked, forked, copied or failed — with the
  failure reason code and never a token or file body.

### 4.7 Deploy target

- **FR-33.** The create form MUST offer three deploy targets: **None — don't deploy yet** (default, nothing
  is deployed; Resolution R-12 — there is no separate "not yet" state), **Your cluster** (enabled only when an
  installed deployment option can run App Works) and **Ever Works Apps** (shown disabled with its reason until
  the managed tier is open). Inspect MUST report each target's availability and reason so the form never
  guesses.
- **FR-34.** An App Work MUST NOT inherit a deploy provider from onboarding defaults. The deploy target
  chosen at creation MUST be the target the App runtime (APW-06) shows and uses until the member changes it: the
  runtime's target is **derived once**, when its state row is first created, from the plugin id the create request
  persisted, and a row that already exists is never re-derived. **Ever Works Apps** is persisted as the
  `ever-works-apps` plugin chosen by capability — never as the platform's older managed-hosting id, which belongs
  to website hosting and is counted by its own quota. An id that is unknown, disabled or not apps-capable derives
  to **None**. Until the App runtime merges, the Deploy surface reads the target from its route and treats a missing
  route as **None** (FR-40a).
- **FR-35.** A request naming **Ever Works Apps** while the managed tier is disabled MUST be refused.
- **FR-36.** Until the App runtime (APW-06) handles App Works, a deploy request for an App Work MUST be
  refused with **"Deploying App Works arrives with the App runtime."** rather than reaching the website
  deploy path.

### 4.8 Delete

- **FR-37.** Deleting an App Work MUST never delete the upstream repository, and MUST never delete a linked
  repository; an explicit request to delete a linked repository MUST be refused.
- **FR-38.** A fork or private copy MUST be deleted only when the request explicitly asks for it, the
  member has admin permission on it, and — in the web app — the member has typed its `owner/name`.
- **FR-39.** Omitting the flag MUST mean "keep the repository" for every caller, including chat and MCP.
- **FR-40.** If deleting the fork or copy fails, the App Work MUST still be deleted and the response MUST
  say which repository remains and why.
- **FR-40a.** Deleting an App Work MUST also remove its cluster workloads (Deployments, Services, Ingresses,
  Jobs, CronJobs, network policies and its environment Secret) on its deploy target, and MUST keep its volumes
  and App dependencies unless the member ticks **Also delete stored data** and — in the web app — types the
  App Work's slug (Resolution R-15; the removal itself is carried out by the App runtime and App dependencies,
  APW-06/APW-07). That choice MUST be separate from the fork or private copy choice (FR-38); omitting it MUST
  mean "keep stored data" for every caller. The removal MUST run before the App Work itself is deleted; while it
  runs the App Work reads **Deleting…** (APW-06). If the workloads cannot be removed, the App Work MUST still be
  deleted and the member MUST be told what may remain on which target.
- **FR-40b.** The typed-slug confirmation of FR-40a MUST be enforced by the server, not only by the web dialog:
  a request that asks to delete stored data without a confirmation equal to the App Work's slug MUST be refused
  with `422 confirmation_mismatch` **before** the App runtime is asked to remove anything, for every caller — web,
  chat, MCP server and command-line client alike. The MCP server MUST NOT expose the stored-data flag or its
  confirmation as tool arguments at all, so no agent can destroy stored data through it.

### 4.9 Writers that refuse an App Work

- **FR-41.** The following MUST refuse an App Work exactly as they refuse a Repository Work: item
  generation and regeneration, README regeneration, item submit/remove/update, item detail extraction,
  bulk image capture, domain-type update, website repository update and template sync, comparison
  generation (automatic and manual), item source validation, community pull-request processing (the
  scheduled sweep skips silently; a direct call refuses), repository visibility changes, the generation
  schedule upsert, and "sync from Work Repository".
- **FR-42.** Item listing for an App Work MUST answer an empty list without cloning.
- **FR-43.** The `.works/works.yml` sync that follows a Work update MUST NOT write generator settings
  (prompt, model, providers, website repository) into an App Work's file.
- **FR-44.** The Knowledge base mirror MUST NOT commit to an App Work's default branch in P1; it stays
  database-only until APW-08 decides the branch.
- **FR-45.** The instant data-sync poller MUST never select an App Work.
- **FR-46.** The Settings "sync from source" affordance MUST be hidden for App Works.

### 4.10 Surfaces, flag and scope

- **FR-46a.** The App form MUST offer two ways in — **Paste a URL** and **Browse the Apps catalog** (the
  catalog browser belongs to APW-03) — and a catalog pick MUST carry its Blueprint into inspect and create.
- **FR-47.** The **App** chip MUST appear on `/new` and `/works/new` when `works-app` resolves true. Unlike
  other kinds, the flag MUST fail closed for `app`: a missing flag hides the chip — but **only when the web app
  actually has a flag provider configured**. With no PostHog client at all (the PR e2e lane, local development and
  every self-hosted install), the web server MUST read the same runtime instance setting the API uses
  (`EVER_WORKS_APP_WORKS_ENABLED`, read server-side at request time, never a build-time public variable), so the
  chip and the API always agree: the switch on ⇒ the chip shows, the switch unset or `false` ⇒ the chip is hidden.
  A configured provider keeps the other kinds' fail-open behaviour untouched.
- **FR-48.** The API MUST refuse creating an App Work and inspecting a repository for one unless the
  instance setting enables App Works (default off), for every client — web app, chat, MCP server and
  command-line client alike (Resolution R-6). **Workspace import and restore are clients too**: a restored or
  imported Work MUST NEVER be created as, or converted into, kind `app` (FR-54).
- **FR-49.** The chat create tool MUST accept the mode and target owner and MUST ask for confirmation
  before any App Work is created, naming the repository that will be created or written.
- **FR-50.** The MCP server MUST expose inspect as a read-only tool and accept the new create fields.
- **FR-51.** Every read and write MUST be scoped to the caller. Errors MUST name repositories, never another
  account's Work.
- **FR-52.** Every user-visible string MUST be translatable, with keys present in all locale files.
- **FR-53.** The product MUST record, without repository names or tokens: inspect run (mode offered,
  reasons), create started (mode, deploy target), create outcome (reason code), preparing duration.
- **FR-54.** Workspace import and workspace restore MUST NEVER create a Work with kind `app`, and MUST NEVER
  change an existing Work's kind to or from `app`. An imported entry that claims kind `app`, or that would change
  another Work into one, MUST be treated as if it carried no new kind — the Work keeps the kind it has — and the
  import report MUST list it as skipped with **"App Works aren't restored by import — create them from the
  repository URL."** No import path may bypass the instance setting (FR-48), the create-time re-validation (FR-12)
  or the source record this epic writes.
- **FR-55.** When a Blueprint's App spec declares prompted values, the preview MUST show them — name,
  description and whether each is required — and the create request MUST be able to carry the member's answers,
  write-only, so that they are never echoed back by any read. Captured answers MUST be stored encrypted on the App
  Work as soon as its App spec exists, as prompted-origin values, and the first deploy MUST use them; a value the
  member leaves empty for a required prompt MUST NOT block creation, and the app's own readiness MUST report the
  missing value instead. A prompt is never pre-filled with a stored value.
- **FR-56.** A pasted URL, a chat call, an MCP call and a command-line call MUST all end with the same Blueprint
  decision: the server resolves the Blueprint itself (FR-29b) and no client is required to send an id. A caller
  that names a Blueprint the server did not resolve MUST be refused with `blueprint_mismatch` and nothing written.

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity                | Today                                               | This epic adds                                                                                               |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Work**              | A kind, a Work Repository, providers, capabilities. | The kind **app**; a source relation (link/fork/private copy) and an upstream reference on its source record. |
| **Work kind catalog** | Six selectable kinds with capabilities and chips.   | A seventh, **App**, flag-gated; two capability flags, Builds and App environment, on only for App (R-7).     |
| **Activity**          | Records Work lifecycle.                             | Source linked / forked / copied / failed.                                                                    |
| **App spec**          | —                                                   | Its `source` block is written by this epic (the rest belongs to APW-03).                                     |
| **Upstream state**    | — (owned by APW-02)                                 | Created in **preparing** by this epic; read for the header and the preparing card.                           |

### 5.2 New — the kind, not an entity

**App** is a new Work kind, not a new entity. It is required because the Repository Work's contract —
never generate, never deploy, never write — is the opposite of what an App Work needs, and that contract
is enforced in one shared guard the platform's own repositories rely on (README D1). No other new noun is
introduced: the fork is a **Fork**, the copy is a **Private copy**, the original is the **Upstream**.

### 5.3 States

```
 create request ──validate──► refused (4xx, nothing written)
        │
        ├── link ─────────────► preparing ──setup PR opened──► waiting for setup PR ──merged──► ready
        │                                                            └──closed unmerged──► failed ──Try again──► (new PR)
        ├── fork (existing fork adopted) ──► preparing ──setup PR opened──► waiting for setup PR (as link)
        ├── fork (fork requested) ──► preparing
        │                           ├── default branch has a commit ──one commit──► ready
        │                           ├── 15 min ──► timed out ──Try again──► preparing
        │                           └── access lost / fork gone ──► failed ──Reconnect + Try again──► preparing
        └── private copy ──empty private repo created──► preparing ──history pushed──► (as requested fork)
```

## 6. UX

All copy below is final English copy, keyed for translation.

### 6.1 Chip and entry

| Element                        | Copy                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Chip label                     | `App`                                                                                                                       |
| Chip description               | `Run and evolve any GitHub repository — link it or fork it, then choose where it runs.`                                     |
| Composer placeholder           | `e.g. "https://github.com/owner/repo — an open-source app you want your own copy of"`                                       |
| Form title                     | `New App Work`                                                                                                              |
| Form subtitle                  | `Start from any GitHub repository. Ever Works links it or makes your own copy, then helps you run it and keep changing it.` |
| URL label / placeholder / help | `Repository URL` · `https://github.com/owner/repo` · `Any GitHub repository your connected account can read.`               |
| Check button / pending         | `Check repository` · `Checking…`                                                                                            |
| Entry tabs                     | `Paste a URL` · `Browse the Apps catalog`                                                                                   |

### 6.2 Preview card

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  acme/tasks-app   ★ 12,408 stars   Default branch: main                      │
│  [License: MIT · Hosting allowed]  [Blueprint available]                     │
│  ⓘ Forks of public repositories are public.                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│  (•) Fork          Make your own fork…            Fork into [ my-login ▾ ]   │
│  ( ) Private copy  Make a private repository…   + trade-off line             │
│  ( ) Link          You can't push to this repository.        ← disabled      │
├──────────────────────────────────────────────────────────────────────────────┤
│  Where should it run?  (•) None  ( ) Your cluster  ( ) Ever Works Apps ⊘     │
├──────────────────────────────────────────────────────────────────────────────┤
│  ☑ Let an agent work out how to run it      ← shown when no Blueprint applies│
├──────────────────────────────────────────────────────────────────────────────┤
│  Name [Tasks App]  Slug [tasks-app]  Description [acme/tasks-app]            │
│                               [ Cancel ]  [ Fork and create App Work ]       │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Element                        | Copy                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stars                          | `{count, plural, =1 {1 star} other {# stars}}`                                                                                                                                                            |
| Default branch                 | `Default branch: {branch}`                                                                                                                                                                                |
| Size (shown when > 100 MB)     | `Large repository ({size})`                                                                                                                                                                               |
| Moved                          | `Moved to {fullName}`                                                                                                                                                                                     |
| Is a fork                      | `This repository is a fork of {parent}.`                                                                                                                                                                  |
| Own fork                       | `This is your fork of {parent}. Ever Works will follow {parent} as upstream.`                                                                                                                             |
| Public fork note               | `Forks of public repositories are public.`                                                                                                                                                                |
| Archived                       | `This repository is archived. Upstream sync stays off.`                                                                                                                                                   |
| License chip                   | `License: {spdx}` · `License: not detected`                                                                                                                                                               |
| License class (R-3)            | `Hosting allowed` (green) · `Your cluster, after you attest the license` (amber, red) · `License unknown — you'll attest it before deploying` (unknown)                                                   |
| Blueprint badge                | `Verified Blueprint` · `Blueprint available` · `No Blueprint — an agent will work out how to run it` · `Blueprint check unavailable`                                                                      |
| Link                           | `Link` — `Use this repository as it is. You can push to it, so changes land here directly.`                                                                                                               |
| Link (on own fork)             | `Link — don't follow upstream`                                                                                                                                                                            |
| Fork                           | `Fork` — `Make your own fork. You can sync it with upstream and propose changes back.`                                                                                                                    |
| Fork into                      | `Fork into`                                                                                                                                                                                               |
| Existing fork                  | `You already have a fork: {fullName}. Ever Works will use it.`                                                                                                                                            |
| Private copy                   | `Private copy` — `Make a private repository with the same code.`                                                                                                                                          |
| Private copy trade-off         | `A private copy is not linked to the original on GitHub, so it can't open pull requests to the original project. Upstream changes arrive as pull requests in your copy.`                                  |
| Link setup note                | `Ever Works opens a pull request that adds one file, .works/works.yml. Merge it to finish.`                                                                                                               |
| Existing fork setup note       | `Ever Works didn't create this fork, so it opens a pull request that adds .works/works.yml.`                                                                                                              |
| Link setup note (Blueprint)    | `Ever Works opens a pull request that adds .works/works.yml and the Blueprint's files. Merge it to finish.`                                                                                               |
| Existing fork note (Blueprint) | `Ever Works didn't create this fork, so it opens a pull request that adds .works/works.yml and the Blueprint's files.`                                                                                    |
| Prompts title                  | `Values this app needs`                                                                                                                                                                                   |
| Prompt hint                    | `The {name} Blueprint asks for these. You can change them later in Settings.`                                                                                                                             |
| Prompt required marker         | `Required`                                                                                                                                                                                                |
| Prompts incomplete             | `Fill in the values the app needs first.`                                                                                                                                                                 |
| Provision automatically        | `Let an agent work out how to run it` — shown only when no Blueprint applies (badge `No Blueprint — an agent will work out how to run it` or `Blueprint check unavailable`), ticked by default            |
| Provision automatically (help) | `Starts when the repository is ready. It spends AI tokens and build runner minutes, within the provisioning caps. You can cancel it, or untick this and start it later from the Overview with Provision.` |
| Deploy target title            | `Where should it run?`                                                                                                                                                                                    |
| None (R-12)                    | `None — don't deploy yet` — `You can pick a target later.`                                                                                                                                                |
| Your cluster                   | `Your cluster` — `Run it on your own Kubernetes cluster. You'll add the connection on the Deploy tab.`                                                                                                    |
| Ever Works Apps                | `Ever Works Apps` — disabled: `Coming soon — managed hosting for apps isn't open yet.`                                                                                                                    |
| Submit (per mode)              | `Link and create App Work` · `Fork and create App Work` · `Copy and create App Work`                                                                                                                      |
| Submit pending                 | `Creating…`                                                                                                                                                                                               |
| Name / Slug / Description      | `Name` · `Slug` · `Description`                                                                                                                                                                           |
| Slug help                      | `URL-friendly identifier. Derived from the repository name — edit to override.`                                                                                                                           |
| Invalid slug                   | `Use lowercase letters, digits and hyphens only, for example tasks-app`                                                                                                                                   |
| Cancel                         | `Cancel`                                                                                                                                                                                                  |
| Create failed (unknown reason) | `Couldn't create the App Work. Try again.`                                                                                                                                                                |
| Success (link / fork / copy)   | `App Work created.` · `Fork requested — we'll tell you when it's ready.` · `Copy started — we'll tell you when it's ready.`                                                                               |

### 6.3 Unavailable reasons (exact copy per reason code)

| Reason code                   | Copy                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `invalid_url`                 | `Enter a GitHub repository URL like https://github.com/owner/repo`                                              |
| `provider_not_connected`      | `Connect GitHub to create an App Work.`                                                                         |
| `insufficient_scope`          | `Reconnect GitHub to grant repository access.`                                                                  |
| `not_found`                   | `We couldn't find this repository, or your GitHub account can't read it.`                                       |
| `sso_authorization_required`  | `{owner} requires you to authorize Ever Works for its organization on GitHub.`                                  |
| `oauth_app_restricted`        | `{owner} restricts third-party access. Ask an owner of {owner} to approve Ever Works, or pick another account.` |
| `empty_repository`            | `This repository has no commits yet.`                                                                           |
| `no_push_access`              | `You can't push to this repository.`                                                                            |
| `archived`                    | `Archived repositories are read-only.`                                                                          |
| `forking_disabled`            | `The owner of this repository doesn't allow forks or copies.`                                                   |
| `own_repository`              | `You own this repository — link it instead.`                                                                    |
| `target_owner_unavailable`    | `This account isn't available on your GitHub connection.`                                                       |
| `target_owner_forbidden`      | `You can't create repositories in {owner}.`                                                                     |
| `too_large_for_private_copy`  | `Too large for a private copy ({size}). Fork it instead.`                                                       |
| `uses_lfs`                    | `Uses Git LFS, which a private copy can't carry over. Fork it instead.`                                         |
| `copy_name_unavailable`       | `{owner} already has repositories named {name} through {name}-copy-5.`                                          |
| `in_use_by_another_account`   | `Another account already uses this repository in Ever Works. Ask its owner to add you as a member.`             |
| `app_work_exists`             | `You already have an App Work for {fullName}: {workName}.`                                                      |
| `create_in_progress`          | `This App Work is already being created.`                                                                       |
| `rate_limited`                | `GitHub is rate-limiting your account. Try again at {time}.`                                                    |
| `managed_hosting_unavailable` | `Coming soon — managed hosting for apps isn't open yet.`                                                        |
| `cluster_target_unavailable`  | `No deployment option that can run apps is installed.`                                                          |
| `app_works_disabled`          | `App Works are not available on this instance.`                                                                 |
| `blueprint_mismatch`          | `The Blueprint for this repository changed. Check the repository again.`                                        |

### 6.4 App Work page: header, preparing, waiting

The relation line sits in the header meta row right after the **App** chip; the status card sits above the
Overview tiles and disappears when the App Work is ready.

| Element                        | Copy                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Header relation                | `Upstream: {fullName}` · `Fork: {fullName}` · `Private copy: {fullName}` · `Linked: {fullName}`                                       |
| Preparing (fork)               | `Preparing your fork` — `GitHub is creating {fullName}. This usually takes under a minute; large repositories can take longer.`       |
| Preparing (copy)               | `Preparing your private copy` — `Copying {upstream} into {fullName}. Larger repositories take longer.`                                |
| Preparing (link)               | `Finishing setup` — `Opening a pull request that adds .works/works.yml to {fullName}.`                                                |
| Preparing (Blueprint applying) | `Applying the {name} Blueprint` — `Ever Works is preparing your App Work and will write .works/works.yml with the Blueprint's files.` |
| Setup PR closed                | `The setup pull request was closed without merging.` · `Try again`                                                                    |
| Timed out                      | `Your fork is taking longer than 15 minutes.` · `Try again` · `Open on GitHub`                                                        |
| Failed (access)                | `Ever Works lost access to GitHub while preparing this App Work.` · `Reconnect GitHub` · `Try again`                                  |
| Failed (other)                 | `Preparing this App Work failed: {reason}` · `Try again`                                                                              |
| Waiting for setup PR           | `Merge the setup pull request to finish.` · `Open pull request`                                                                       |

**Failed reasons (fills `{reason}`).** The card never shows a raw code: a leading `handler_failed:` is stripped,
`too_large` is shown as `too_large_for_private_copy`, `access_revoked` uses the **Failed (access)** row above and
`setup_pull_request_closed` the **Setup PR closed** row, and every other or unknown code uses the last row.

| Reason code                                          | Copy                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `works_yml_unparseable`                              | `.works/works.yml on the default branch isn't valid YAML. Fix or remove the file, then try again.`              |
| `works_yml_other_kind`                               | `.works/works.yml already declares a different kind of Work. Set kind: app or remove the file, then try again.` |
| `push_rejected`                                      | `GitHub kept rejecting the commit that adds .works/works.yml.`                                                  |
| `provider_unsupported`                               | `This repository's Git provider can't be set up automatically.`                                                 |
| `too_large_for_private_copy` (and `too_large`)       | `The repository is too large for a private copy. Create a fork instead.`                                        |
| `uses_lfs`                                           | `The repository uses Git LFS, which a private copy can't carry over. Create a fork instead.`                    |
| any other or unknown code (incl. `handler_failed:*`) | `Something went wrong while setting up the repository.`                                                         |

**Retry limit.** When `retry_limit_reached` is reported, or the Work's `manualRetriesLeft` is 0, **Try again** is
disabled and the row reads `You've used all 3 retries for this hour. Try again later.`

### 6.5 Delete dialog

| Element                  | Copy                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Checkbox (fork)          | `Also delete my fork {fullName} on GitHub`                                                       |
| Checkbox (copy)          | `Also delete my private copy {fullName} on GitHub`                                               |
| Helper                   | `Deleting a repository can't be undone. The original repository is never touched.`               |
| Typed confirmation label | `Type {fullName} to confirm`                                                                     |
| Link note                | `The linked repository {fullName} is never deleted.`                                             |
| No admin                 | `You're not an admin of {fullName}, so it can't be deleted from here.`                           |
| Partial failure          | `The App Work was deleted, but {fullName} could not be deleted: {reason}`                        |
| Workloads note (R-15)    | `The app is stopped and removed from {target}. Stored data is kept unless you choose otherwise.` |
| Stored data checkbox     | `Also delete stored data`                                                                        |
| Stored data helper       | `Deletes the app's volumes and databases. This can't be undone.`                                 |
| Stored data confirmation | `Type {slug} to confirm`                                                                         |
| Workloads not removed    | `The App Work was deleted, but its app could not be removed from {target}: {reason}`             |

### 6.6 Keyboard

| Where         | Key            | Action                                                                  |
| ------------- | -------------- | ----------------------------------------------------------------------- |
| URL field     | `Enter`        | Check repository (only when the URL parses).                            |
| Mode cards    | `↑` `↓`        | Move between available modes; disabled modes are skipped but announced. |
| Owner picker  | type to search | Filters owners when more than 10 are listed.                            |
| Delete dialog | `Enter`        | Delete, only when the typed confirmation matches.                       |

Every disabled option exposes its reason as text to assistive technology; colour never carries meaning alone.

## 7. Out of scope

- Building, running, deploying (APW-05/06); the App spec beyond `source` and the license gate (APW-03);
  provisioning (APW-04); upstream sync, divergence, Actions hygiene (APW-02); upstream PRs (APW-09).
- GitLab, Bitbucket and self-hosted Git (refused by the parser as today); converting a Repository Work into
  an App Work or between relations; transferring a fork; choosing a fork name at creation.

## 8. Acceptance criteria

Each item is an acceptance scenario collected into [ACCEPTANCE.md](../ACCEPTANCE.md) under its id.

- [ ] **ACC-01-01** — Linking a repository the member can push to creates an App Work with no new
      repository, pushes nothing to its default branch, opens one setup pull request adding `.works/works.yml`
      (kind `app`, relation `link`) and records "source linked" (S4, FR-29).
- [ ] **ACC-01-02** — Forking a public repository into the member's account shows Preparing, then Ready
      with the Upstream/Fork header and the source file in the fork, written as exactly one commit without a
      clone (S1, S2, FR-29).
- [ ] **ACC-01-03** — Forking into an organization uses the member's connection and never a platform
      organization (S3).
- [ ] **ACC-01-04** — An existing fork, including a renamed one, is adopted with no fork request, and its
      source arrives through a setup pull request, never a direct push (S5, S7, FR-29).
- [ ] **ACC-01-05** — A private copy is private, carries the default branch history and shows the trade-off
      copy before creation (S6).
- [ ] **ACC-01-06** — Inspect writes nothing: no repository, no row, no Activity, no file (FR-5).
- [ ] **ACC-01-07** — Each of `invalid_url`, `provider_not_connected`, `not_found`, `archived` (link),
      `forking_disabled`, `empty_repository`, `too_large_for_private_copy`, `uses_lfs` refuses creation
      with its copy and zero provider writes (S11–S20, FR-12).
- [ ] **ACC-01-08** — A double-submit yields one App Work and at most one fork; a retried request within
      10 minutes returns the same App Work (S25, S26).
- [ ] **ACC-01-09** — Link is refused when another account uses the repository; Fork is still offered (S27).
- [ ] **ACC-01-10** — Deleting an App Work keeps the fork unless ticked and typed; a linked repository and
      the upstream are never deleted; omitting the flag via API keeps the fork (FR-37–FR-40).
- [ ] **ACC-01-11** — Every writer in FR-41 refuses an App Work; item listing is empty without a clone (FR-42).
- [ ] **ACC-01-12** — **None — don't deploy yet** is the default deploy target; Ever Works Apps is disabled
      with its reason and refused by the API; Your cluster persists when available (S8, FR-33–FR-36).
- [ ] **ACC-01-13** — With `works-app` missing the chip is hidden; with the instance setting off the API
      refuses both inspect and create for kind `app`, whichever client calls it (S24, FR-47, FR-48).
- [ ] **ACC-01-14** — Chat asks for confirmation before creating; MCP exposes inspect read-only and the
      new create fields (S9, FR-49, FR-50).
- [ ] **ACC-01-15** — Revoking GitHub mid-fork ends in Failed with Reconnect; Try again adopts the existing
      fork (S22).
- [ ] **ACC-01-16** — Readiness timeout shows the 15-minute copy; Try again never requests a second fork (S21).
- [ ] **ACC-01-17** — A setup pull request (linked repository or existing fork) keeps the App Work waiting
      until it is merged, is reused on retry, and when closed unmerged shows its copy with Try again opening a
      new one (S32, FR-30, FR-31).
- [ ] **ACC-01-18** — Every new key exists in all 21 locale files; no leaf key contains a dot (FR-52).
- [ ] **ACC-01-19** — Picking an app from the Apps catalog fills the URL, previews the same Blueprint, and
      the created App Work receives the source and that Blueprint's App spec in one commit or pull request;
      an App Work without a Blueprint starts the App Provisioner exactly once (S9b, FR-29, FR-29a).
- [ ] **ACC-01-20** — Deleting an App Work asks the App runtime to remove its workloads with stored data kept
      by default; stored data is deleted only when **Also delete stored data** is ticked and the App Work's slug typed;
      that choice never changes the fork decision, and a failed removal still deletes the App Work and names what
      remains (FR-40a, Resolution R-15).
- [ ] **ACC-01-21** — A pasted URL the Apps catalog lists is created with that Blueprint recorded and applied
      even though no client sent an id; a caller that names a different Blueprint gets `blueprint_mismatch` with
      nothing written; the response tells every client which Blueprint applies and how it was matched (S34, FR-29b,
      FR-56).
- [ ] **ACC-01-22** — A Blueprint's prompted values render on the preview with their descriptions and required
      markers, are carried write-only by the create request, are stored encrypted once the App spec exists, and
      never appear in any read response (S35, FR-55).
- [ ] **ACC-01-23** — A workspace import whose entry claims kind `app`, or would convert another Work into one,
      creates or converts nothing, keeps the kind the Work has, lists the entry as skipped with its copy, and
      bypasses neither the instance setting nor create-time re-validation (S36, FR-48, FR-54).
- [ ] **ACC-01-24** — Asking to delete stored data without a server-side confirmation equal to the App Work's slug
      is refused with `422 confirmation_mismatch` before the App runtime is asked for anything, and the MCP delete
      tool exposes neither the stored-data flag nor its confirmation (FR-40b).
- [ ] **ACC-01-25** — With no PostHog provider configured the **App** chip follows the runtime instance setting
      read server-side (switch on ⇒ chip shown, unset ⇒ hidden) while every other `works-<kind>` flag keeps its
      fail-open behaviour; with a provider configured, a missing flag hides the chip (FR-47).
- [ ] **ACC-01-26** — Inspect never exceeds its 15-call budget, checks the caller's account first, reports an owner
      it could not reach as **not checked** with the scan marked incomplete and no reason code, and creating into
      that owner still adopts a fork that exists there (FR-7, FR-9).
- [ ] **ACC-01-27** — The deploy target chosen at creation survives as the App runtime's target, derived once from
      the persisted plugin id: **None** for nothing, **Your cluster** for an apps-capable plugin, **Ever Works
      Apps** for the apps-tier plugin — and never through the platform's website managed-hosting id (FR-34).
- [ ] **ACC-01-28** — Unticking **Let an agent work out how to run it** at creation persists the decline, starts
      no provisioning run and no build once the source reaches the default branch (including after a setup pull
      request is merged), leaves the Overview's Provisioning card in its Not started state with **Provision**,
      and the same App Work provisions exactly once when the member presses it (APW-04); ticking it, or leaving
      it at its default, provisions exactly once and the spend is disclosed on the form (FR-29a).

## 9. Open questions

- **[NEEDS CLARIFICATION: private copy of a private upstream whose owner disallows forking.]** Cloning is
  technically possible with read access. This spec refuses it to respect the owner's intent. Confirm.
- **[NEEDS CLARIFICATION: should Link on a repository another account uses become "join as member"?]**
  Today it is a conflict with instructions to ask the owner; a join-request flow is a separate epic.
- **[NEEDS CLARIFICATION: refuse a Repository Work created after an App Work on the same repository?]**
  The Repository Work create path is unchanged here (program rule 1), so that direction stays allowed.
- **[NEEDS CLARIFICATION: private copy ceiling and fork naming.]** 500 MB keeps a copy inside one job budget —
  raise it once copies run on the in-cluster builder (APW-10)? Should a member name the fork at creation?
