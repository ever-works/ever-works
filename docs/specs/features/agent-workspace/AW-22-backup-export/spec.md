# AW-22 — Backup and export the workspace · Product Spec

**Epic:** `AW-22-backup-export` · **Program:** [Agent Workspace](../README.md)
**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design
**Size:** S · **Blocking dependencies:** none
**Soft dependencies:** [AW-01](../README.md#3-epics) (a palette command that starts a backup),
[AW-13](../README.md#3-epics) (routing the "your backup is ready" notice),
[AW-25](../README.md#3-epics) (the help article that explains the format)

> **Additive-only (program rule #1, NN #20).** The JSON export, the import preview/apply flow
> and the GitHub config-repo sync that ship on `/settings/data` today are untouched. This epic
> adds a second, complete artefact alongside them, and a record of the artefacts produced.
>
> **One new noun.** *Workspace backup* — a durable record of one produced archive. §5 justifies
> it and fences it off from the existing stateless export. No existing noun changes meaning.

---

## 1. Overview

One button produces **a complete, dated, self-describing archive of the workspace** — every
domain the platform stores on the user's behalf, written as structured data the user can open,
read, grep, keep offline, or hand to another system, with a manifest that says exactly what is
inside, what was trimmed and why, and which parts can be restored back into Ever Works. The
archive is built in the background, so its size does not depend on how long a browser tab stays
open; the user is told when it is ready, downloads it from a short list of recent backups, and
the file stays available for a fixed window before it is deleted. A separate action reads a
manifest back and reports, before anything is written, exactly what a restore would and would
not recreate.

## 2. Why now

**The user's question this answers:** *"If I stop paying, if I want to move, if something goes
badly wrong — do I still have my work?"* Every other epic in this program persuades an owner to
put more of their operation into Ever Works: their agents' instructions, their missions, their
decisions, their knowledge, their machines. The honest counterpart of that ask is a way to walk
out with all of it, and to know in advance precisely what "all of it" means.

**What our users do today.** They open **Settings → Data**, tick some checkboxes, and press
Export. That path is real and works, but it answers a narrower question than the one being
asked:

| What happens today | Why it does not answer the question |
| --- | --- |
| The export runs inside the web request that asked for it, is assembled entirely in memory, is handed back through a server action, is re-serialised in the browser, and only then becomes a file. | A workspace with a few large directories, a year of runs, or any attachments is a coin-flip: the request times out, or the tab's memory does. There is no progress, no resume, and no evidence afterwards that it was ever attempted. |
| The payload covers the account profile, the Works and their content, and installed plugin settings — plus, behind four opt-in checkboxes, Agents, Skills, Tasks and task chat. | Everything else the workspace contains is absent: missions, goals, ideas, knowledge documents and their uploads, memory folders, schedules and triggers, runs and their logs, decisions and escalations, the inbox, email, teams, connections, environments, node inventory, the activity history, and the billing/usage record. An owner reading the file cannot tell that any of it is missing. |
| Uploaded files are referenced by id. | The bytes are not in the export. A knowledge base full of PDFs exports as a list of filenames. |
| The shape is a versioned interface in the codebase. | Nothing user-facing documents it. There is no manifest, no checksum, no field reference. "Structured data you can keep" is only true if you can read it without our source tree. |
| The export leaves no trace. | There is no way to answer "when did I last take a backup?" — which is the only version of this question anyone actually asks. |
| Some data must never leave (credentials) and some must never be re-imported (money, machine identity). | That is correct, and it is invisible. The file quietly omits things, and the import quietly refuses things, and nobody is told either way. |

**The costs of the gap, all of them ours.**

| Gap | What it costs |
| --- | --- |
| No credible exit | "Can I get my data out?" is a procurement question and a trust question. A partial JSON with no documentation is a worse answer than a plain "no", because it looks like a yes until someone checks. |
| No pre-flight before destructive work | The Danger zone already renders an export button next to account deletion. That button hands you an incomplete file. The one moment we most need the backup to be complete is the moment it is least likely to be. |
| No incident story | When an agent does something regrettable at scale, the first question is "what did it look like before?". Nothing today can answer that. |
| Support cannot verify | "Did your export include your knowledge base?" has no answer that does not involve reading our code. |
| Self-hosted operators are stuck | An operator moving between their own deployments has database dumps, but no supported, documented, per-workspace artefact. |

**Why now, and why it is small.** The pieces exist: a working exporter for the largest domain
(Works and their content), a pluggable storage backend that already stores user files, a
job-runtime layer that already runs every other long job, an import path with conflict
resolution, and a settings page with a home for the control. This epic is mostly **completeness
and evidence**: widen the coverage to every domain, move the work off the request path, write
the manifest, publish the format, and keep a record.

## 3. User scenarios

### 3.1 Happy paths

**S-1 · Take a backup and get the file.**
**Given** an owner on `/settings/data` who has never taken a backup,
**When** they press **Create backup**,
**Then** within one second the card switches to a running state showing "Preparing your backup"
with a progress bar and the domain currently being written ("Knowledge and memory · 7 of 15"),
**and** they may navigate away, close the tab, and come back,
**and** when the archive is finished an in-app notification says "Your workspace backup is
ready", the card shows the archive with its date, size and coverage summary, and a **Download**
button saves a single `.zip` to their machine.

**S-2 · Read the archive without us.**
**Given** a downloaded archive,
**When** the user unzips it,
**Then** the top level contains `manifest.json`, `README.md`, a `data/` tree of newline-delimited
JSON files grouped by domain, a `files/` tree with the actual bytes of every uploaded document
and attachment that fit the limits, and `checksums.txt`,
**and** `README.md` explains in plain language what each folder is, what the format version
means, which parts can be restored and which are a record only,
**and** every count in `manifest.json` matches the number of lines in the file it describes.

**S-3 · See what a restore would do, before it does it.**
**Given** an owner holding an archive from another workspace or an earlier date,
**When** they open **Check a backup** and drop in the archive's `manifest.json`,
**Then** a report appears listing every domain with one of three outcomes — *restored*,
*record only*, *not in this archive* — with row counts, without writing anything,
**and** the report names the exact items that will need a human afterwards (every connection
whose credential was never exported, every schedule that will resume, every node that must be
re-enrolled).

**S-4 · Restore what can be restored.**
**Given** the report from S-3 against an empty workspace,
**When** the owner continues into restore and confirms,
**Then** the domains marked *restored* are recreated, conflicts are resolved with the same
skip / overwrite / rename choices the existing import offers,
**and** the result screen lists what landed, what was skipped and why, and links to the first
thing that needs a credential re-entered.

**S-5 · Back up before something irreversible.**
**Given** an owner on the Danger zone page,
**When** the page loads,
**Then** a banner states when the last backup completed ("Last backup: 2 days ago, 412 MB") or
that there has never been one, with a **Create backup** link,
**and** the banner is present whether or not the destructive control below it is enabled.

**S-6 · Check history.**
**Given** an owner who has taken several backups,
**When** they open the backup card,
**Then** the most recent ready archive is shown expanded, and below it a list of up to 20 past
backups with date, size, coverage, and either a Download button or an "Expired" label with the
date it was removed.

**S-7 · Full history when it matters.**
**Given** an owner preparing to leave the platform,
**When** they open the options disclosure and tick **Include full history**,
**Then** the run logs, activity, notifications and delivery logs that are normally trimmed to
their recent windows are included up to three years back,
**and** the card warns that this backup will be larger and slower before they confirm,
**and** the manifest records that the caps were lifted.

**S-8 · A second person cannot silently take the data.**
**Given** an organization with several members,
**When** a member who is not the workspace owner opens `/settings/data`,
**Then** the backup card is visible and explains that only the workspace owner can create or
download a backup, and both controls are disabled with that reason attached to them.

### 3.2 Unhappy paths, races, permissions and empty states

**S-9 · Two tabs, one button.**
**Given** a backup already running,
**When** the owner presses **Create backup** in a second tab,
**Then** no second backup starts; the second tab adopts the running one and shows the same
progress, with the message "A backup is already running — showing that one".

**S-10 · Too many in a day.**
**Given** three backups already completed in the last 24 hours,
**When** the owner presses **Create backup**,
**Then** the request is refused with "You can create 3 backups a day. The next one is available
at 18:40." and the button is disabled until that time, shown as a live countdown under an hour.

**S-11 · The archive gets too big.**
**Given** a workspace whose uploaded files exceed the attachment budget,
**When** the backup runs,
**Then** it still completes,
**and** the card shows "Ready — some files were left out",
**and** `manifest.json` lists every omitted file with its id, name, size and the reason
`size_limit`, so the owner can fetch those individually,
**and** the structured data is complete regardless.

**S-12 · The archive cannot be built at all.**
**Given** structured data alone that exceeds the hard archive ceiling,
**When** the backup runs,
**Then** it fails with a specific, non-generic message — "This workspace is larger than a single
backup file can hold. Contact support and we will produce it in parts." — and the failure is
recorded in the history list with that reason.

**S-13 · One domain fails, the rest do not.**
**Given** a transient database error while writing one domain,
**When** the backup runs,
**Then** that domain is retried twice; if it still fails the archive completes with the other
fourteen domains,
**and** the card shows "Ready — 1 section incomplete", the manifest marks that domain
`status: failed` with an error code, and the coverage summary shows 14 of 15,
**and** the notification says which section is missing.

**S-14 · The worker dies mid-way.**
**Given** a backup that stops reporting progress,
**When** ten minutes pass with no heartbeat,
**Then** the record moves to failed with reason `stalled`, any partial archive is deleted, the
card offers **Try again**, and the daily allowance is not charged for the failed attempt.

**S-15 · The download link has gone stale.**
**Given** a download page left open for an hour,
**When** the owner presses **Download**,
**Then** the client silently mints a fresh link and the download starts; the user sees nothing
unusual.

**S-16 · The archive has expired.**
**Given** an archive older than the retention window,
**When** the owner opens the history,
**Then** its row reads "Expired 3 Sep — archives are kept for 14 days" with no Download button,
and the row itself remains as evidence that a backup was taken that day.

**S-17 · Nothing to back up.**
**Given** a brand-new workspace with no Works, agents or documents,
**When** the owner presses **Create backup**,
**Then** a backup is still produced — profile, preferences and an empty manifest — and the card
says "Ready — your workspace is nearly empty. This backup mostly records your settings."

**S-18 · The archive is not ours.**
**Given** a manifest from an unrelated product, or a corrupted file,
**When** the owner drops it into **Check a backup**,
**Then** the check refuses with "This does not look like an Ever Works backup manifest" and
names the two fields it looked for, without a stack trace and without uploading further data.

**S-19 · The archive is from a newer build.**
**Given** a manifest whose format version is higher than the running build supports,
**When** the owner checks it,
**Then** the report is still produced for every domain the build recognises, unrecognised
domains are listed as "not supported by this version", and restore is refused with an explicit
"this backup was made by a newer version of Ever Works" rather than partially applied.

**S-20 · The archive is from an older build.**
**Given** a manifest one or more format versions behind,
**When** the owner checks it,
**Then** it is accepted, the report notes which domains did not exist when it was taken, and
restore proceeds for everything present.

**S-21 · Restore into a workspace that already has things.**
**Given** a non-empty workspace,
**When** the owner restores,
**Then** the conflict step lists every colliding item by name with skip / overwrite / rename,
defaulting to skip,
**and** nothing outside the restorable domains is touched, and no existing run, decision or
activity record is altered.

**S-22 · Someone tries to restore money or machines.**
**Given** an archive containing the billing and usage record and the node inventory,
**When** it is restored,
**Then** those domains are reported as *record only* and are not written, with the reason stated
in the result screen: balances are earned in one account and cannot be minted by importing a
file; nodes are physical machines that must enrol themselves.

**S-23 · Storage is unavailable.**
**Given** the configured storage backend is down when the archive is finalised,
**When** the backup runs,
**Then** it retries three times with backoff, then fails with reason `storage_unavailable` and a
message that names the operator action, not the user's — "We could not store your backup. This
is on our side; try again shortly." — and the attempt is not charged against the daily
allowance.

**S-24 · The owner deletes an archive early.**
**Given** a ready archive the owner would rather not leave sitting on our storage,
**When** they press **Delete now** and confirm,
**Then** the bytes are deleted immediately, the row remains with status `deleted` and the date,
and the confirmation dialogue states that this cannot be undone and the archive cannot be
regenerated identically.

**S-25 · Loading the card.**
**Given** a slow first paint of `/settings/data`,
**When** the backup card is still fetching,
**Then** it renders a skeleton with the heading and a placeholder row, never a false "no
backups yet" empty state, and never a Create button that would double-submit.

**S-26 · The backup service is not configured.**
**Given** a deployment with no storage backend configured for archives,
**When** the owner opens the card,
**Then** it explains that backups are unavailable in this deployment and points at the JSON
export below, rather than offering a button that always fails.

## 4. Functional requirements

Every number below is a default; where a deployment may change it, the requirement says so.

### 4.1 Producing a backup

- **FR-1** A single control on **Settings → Data** starts a backup with no required options. The
  default backup includes every domain in §4.3 at the standard history windows in FR-14.
- **FR-2** A backup request returns within **1 second** and never carries the archive in its
  response. The archive is produced by background work.
- **FR-3** At most **1 backup per workspace may be running at a time**. A request while one is
  running returns the running backup rather than starting a second (S-9).
- **FR-4** At most **3 backups per workspace may reach a ready state per rolling 24 hours**. A
  fourth request is refused and states the time the window reopens (S-10). Failed and cancelled
  attempts do not count against the allowance (S-14, S-23).
- **FR-5** A running backup reports progress at least every **30 seconds** as: percent complete,
  the domain being written, and domains completed out of the total. A backup that has not
  reported for **10 minutes** is marked failed with reason `stalled` and its partial archive is
  deleted (S-14).
- **FR-6** A backup that has not completed within **60 minutes** is stopped and marked failed
  with reason `timeout`.
- **FR-7** A single option, **Include full history**, is available behind a disclosure. It lifts
  the trimming windows in FR-14 to a ceiling of **1095 days**. It does not change the per-file or
  archive size limits, and it never adds a domain that would otherwise be excluded.
- **FR-8** A backup may be cancelled while running. Cancellation deletes any partial archive
  within **60 seconds** and does not count against the daily allowance.

### 4.2 Permission and scope

- **FR-9** A backup covers exactly **one workspace scope**: either an Organization, or the
  owner's un-organized scope. It never mixes two, and it never includes rows belonging to another
  workspace.
- **FR-10** Only the **workspace owner** may create, download, check, restore or delete a backup.
  Other members see the card with both controls disabled and the reason attached (S-8).
- **FR-11** Every archive records, in its manifest, the workspace it came from (display name,
  slug, opaque id) and the account that produced it (display name and email), so an archive found
  on a disk years later identifies itself.
- **FR-12** Downloading requires a freshly minted, **15-minute**, single-workspace link. Links
  are not guessable, are not reusable across accounts, and are re-minted transparently by the
  client when stale (S-15).

### 4.3 Coverage — what is in the archive

- **FR-13** The archive covers **fifteen domains**. Each is present in the manifest with a status
  of `complete`, `trimmed`, `partial`, `failed` or `empty` — never absent, so a reader can always
  distinguish "you have none of these" from "we did not export these".

| # | Domain | What it holds | Restorable? |
| --- | --- | --- | --- |
| D1 | Account and profile | Display name, email, avatar reference, onboarding answers, notification and privacy preferences, terms-acceptance records, API key names and prefixes (never the keys) | Yes, except key material |
| D2 | Organizations and teams | The workspace descriptor, its vision, members and their roles, pending invitations, teams, team members and team resources, org notification defaults | Yes |
| D3 | Agents and skills | Agents with their instructions, personality and configuration files, memberships, collaborator allow-lists, budgets, repository and connection attachments, email assignments, tool grants, skills, skill bindings, skill companion files | Yes |
| D4 | Missions, goals and ideas | Missions and their links to goals and Works, goals with criteria and definition of done, goal event logs and metric samples, ideas with their reasoning and outcome | Yes |
| D5 | Tasks and workflows | Tasks with status, priority, labels, hierarchy, dependencies, assignees, approvers, reviewers, watchers, task chat, task attachments, knowledge mentions, review rejections, task templates and their steps, saved workflow graphs | Yes |
| D6 | Works and their content | Work settings, members, custom domains, advanced prompts, plugin bindings, budgets, deployment history, generation history, plus a snapshot of each Work's items, categories, tags, collections and comparisons and its `works.yml` | Yes |
| D7 | Knowledge and memory | Knowledge documents with full body text, tags, classes, lock state and provenance, memory folders, the source uploads behind documents, other uploaded files, and the retrieval trail | Yes |
| D8 | Schedules and triggers | Work schedules, inbound trigger definitions (without their signing secrets), recent trigger fires | Yes, secrets regenerated |
| D9 | Runs and receipts | Agent runs with status, duration, cost, token totals and summary; run logs; terminal transcripts; autonomous build runs and their logs; workflow runs; per-call plugin usage events | Record only |
| D10 | Decisions | Escalations, proposed actions awaiting approval, and the operator inbox with its questions and answers | Record only |
| D11 | Communication | Email addresses (provider settings redacted), email conversations and messages, notifications, notification channels (endpoints redacted), delivery logs, notification preferences, meetings | Partly — preferences and addresses yes, message history record only |
| D12 | Connections and environments | Installed plugins and their non-secret settings, the names of every secret field that was set, connections to external servers, repository registrations, environments, code-host installation references, outbound webhook subscriptions (without secrets), ingest bindings and cursors, external issue links | Yes, credentials re-entered |
| D13 | Fleet | Node inventory — name, kind, platform, capabilities, last-seen — plus execution preferences and agent-to-node pinning, and recent job records | Record only; preferences yes |
| D14 | Billing and usage record | Current plan and subscription status, invoices with their provider-hosted links, the credit ledger, the metered usage ledger, licence purchases | Record only |
| D15 | Activity | The unified activity history | Record only |

- **FR-14** History-shaped domains are trimmed by default to bounded windows, and every trim is
  recorded in the manifest with its cutoff date and the number of rows omitted:

| Data | Default window | With **Include full history** |
| --- | --- | --- |
| Activity history | 365 days | 1095 days |
| Agent run logs | 90 days | 1095 days |
| Terminal transcripts | 30 days | 365 days |
| Notifications | 180 days | 1095 days |
| Plugin usage events | 180 days | 1095 days |
| Delivery logs (channels and webhooks) | 30 days | 365 days |
| Trigger fires | 90 days | 1095 days |
| Retrieval trail | 30 days | 365 days |
| Fleet job records | 30 days | 365 days |

  Everything not in this table is exported in full regardless of age.

- **FR-15** Uploaded file bytes are included up to **200 MiB per file** and **2 GiB in total per
  archive**. Files past either limit are listed in the manifest with `reason: size_limit` and are
  still described by their metadata row (S-11).
- **FR-16** The finished archive may not exceed **5 GiB**. A backup whose structured data alone
  would exceed it fails with reason `too_large` and a message naming the support path (S-12).
- **FR-17** A domain that fails after **2 retries** does not fail the backup. The archive
  completes, the domain is marked `failed` with an error code, and the coverage summary shows the
  shortfall (S-13).

### 4.4 Never in the archive

- **FR-18** The following never appear, in any form, at any option setting, and the manifest says
  so explicitly rather than omitting them silently:
  1. Password hashes, password-reset tokens, magic-link tokens and email-verification tokens.
  2. Sessions, refresh tokens and third-party auth provider access or refresh tokens.
  3. API key material. Keys appear as name, prefix, created date and active flag only.
  4. Any stored credential, in plaintext or ciphertext — plugin secrets, connection headers,
     deployment secrets, webhook signing secrets, trigger signing secrets, encrypted runtime
     credentials and their snapshots. Only the **names** of the fields that were set are exported.
  5. Node enrolment and heartbeat secrets.
  6. Payment-provider customer, subscription, payment-method and meter identifiers.
  7. The platform-administrator flag.
  8. Vector embeddings and their coordinates, because they are derived and regenerate on demand.
  9. Internal caches and the delivery outbox.
- **FR-19** The archive is not encrypted by Ever Works and the interface says so in one sentence
  where the download happens: "This file is not encrypted. It contains your workspace's content,
  though never your passwords, API keys or connection credentials."

### 4.5 The archive's shape

- **FR-20** The archive is a single `.zip` named
  `everworks-backup-<workspace-slug>-<YYYY-MM-DD>-<short-id>.zip`.
- **FR-21** Its top level is exactly: `manifest.json`, `README.md`, `checksums.txt`, `data/`,
  `files/`.
- **FR-22** `data/` holds one directory per domain and one **newline-delimited JSON** file per
  record type. Each line is one complete record. Files are UTF-8, LF-terminated, and sorted by
  creation time ascending so two backups of unchanged data differ only in their timestamps.
- **FR-23** `files/` holds included file bytes at `files/<id>/<original-filename>`, and every
  metadata row that has bytes carries the archive-relative path to them.
- **FR-24** `manifest.json` carries, at minimum: format version; the Ever Works build that
  produced it; produced-at timestamp; workspace and account identity (FR-11); the options used;
  per-domain status, record counts, byte counts, file counts, trim cutoffs and error codes; the
  omissions list (FR-15); the explicit exclusions list (FR-18); and the restorability class of
  every domain.
- **FR-25** `checksums.txt` lists a SHA-256 for every file in the archive except itself, in a
  format standard command-line tools can verify.
- **FR-26** `README.md` is plain language, under 400 words, and states: what this is, when it was
  taken, what the folders hold, what is deliberately absent, what can be restored, how long the
  copy on our servers lasts, and where the field reference lives.
- **FR-27** The format is **versioned**. A build reads any archive at or below its own format
  version (S-20) and refuses to restore a higher one while still describing it (S-19). Adding a
  domain or a field is a minor version and never breaks an older reader; removing or repurposing
  either is a major version.

### 4.6 Retention and the record

- **FR-28** A ready archive is kept for **14 days** and then deleted. The window is deployment-
  configurable; the interface always states the value in force.
- **FR-29** The **record** of a backup — date, options, coverage summary, size, outcome — is kept
  for **90 days** after the archive is deleted, so history remains legible (S-16).
- **FR-30** The history list shows the most recent **20** records.
- **FR-31** An owner may delete a ready archive immediately. The record survives with status
  `deleted` (S-24).
- **FR-32** Creating, downloading, deleting and restoring are each recorded in the workspace's
  activity history with the actor, the backup's id and the outcome.
- **FR-33** Completion, failure and "ready with omissions" each raise exactly one in-app
  notification. No more than one notification is raised per backup.

### 4.7 Checking and restoring

- **FR-34** **Check a backup** accepts a `manifest.json` of up to **8 MiB** and produces a report
  without writing anything and without requiring the full archive to be uploaded.
- **FR-35** The report classifies every domain as **restored**, **record only** or **not in this
  archive**, with row counts, and lists the follow-up actions a restore will leave behind —
  credentials to re-enter, nodes to re-enrol, schedules that will resume.
- **FR-36** Restore writes only domains classified restorable in FR-13. It never writes D9, D10,
  D13's inventory, D14 or D15, and it says so in the result (S-22).
- **FR-37** Restore surfaces every collision by name before writing, defaulting to **skip**, with
  overwrite and rename available per item (S-21).
- **FR-38** Restore is **all-or-nothing per domain**: a domain either applies fully or is rolled
  back and reported as failed. It never leaves half a domain behind.
- **FR-39** After a restore, everything that resumed work — schedules, triggers, agent heartbeats
  — is created **paused**, and the result screen lists what must be resumed deliberately.
- **FR-40** Restore never re-creates a credential. Every connection that needs one is created in
  a `needs credential` state and is listed in the result with a direct link.

### 4.8 Interface behaviour, accessibility and limits

- **FR-41** The card polls a running backup every **5 seconds** for the first 5 minutes and every
  **15 seconds** thereafter, and stops polling when the tab is hidden.
- **FR-42** Progress is announced to assistive technology at most once every **30 seconds**, via a
  polite live region, as "Backup 40 percent complete, writing Knowledge and memory".
- **FR-43** Every state of the card — loading, none yet, running, ready, ready with omissions,
  section incomplete, failed, expired, rate-limited, unavailable, no permission — has explicit
  copy (§6.9) and none is a generic error.
- **FR-44** The card is fully operable by keyboard, all controls are real buttons with visible
  focus, and the destructive **Delete now** requires a second confirmation.
- **FR-45** Every user-visible string is a translatable message key. No string is assembled from
  fragments in a way that cannot be re-ordered by a translator.

### 4.9 Deployment posture

- **FR-46** Where no storage backend is configured for archives, the card renders an explanatory
  unavailable state and never a failing button (S-26).
- **FR-47** Retention, the daily allowance, the size limits and the trim windows are all
  operator-configurable, and the interface reads the values in force rather than repeating
  hard-coded numbers.

## 5. Key entities

### 5.1 New

**Workspace backup** — one record of one attempt to produce an archive.

*Why a new noun is required.* The existing export is stateless: it computes a payload and
returns it. Nothing today can answer "when was the last backup", "is one running", "how big was
it", "what was left out" or "has it expired" — and FR-3, FR-4, FR-5, FR-28 to FR-33 all require
those answers to be durable. No existing noun carries them: a Run is one agent's execution, an
Activity entry is a past-tense fact with no lifecycle, and a Task is delegated work with an
assignee. This is a job record with an artefact attached, and it is the only new noun in the
epic. It is added to the program vocabulary table in the same change.

States and transitions:

```
                            (owner presses Create backup)
                                        │
                                        ▼
                                   ┌─────────┐
              ┌───── cancel ───────│ queued  │
              │                    └────┬────┘
              │                         │ worker picks it up
              │                         ▼
              │                    ┌─────────┐   heartbeat every 30s
              │◄──── cancel ───────│ running │◄──────────────────┐
              │                    └────┬────┘                   │
              │        ┌────────────────┼───────────────┐        │
              │        │                │               │        │
              ▼        ▼                ▼               ▼        │
        ┌───────────┐ ┌────────┐  ┌───────────┐  ┌──────────────┴──┐
        │ cancelled │ │ failed │  │   ready   │  │ ready_with_gaps │
        └───────────┘ └────────┘  └─────┬─────┘  └────────┬────────┘
                                        │                 │
                        14 days, or owner presses Delete now
                                        │                 │
                                        ▼                 ▼
                                   ┌─────────┐      ┌──────────┐
                                   │ expired │      │ deleted  │
                                   └─────────┘      └──────────┘
                                   (record kept 90 days, then removed)
```

| Attribute | Meaning |
| --- | --- |
| Workspace and owner | Which scope it covers and who asked for it (FR-9, FR-11) |
| Requested at, started at, finished at | The lifecycle timestamps behind history and stall detection |
| Status | One of the nine states above |
| Failure reason | `stalled`, `timeout`, `too_large`, `storage_unavailable`, `cancelled_by_user`, `internal` |
| Options | Whether full history was requested; the format version targeted |
| Progress | Percent, current domain, domains completed, last heartbeat |
| Manifest summary | Per-domain status and counts, omissions, trims — the same content as the archive's manifest, so history stays legible after the archive is gone |
| Artefact | Storage location, size in bytes, SHA-256, expiry date |

**Backup manifest** — the description of one archive. It is not a database entity in its own
right: it exists as a file inside the archive and as a stored summary on the backup record. It
is named here because it is the contract the format publishes.

### 5.2 Existing, and how this epic touches them

| Entity | How this epic touches it |
| --- | --- |
| Every entity in the fifteen domains of FR-13 | **Read only.** The backup never writes them. A restore writes only the restorable subset, through the existing import paths where they exist. |
| Uploads and knowledge uploads | Read, plus their bytes are copied into the archive through the same storage abstraction that stores them. |
| Activity history | One entry per backup created, downloaded, deleted and restored (FR-32). |
| Notifications | One notification per finished backup (FR-33). |
| Organization / workspace scope | Selects the rows and appears in the manifest. Unchanged. |
| The existing JSON export, import preview/apply and config-repo sync | **Untouched.** They remain on the same page, with the same behaviour, for the narrower job they already do well. §7 explains why both exist. |

## 6. UX

All surfaces live on the existing **Settings → Data** page, above the export/import/sync cards
that ship today, plus one banner on the Danger zone page.

### 6.1 Card — loading

```
┌───────────────────────────────────────────────────────────────────────┐
│  ▣  Workspace backup                                                  │
│     A complete copy of everything in this workspace.                  │
│                                                                       │
│     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (skeleton)      │
│     ░░░░░░░░░░░░░░░░░░░                                               │
└───────────────────────────────────────────────────────────────────────┘
```

No Create button is rendered until the state is known — a button that might double-submit is
worse than a moment of nothing (FR-43, S-25).

### 6.2 Card — no backup yet

```
┌───────────────────────────────────────────────────────────────────────┐
│  ▣  Workspace backup                                                  │
│     A complete copy of everything in this workspace.                  │
│                                                                       │
│     You have not taken a backup yet.                                  │
│                                                                       │
│     [ Create backup ]   ▸ Options        Check a backup               │
│                                                                       │
│     Backups cover all 15 sections of your workspace. Archives are     │
│     kept for 14 days. This file is not encrypted — it never           │
│     contains your passwords, API keys or connection credentials.      │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.3 Card — options open

```
│     [ Create backup ]   ▾ Options        Check a backup               │
│     ┌───────────────────────────────────────────────────────────┐     │
│     │ ☐ Include full history                                    │     │
│     │   Keeps up to three years of runs, logs, activity and     │     │
│     │   notifications instead of the usual recent window.       │     │
│     │   Larger file, slower to build.                           │     │
│     └───────────────────────────────────────────────────────────┘     │
```

### 6.4 Card — running

```
┌───────────────────────────────────────────────────────────────────────┐
│  ▣  Workspace backup                                       [ Cancel ] │
│                                                                       │
│     Preparing your backup…                                            │
│     ████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░  40%              │
│     Knowledge and memory · section 7 of 15 · started 2 min ago        │
│                                                                       │
│     You can leave this page. We will let you know when it is ready.   │
└───────────────────────────────────────────────────────────────────────┘
```

The percentage and section name are inside a polite live region announced at most every 30
seconds (FR-42).

### 6.5 Card — ready

```
┌───────────────────────────────────────────────────────────────────────┐
│  ▣  Workspace backup                                                  │
│                                                                       │
│     ┌───────────────────────────────────────────────────────────────┐ │
│     │ ✓  6 September 2026, 14:12          412 MB   all 15 sections  │ │
│     │    everworks-backup-acme-2026-09-06-7fa39c.zip                │ │
│     │    Available until 20 September                               │ │
│     │                                                               │ │
│     │    [ Download ]   What's inside ▸        Delete now            │ │
│     └───────────────────────────────────────────────────────────────┘ │
│                                                                       │
│     [ Create backup ]   ▸ Options        Check a backup               │
│                                                                       │
│     Earlier backups                                                   │
│     ─────────────────────────────────────────────────────────────────  │
│     30 Aug 2026, 09:02   408 MB   all 15 sections    [ Download ]     │
│     23 Aug 2026, 09:00   396 MB   all 15 sections    Expired 6 Sep    │
│     16 Aug 2026, 09:01   —        Failed: timed out                   │
│                                                     Show all (20) ▸   │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.6 Card — ready with omissions / a section incomplete

```
│     ┌───────────────────────────────────────────────────────────────┐ │
│     │ ⚠  6 September 2026, 14:12          2.1 GB   14 of 15 sections│ │
│     │    Ready — some things were left out                          │ │
│     │    • Runs and receipts could not be written (error RUN-503)   │ │
│     │    • 37 files were larger than the 200 MB limit               │ │
│     │    Everything else is complete. See What's inside for the      │ │
│     │    full list.                                                 │ │
│     │                                                               │ │
│     │    [ Download ]   What's inside ▸        Delete now            │ │
│     └───────────────────────────────────────────────────────────────┘ │
```

### 6.7 "What's inside" — the coverage drawer

Opened from the ready row; closes on `Esc`; focus returns to the trigger.

```
┌── What's inside this backup ──────────────────────────────────  [ × ] ┐
│  everworks-backup-acme-2026-09-06-7fa39c.zip · format 1.0 · 412 MB    │
│                                                                       │
│  SECTION                        RECORDS   STATUS      RESTORABLE      │
│  ────────────────────────────────────────────────────────────────────  │
│  Account and profile                 12   Complete    Yes             │
│  Organizations and teams             48   Complete    Yes             │
│  Agents and skills                  310   Complete    Yes             │
│  Missions, goals and ideas          204   Complete    Yes             │
│  Tasks and workflows              3 918   Complete    Yes             │
│  Works and their content         41 260   Complete    Yes             │
│  Knowledge and memory             2 704   Complete    Yes             │
│  Schedules and triggers              37   Complete    Yes             │
│  Runs and receipts               18 442   Trimmed     Record only     │
│    └ logs older than 8 Jun omitted (4 118 rows)                       │
│  Decisions                          611   Complete    Record only     │
│  Communication                    1 802   Trimmed     Partly          │
│  Connections and environments        94   Complete    Yes             │
│  Fleet                               22   Complete    Record only     │
│  Billing and usage record         5 006   Complete    Record only     │
│  Activity                        22 118   Trimmed     Record only     │
│  ────────────────────────────────────────────────────────────────────  │
│  Files included: 1 249 (1.7 GB) · 37 omitted for size                 │
│                                                                       │
│  Never included: passwords, session and API keys, every connection    │
│  credential, node enrolment secrets, payment identifiers.             │
│  Field reference: Backup format →                                     │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.8 Card — rate-limited, unavailable, no permission

```
   Rate-limited
   ┌───────────────────────────────────────────────────────────────────┐
   │  [ Create backup ]  (disabled)                                    │
   │  You can create 3 backups a day. The next one is available at     │
   │  18:40 — in 47 minutes.                                           │
   └───────────────────────────────────────────────────────────────────┘

   Not available in this deployment
   ┌───────────────────────────────────────────────────────────────────┐
   │  ▣  Workspace backup                                              │
   │  Backups are not available in this deployment because no file     │
   │  storage is configured. You can still use Export data below.      │
   └───────────────────────────────────────────────────────────────────┘

   Not the workspace owner
   ┌───────────────────────────────────────────────────────────────────┐
   │  [ Create backup ]  (disabled)   [ Download ]  (disabled)         │
   │  Only the workspace owner can create or download a backup.        │
   └───────────────────────────────────────────────────────────────────┘
```

### 6.9 Check a backup — the three states

```
   Empty
   ┌── Check a backup ────────────────────────────────────────  [ × ] ┐
   │                                                                  │
   │      ┌────────────────────────────────────────────────────┐      │
   │      │   Drop manifest.json here, or choose a file        │      │
   │      │              [ Choose file ]                       │      │
   │      └────────────────────────────────────────────────────┘      │
   │  We only read the manifest. Your archive stays on your machine.  │
   └──────────────────────────────────────────────────────────────────┘

   Report
   ┌── Check a backup ────────────────────────────────────────  [ × ] ┐
   │  Backup of “Acme” taken 6 September 2026 · format 1.0            │
   │                                                                  │
   │  Would be restored             10 sections   48 632 records      │
   │  Kept as a record only          5 sections   46 179 records      │
   │  Not in this archive            0 sections                       │
   │                                                                  │
   │  After restoring you would still need to:                        │
   │   • Re-enter credentials for 6 connections                       │
   │   • Re-enrol 2 computers                                         │
   │   • Resume 4 schedules and 3 triggers (restored paused)          │
   │                                                                  │
   │  Nothing has been changed yet.                                   │
   │              [ Cancel ]        [ Continue to restore ]           │
   └──────────────────────────────────────────────────────────────────┘

   Refused
   ┌── Check a backup ────────────────────────────────────────  [ × ] ┐
   │  ✕ This does not look like an Ever Works backup manifest.        │
   │    We looked for “everworksBackupFormat” and “producedAt” and    │
   │    found neither. Nothing was uploaded beyond this file.         │
   │                                       [ Try another file ]       │
   └──────────────────────────────────────────────────────────────────┘
```

### 6.10 Danger zone banner

```
┌───────────────────────────────────────────────────────────────────────┐
│  ⓘ  Last backup: 2 days ago · 412 MB · all 15 sections                │
│     Anything below is permanent. Take a backup first.                 │
│                                                    Create backup →    │
└───────────────────────────────────────────────────────────────────────┘
```

When there has never been one: "You have never taken a backup of this workspace. Anything below
is permanent."

### 6.11 Exact user-visible copy

| Where | Copy |
| --- | --- |
| Card heading | Workspace backup |
| Card subtitle | A complete copy of everything in this workspace. |
| Primary button | Create backup |
| Button, running | Preparing… |
| Options toggle | Options |
| Full-history option | Include full history |
| Full-history help | Keeps up to three years of runs, logs, activity and notifications instead of the usual recent window. Larger file, slower to build. |
| Empty state | You have not taken a backup yet. |
| Nearly-empty result | Ready — your workspace is nearly empty. This backup mostly records your settings. |
| Running headline | Preparing your backup… |
| Running detail | {section} · section {done} of {total} · started {relativeTime} |
| Running reassurance | You can leave this page. We will let you know when it is ready. |
| Ready summary | {date} · {size} · all {total} sections |
| Partial summary | {date} · {size} · {done} of {total} sections |
| Partial headline | Ready — some things were left out |
| Availability | Available until {date} |
| Expired row | Expired {date} — archives are kept for {days} days |
| Download | Download |
| Coverage link | What's inside |
| Delete | Delete now |
| Delete confirmation title | Delete this backup? |
| Delete confirmation body | The file will be removed from our servers straight away and cannot be recovered. The record of this backup stays in your history. |
| Cancel running | Cancel |
| Encryption notice | This file is not encrypted. It contains your workspace's content, though never your passwords, API keys or connection credentials. |
| Retention notice | Backups cover all {total} sections of your workspace. Archives are kept for {days} days. |
| Rate limited | You can create {limit} backups a day. The next one is available at {time}. |
| Already running | A backup is already running — showing that one. |
| Unavailable | Backups are not available in this deployment because no file storage is configured. You can still use Export data below. |
| Not owner | Only the workspace owner can create or download a backup. |
| Failure, stalled | That backup stopped responding and was cancelled. Nothing was saved. Try again. |
| Failure, timeout | That backup took longer than an hour and was stopped. Try again, or turn off Include full history. |
| Failure, too large | This workspace is larger than a single backup file can hold. Contact support and we will produce it in parts. |
| Failure, storage | We could not store your backup. This is on our side; try again shortly. |
| Notification, ready | Your workspace backup is ready |
| Notification, partial | Your workspace backup is ready, with {n} things left out |
| Notification, failed | Your workspace backup did not finish |
| Check heading | Check a backup |
| Check dropzone | Drop manifest.json here, or choose a file |
| Check privacy note | We only read the manifest. Your archive stays on your machine. |
| Check refusal | This does not look like an Ever Works backup manifest. We looked for “everworksBackupFormat” and “producedAt” and found neither. Nothing was uploaded beyond this file. |
| Check, newer format | This backup was made by a newer version of Ever Works. We can describe it, but not restore it. |
| Restore reassurance | Nothing has been changed yet. |
| Restore result, paused | Schedules, triggers and heartbeats were restored paused. Resume the ones you want. |
| Restore result, credentials | {n} connections need their credentials re-entered before they will work. |
| Danger banner, has backup | Last backup: {relativeTime} · {size} · all {total} sections. Anything below is permanent. Take a backup first. |
| Danger banner, none | You have never taken a backup of this workspace. Anything below is permanent. |

### 6.12 Keyboard affordances

| Key | Behaviour |
| --- | --- |
| `Tab` / `Shift+Tab` | Moves through Create backup → Options → Check a backup → the ready row's Download → What's inside → Delete now → each history row's action, in visual order. |
| `Enter` / `Space` | Activates the focused control. |
| `Esc` | Closes the coverage drawer, the check panel or the delete confirmation, returning focus to the control that opened it. |
| `Enter` on a history row | Opens that backup's coverage drawer. |
| Arrow keys | Move between history rows when the list has focus. |
| Focus after action | Pressing Create backup moves focus to the running region so the state change is announced; when a backup finishes, focus is not stolen — the live region announces it and the Download button becomes the next tab stop. |
| Confirmation dialogues | Trap focus, open on the cancelling action, and are dismissible with `Esc`. |

## 7. Out of scope

1. **Replacing the existing JSON export, import or config-repo sync.** They stay, unchanged, on
   the same page. They serve a different job — a small, hand-editable, diffable file for moving a
   couple of Works between environments. The backup archive is a complete artefact for keeping.
2. **Encrypting the archive, or a passphrase.** Named in §9 as an open question; not in this epic.
3. **Automatic scheduled backups.** Deliberately deferred to a later phase of this epic's plan and
   sequenced behind the manual path proving out.
4. **Sending the archive anywhere.** No email attachment, no push to a bucket the user owns, no
   third-party destination. Download only.
5. **Restoring into a different deployment as a supported migration.** The format is portable and
   nothing stops it, but supported cross-deployment migration, including identity re-mapping, is
   its own piece of work.
6. **Point-in-time or incremental backups.** Every archive is a full snapshot.
7. **Restoring history.** Runs, decisions, activity, usage and node inventory are exported and
   never re-written (FR-36). Making history restorable would mean fabricating a past that did not
   happen in the target workspace.
8. **Operator-level disaster recovery.** Database backups, replication and platform restore are
   an operations concern, not a per-workspace feature.
9. **Selective per-domain export.** The backup is whole-workspace by design; the only option is
   the history window. Narrowing it is what the existing export already does.
10. **Deleting the workspace.** The account-deletion control on the Danger zone is a separate,
    currently non-functional concern; this epic only adds the banner beside it.

## 8. Acceptance criteria

A reviewer can run this list against a deployed build.

**Producing**
- [ ] Pressing Create backup returns to an interactive page in under a second and never downloads
      anything directly (FR-2).
- [ ] Closing the tab during a backup and returning shows the same backup still running, then
      ready (S-1).
- [ ] A second Create press while one runs adopts the running backup and starts nothing new
      (FR-3, S-9).
- [ ] A fourth backup in 24 hours is refused with the reopening time and a disabled button
      (FR-4, S-10).
- [ ] A running backup can be cancelled; the partial archive disappears within a minute and the
      allowance is not charged (FR-8).
- [ ] Killing the worker mid-run results in a `stalled` record within 10 minutes, not a backup
      stuck at "running" forever (FR-5, S-14).

**Coverage**
- [ ] The manifest lists all 15 domains with a status, never fewer (FR-13).
- [ ] For a workspace seeded with at least one row in every domain, every domain reports a
      non-zero count and every count matches the line count of its file (FR-22, S-2).
- [ ] Uploaded file bytes are present under `files/` and every metadata row that has bytes points
      at them (FR-23).
- [ ] A file over 200 MiB is omitted, listed in the manifest with `size_limit`, and its metadata
      row is still present (FR-15, S-11).
- [ ] Forcing one domain to fail produces a complete archive with 14 of 15 sections and a named
      error code, not a failed backup (FR-17, S-13).
- [ ] Include full history widens the trimmed windows and the manifest records the change
      (FR-7, FR-14, S-7).

**Never included**
- [ ] Grepping the whole archive for a known plugin API key, a session token, a password hash, a
      node enrolment secret and a payment identifier returns nothing (FR-18).
- [ ] Fields that held a secret appear by **name** with no value, and the manifest's exclusions
      list names all nine categories (FR-18).

**Shape**
- [ ] The archive contains exactly `manifest.json`, `README.md`, `checksums.txt`, `data/`,
      `files/` at the top level (FR-21).
- [ ] Every `checksums.txt` entry verifies with a standard command-line tool (FR-25).
- [ ] Two backups taken minutes apart on unchanged data differ only in timestamps and identifiers
      (FR-22).
- [ ] `README.md` is under 400 words and states retention, exclusions and restorability (FR-26).

**Retention and record**
- [ ] A ready archive downloads; after the retention window it is gone and its row reads Expired
      with a date (FR-28, S-16).
- [ ] Delete now removes the bytes immediately and leaves the row (FR-31, S-24).
- [ ] Create, download, delete and restore each appear once in the activity history (FR-32).
- [ ] Exactly one notification is raised per finished backup (FR-33).
- [ ] The history list caps at 20 rows with a way to see the rest (FR-30).

**Permission and scope**
- [ ] A non-owner member sees both controls disabled with the reason (FR-10, S-8).
- [ ] A backup taken in one organization contains no row belonging to another (FR-9).
- [ ] A download link older than 15 minutes is transparently re-minted; a link from another
      account is refused (FR-12, S-15).

**Checking and restoring**
- [ ] A foreign or corrupt manifest is refused by name, not by stack trace (FR-34, S-18).
- [ ] A newer-format manifest is described but not restorable, with that exact reason (FR-27,
      S-19); an older one restores (S-20).
- [ ] The report is produced without writing anything, and the interface says so (FR-34, S-3).
- [ ] Restoring into a non-empty workspace shows every collision by name, defaulting to skip
      (FR-37, S-21).
- [ ] Restore writes none of D9, D10, D14, D15 or the node inventory, and says why (FR-36, S-22).
- [ ] Restored schedules, triggers and heartbeats are paused, and the result lists them (FR-39).
- [ ] Every connection needing a credential is created in a `needs credential` state and linked
      from the result (FR-40).

**Interface**
- [ ] Every state in §6 renders with the copy in §6.11 and no generic error text (FR-43).
- [ ] The whole card is operable by keyboard per §6.12, with visible focus and no traps (FR-44).
- [ ] Progress is announced politely at most every 30 seconds (FR-42).
- [ ] Every string comes from a message key; no locale shows a raw key (FR-45).
- [ ] With no storage configured, the card shows the unavailable state and no button (FR-46,
      S-26).
- [ ] The Danger zone banner shows the last backup or its absence (S-5).

## 9. Open questions

- **[NEEDS CLARIFICATION: passphrase]** Should the owner be able to supply a passphrase and get an
  encrypted archive? It moves a real risk (an archive left on a laptop) but adds an unrecoverable
  failure mode (a forgotten passphrase turns their only backup into noise) and a support burden.
  Proposal: ship unencrypted with the FR-19 notice, decide after we see how people store the file.
- **[NEEDS CLARIFICATION: organization roles]** FR-10 restricts backup to the workspace owner
  because organization membership currently carries exactly one role. When per-organization roles
  land, which of them may create a backup, and which may download one? These are different
  permissions — creating is cheap, downloading takes the whole workspace off the platform.
- **[NEEDS CLARIFICATION: attachment budget]** Is 2 GiB of file bytes the right ceiling? A
  knowledge-heavy workspace will exceed it and get an archive that is structurally complete but
  materially partial. The alternative — a separate, paged file export — is more machinery. What
  is the real distribution of upload volume per workspace?
- **[NEEDS CLARIFICATION: trim defaults]** Are the FR-14 windows right? 365 days of activity is a
  guess that trades archive size against the "what did it look like before" question.
- **[NEEDS CLARIFICATION: cross-deployment restore]** Restoring an archive into a *different*
  deployment works mechanically for the restorable domains but silently drops identity mapping
  (who authored what). Do we support it, warn about it, or refuse it?
- **[NEEDS CLARIFICATION: scheduled backups cadence]** When automatic backups land, what is the
  default — weekly, monthly, off? And how many automatic archives do we retain before the oldest
  is dropped, given they consume the same storage as manual ones?
- **[NEEDS CLARIFICATION: usage record and money]** D14 exports the credit ledger and invoices as
  a record. Is exporting a full financial ledger to an unencrypted file acceptable, or should it
  be behind its own explicit opt-in?
