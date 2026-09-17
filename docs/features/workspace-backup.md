---
id: workspace-backup
title: Workspace Backup (Complete Archive)
sidebar_label: Workspace Backup
sidebar_position: 12
---

# Workspace Backup

A workspace backup is a single dated `.zip` holding everything Ever Works stores on one
workspace's behalf, written next to a manifest that says exactly what is inside, what was
trimmed and why, and which parts a restore could put back.

It sits **beside** [Data Management](./data-management.md), which is unchanged and still the
right tool for a different job:

| Surface                                         | The question it answers                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Export / Import / GitHub Sync (Data Management) | "Give me a small, hand-editable, diffable file for moving a couple of Works." |
| Workspace backup (this page)                    | "Give me everything, with evidence of what everything means."                 |

Both remain available. Neither replaces the other.

:::info Scope
A backup covers exactly one workspace — the account plus the organization you had active when
you started it — and only the workspace owner can produce, download or delete one.
:::

## The archive

### Layout

```
manifest.json          # what this archive contains, section by section
README.md              # plain-language context for whoever opens it later
checksums.txt          # SHA-256 for every other file in the archive
data/                  # one folder per section, newline-delimited JSON
  account/
  organizations/
  agents/
  ...
  works/
    works.jsonl
    members.jsonl
    ...
    content/<work slug>/    # the Work's own content, read from its data repo
      items.jsonl
      categories.jsonl
      tags.jsonl
      collections.jsonl
      comparisons.jsonl
      site-config.json
      markdown-template.json
files/<id>/<original filename>   # the bytes of uploaded documents and attachments
```

Every `*.jsonl` file is UTF-8 with LF line endings, one record per line, keys in a stable order,
sorted oldest first. Two backups of unchanged data therefore differ only in their timestamps and
identifiers. Every record count in `manifest.json` equals the line count of the file it describes,
and `checksums.txt` covers every entry except itself.

The `data/works/content/` folders come from each Work's own data repository, read through the same
walk the JSON export has always used — so an archive carries at least everything the export
carries.

### Manifest fields

| Field                   | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `everworksBackupFormat` | Sentinel identifying the file as an Ever Works backup manifest                 |
| `formatVersion`         | `major.minor` of the archive format                                            |
| `producedAt`            | ISO-8601 instant the backup started                                            |
| `producedBy`            | The build (and optionally the instance) that wrote it                          |
| `workspace`, `account`  | Which workspace and which account it belongs to                                |
| `options`               | Whether full history was requested                                             |
| `domains`               | All fifteen sections, each with status, restorability, counts, files and trims |
| `files`                 | Included file count and bytes, plus every omitted file with its reason         |
| `exclusions`            | The nine categories that are never included, verbatim                          |
| `totals`                | Record and byte totals                                                         |

The machine-readable version of the table below is served by
`GET /api/account/backups/format`, which returns `formatVersion` and the domain descriptors from
the single source both this page and the product read. Prefer that endpoint when writing a tool:
it cannot drift from the running build.

## The fifteen sections

`restorable` is recreated in the target workspace. `record-only` is exported as evidence and
never written back — runs, decisions, money and history describe a past that did not happen in
the target workspace, and writing them would invent one. `partly-restorable` recreates some
record types and keeps the rest as a record.

| Section         | Restorability     | Notes                                                             |
| --------------- | ----------------- | ----------------------------------------------------------------- |
| `account`       | restorable        | Profile, preferences, onboarding answers                          |
| `organizations` | restorable        | The organization descriptor, members and invitations              |
| `agents`        | restorable        | Agents, their bindings and preferences                            |
| `missions`      | restorable        | Missions and their goals                                          |
| `tasks`         | restorable        | Tasks, subtasks, approvers and reviews                            |
| `works`         | restorable        | Work rows plus each Work's content from its data repo             |
| `knowledge`     | restorable        | Knowledge documents, memory files and folders, and upload bytes   |
| `schedules`     | restorable        | Schedules and triggers; restored **paused**                       |
| `runs`          | record-only       | Run rows, logs and terminal transcripts                           |
| `decisions`     | record-only       | Inbox items, approvals and escalations                            |
| `communication` | partly-restorable | Addresses and preferences restore; message history stays a record |
| `connections`   | restorable        | Connections restore in a **needs credential** state               |
| `fleet`         | partly-restorable | Preferences restore; the machine inventory stays a record         |
| `billing`       | record-only       | Ledger and invoice rows, with no provider identifier              |
| `activity`      | record-only       | The activity history, trimmed                                     |

Every section appears in every manifest with a status, so a reader can always tell "you have none
of these" from "we did not export these". A section's status is one of `complete`, `trimmed`,
`partial`, `failed` or `empty`.

A section that fails gets two retries and is then marked `failed` with an error code; the archive
still finishes with the other fourteen and reports the shortfall. An honest gap is not the same
thing as a silent one.

## History windows

Most data is exported in full regardless of age. History-shaped record types are trimmed, per
record type rather than per section, because the sections are not uniform — "Runs and receipts"
holds run rows that are never trimmed, run logs trimmed at 90 days and terminal transcripts
trimmed at 30.

| Record type          | Default | With full history |
| -------------------- | ------- | ----------------- |
| Activity history     | 365 d   | 1095 d            |
| Run logs             | 90 d    | 1095 d            |
| Terminal transcripts | 30 d    | 365 d             |
| Notifications        | 180 d   | 1095 d            |
| Plugin usage events  | 180 d   | 1095 d            |
| Delivery logs        | 30 d    | 365 d             |
| Trigger fires        | 90 d    | 1095 d            |
| Retrieval trail      | 30 d    | 365 d             |
| Fleet jobs           | 30 d    | 365 d             |

Ticking **Include full history** lifts every window to its second column. It never adds a section
that would otherwise be excluded and never changes the size limits. Every applied trim is recorded
in the manifest with the cutoff it used and the number of rows it left out.

## What is never included

Nine categories are absent from every archive, at every option setting. The manifest carries this
list verbatim so the archive states its own omissions.

1. Password hashes, password-reset tokens, magic-link tokens and email-verification tokens.
2. Sessions, refresh tokens, and third-party auth provider access and refresh tokens.
3. API key material. Keys appear as name, prefix, created date and active flag only.
4. Every stored credential, in plaintext or ciphertext — plugin secrets, connection headers,
   deployment secrets, webhook and trigger signing secrets, encrypted runtime credentials, and
   share-link tokens. Only the **names** of the fields that were set are exported.
5. Node enrolment and heartbeat secrets.
6. Payment-provider customer, subscription, payment-method and meter identifiers.
7. The platform-administrator flag.
8. Vector embeddings and their coordinates, because they are derived and regenerate on demand.
9. Internal caches and the delivery outbox.

:::warning The archive is not encrypted
It holds your workspace's content. It never holds your passwords, API keys or connection
credentials — but treat it as you would any other copy of your data.
:::

## Limits, allowance and retention

These are the shipped defaults. A deployment may change any of them, and the product reads the
values in force from the API rather than repeating these numbers.

| Setting                                     | Default                   |
| ------------------------------------------- | ------------------------- |
| Ready backups allowed per rolling 24 hours  | 3 (failures do not count) |
| How long we keep the archive bytes          | 14 days                   |
| How long the record outlives its bytes      | 90 days                   |
| Largest single uploaded file carried        | 200 MiB                   |
| Total uploaded-file bytes carried           | 2 GiB                     |
| Archive ceiling (streaming storage backend) | 5 GiB                     |
| Archive ceiling (non-streaming backend)     | 512 MiB                   |
| Download link lifetime                      | 15 minutes                |
| Time a backup may run                       | 60 minutes                |

Only one backup of a workspace runs at a time: starting a second adopts the first rather than
doubling the work. The record is kept after the bytes are deleted so the history list stays
legible — you can still see when a backup was taken and what it covered after its archive has
expired.

### Storage backends

Archives are written through whichever storage plugin the deployment has active, resolved by
**capability probe** rather than by backend name. A backend that implements `put-object-stream`
and `get-object-stream` gets the 5 GiB ceiling and is never buffered; `local-fs`, `aws-s3` and
`minio` all do. A backend whose write API is not a streaming target (GitHub blob storage) falls
back to the 512 MiB ceiling — a smaller limit, never a wrong result. See
[Built-in plugins](../plugin-system/built-in-plugins.md).

## API

All routes are session-guarded, scoped to the active workspace, and owner-only.

```
POST   /api/account/backups                   # start one — 202, or 200 { adopted: true }
GET    /api/account/backups                   # history, newest first (limit max 50)
GET    /api/account/backups/current           # the poll target while one runs
GET    /api/account/backups/format            # the machine-readable field reference
GET    /api/account/backups/:id
POST   /api/account/backups/:id/cancel
DELETE /api/account/backups/:id               # deletes the bytes, keeps the record
POST   /api/account/backups/:id/download-link # 15-minute token, bound to backup + user + scope
GET    /api/account/backups/:id/download      # streamed application/zip
```

`POST /api/account/backups` answers `429` with a `retryAt` when the daily allowance is spent, and
`503` when the deployment has no storage backend configured. The download route streams from the
storage backend and never buffers the archive.

The archive filename is `everworks-backup-<workspace slug>-<YYYY-MM-DD>-<short id>.zip`.

## Version policy

The format version is `major.minor`.

- Adding a section or a field is a **minor** bump and never breaks an older reader: a reader skips
  descriptors it does not recognise and reports them as not supported by its version.
- Removing or repurposing either is a **major** bump.
- A build reads any archive at or below its own version. It **describes** a higher one — telling
  you what the archive holds and which build wrote it — and refuses to restore from it.

## Verifying an archive yourself

```bash
unzip -o everworks-backup-acme-2026-09-17-a1b2c3.zip -d backup
cd backup
sha256sum -c checksums.txt
# how many records does the manifest claim for one file, and how many lines are there?
python -c "import json;m=json.load(open('manifest.json'));print(m['totals'])"
wc -l data/works/works.jsonl
```

Nothing about that requires Ever Works. That is the point: an archive found on a disk years from
now identifies itself, states what it holds, and proves it has not been altered.
