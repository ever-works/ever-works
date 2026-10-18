# FL-11 — Files & clipboard · Implementation plan

> How [`spec.md`](./spec.md) gets built. Every path below was opened at this branch's base
> (`origin/develop` `e4334baf7`) before it was cited; paths marked _(new)_ do not exist yet, and
> paths marked _(FL-02)_, _(FL-01)_ or _(FL-07)_ are owned by those epics and assumed here.

**Epic ID:** `FL-11-files`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    subgraph WEB[apps/web]
        F[Files tab: browser, conflicts, delete, copy dialog]
        O[Operations strip (FL-02)]
        PD[Paste dialog (on the Desktop tab, FL-07)]
    end
    subgraph API[apps/api]
        C[FleetFilesController\n/api/fleet/nodes/:id/files/*]
        X[FleetFilesTransferService\nstream bridge + zip]
        K[FleetClipController\n/api/fleet/nodes/:id/desktop/views/:viewId/clip]
        R[Relay bus (FL-02)]
        A[ComputerControlArbiter (AW-11)]
        C --> X --> R
        K --> A
        K --> R
    end
    subgraph NODE1[apps/node · source]
        L1[Node link (FL-02)\nfamily: files]
        M1[files module\nroots · path guard · pack/unpack · delete]
        L1 <--> M1
    end
    subgraph NODE2[apps/node · destination]
        L2[Node link (FL-02)\nfamily: files · clip]
        M2[files module]
        D2[desktop-host.pasteText (FL-07)]
        L2 <--> M2
        L2 --> D2
    end
    F -- "list/stat/download/upload/copy/delete" --> C
    O <-- "operation.progress" --> R
    PD -- "POST clip (text ≤ 256 KiB)" --> K
    R <-- "DATA 64 KiB · ACK credits · END" --> L1
    R <-- "DATA · ACK · END · CLIP" --> L2
    X -- "download: zip/raw body" --> F
    F -- "upload: multipart → tar" --> X
```

Data flow: a download opens a `files` channel on the node (`files.pack`), the node streams a tar
of the selection as `DATA` frames, the platform ACKs bytes as the HTTP response drains (credits), and
converts to the browser shape (single file → raw body; otherwise a zip built on the fly). An upload
reverses it (`files.unpack`, the platform tars the multipart stream). A copy opens `files.pack` on
the source and `files.unpack` on the destination and pipes `DATA` between the two channels inside
the platform, forwarding the destination's `ACK` credits to the source. A paste is one `CLIP` frame
on a `clip` channel bound to the desktop view, admitted only when the arbiter says the caller holds
control and the view's paste opt-in is on.

---

## 2. Current state in the codebase

| Piece                                                                         | Where (verified at HEAD)                                                                                                                                                    | Reused as                                                                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workspace root default and flag parsing                                       | `apps/node/src/core/workspaces/fleet-task-workspace.ts:523-528` (`~/.ever-works/fleet-workspaces`); `apps/node/src/cli/program.ts:371, 1576`; `program.workspace-root.spec.ts` | The workspace root is the second allowed root; `--files-root` parses with the same absolute-path rule.                           |
| Node core layout (no files module)                                            | `apps/node/src/core/{executors,model-execution,packaging,screen,windows-job-launcher,workspaces}/`                                                                            | `apps/node/src/core/files/` _(new)_ sits beside them.                                                                           |
| Owner-only ACL helper (`icacls`) and 0600 file posture                        | `apps/node/src/node-io.ts`; used by `apps/node/src/core/screen/agent-profile.ts`                                                                                            | Uploaded files inherit the destination folder's ACL; no new ACL code.                                                           |
| Blocked clipboard shortcuts and the injector's refusal of clipboard payloads  | `packages/contracts/src/computer/computer-control.types.ts:140-191`; `apps/node/src/core/screen/input-injector.ts:20-22`                                                   | Untouched: paste is a separate `clip` channel, not an input frame.                                                               |
| Control arbiter (who holds control of a view)                                 | `packages/agent/src/computer/control-arbiter.service.ts:1-80`                                                                                                                | `FleetClipService` asks it whether the caller's view holds control before admitting a paste.                                     |
| Desktop host hooks `openUrl` / `pasteText`                                    | `apps/node/src/core/screen/desktop-host.ts` _(FL-07)_                                                                                                                       | `pasteText` is the node-side target of the `clip` channel.                                                                      |
| Secret scanner (values)                                                       | `packages/contracts/src/secret/secret-patterns.ts:1-47`                                                                                                                     | Used for the non-blocking paste warning only; names use the new pattern list.                                                   |
| Fleet audit writer and its key redactor                                       | `packages/agent/src/fleet/fleet-audit.service.ts:38-58`                                                                                                                     | One writer; details keys `root`, `path`, `bytes`, `entries`, `peerNodeId`, `confirmed` — none matches the redactor.             |
| Audit action union                                                            | `packages/contracts/src/fleet/fleet-panic.types.ts:60-148`                                                                                                                  | Extended with `node.files.list|read|write|copy|delete` (CONTRACTS §7) and `node.clip.paste` (§8b).                              |
| Capability tag constants                                                      | `packages/contracts/src/fleet/fleet-jobs.types.ts:132-152`                                                                                                                  | `FLEET_FILES_CAPABILITY = 'files'` added beside them.                                                                           |
| Fleet guard and node-auth guard                                               | `apps/api/src/fleet/guards/fleet-enabled.guard.ts`, `fleet-node-auth.guard.ts`                                                                                              | `FleetEnabledGuard` on the new controllers; no node-facing HTTP is added (everything rides the link).                            |
| Error-with-reason posture on the computer controller                          | `apps/api/src/computer/computer.controller.ts:62-86`                                                                                                                        | Same shape, program codes from CONTRACTS §8.                                                                                    |
| Agent fleet tools (one read-only tool), MCP whitelist, CLI                    | `packages/agent/src/fleet/agent-fleet-tools.ts:32-60`; `apps/mcp/src/openapi-tools/whitelist.ts:475-530`; `apps/cli/src/main.ts`                                            | Files tools added beside; whitelist entries; CLI with FL-19.                                                                    |
| Existing e2e naming                                                           | `apps/web/e2e/flow-fleet-*.spec.ts`                                                                                                                                         | New specs follow the name.                                                                                                      |

**Missing at HEAD (what this plan builds):** the node files module (roots, path guard, pack/unpack,
delete), the `--files-root` flag, the `files` tag, the `files` and `clip` link channels, the
platform transfer bridge and zip conversion, the files API, the Files tab and dialogs, the paste
dialog and clip API, the tools. No schema change.

---

## 3. Tech choices

| Concern                        | Choice                                                                                                                                 | Why                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link archive format            | **tar** streams in both directions (`tar-stream` 3.x: `pack`/`extract`, zero native deps, streaming)                                   | Preserves paths, modes and symlinks; streams without knowing sizes first; one format on the wire regardless of OS.                                   |
| Browser download shape         | Single file → raw body; several/folder → zip built on the platform from the tar stream with `archiver` 7.x (`store` by default)         | Browsers open zip; building it on the platform keeps the node simple; `store` keeps CPU low (compression is a later option).                          |
| Browser upload shape           | Multipart (`@fastify/multipart` or the Nest file interceptor in use) → platform tars entries with `webkitRelativePath` → `files.unpack` | Folder uploads keep their relative paths; the node never sees multipart.                                                                              |
| Credits                        | `ACK(30)` frames carrying bytes consumed; sender window 8 MiB; chunk 64 KiB (CONTRACTS §10)                                             | Backpressure both ends; the platform holds at most one window per operation.                                                                         |
| Path canonicalisation (node)   | `fs.realpath` of the root once; per request: `path.resolve(root, rel)` + `realpath` of the longest existing prefix; `lstat` each component; a symlink whose `realpath` leaves the root → refuse | Catches `..`, absolute paths, drive letters, and link escapes; stays correct on Windows (case-insensitive compare after `realpath`).                   |
| Credential-shaped names        | Fixed list in contracts `FLEET_CREDENTIAL_FILE_PATTERNS` (globs): `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `id_rsa*`, `id_ed25519*`, `*.ppk`, `.netrc`, `.npmrc`, `.pypirc`, `credentials`, `credentials.json`, `service-account*.json`, `.aws/credentials`, `*.gpg`, `*.asc`, `.docker/config.json`, `kubeconfig`, `.kube/config` | Names, not contents; conservative; one definition used by node, API and tools.                                                                      |
| Partial-write safety (node)    | Unpack writes to `<dest>/.ever-works-partial-<opId>/` then renames per entry on `END`; cancel/interrupt/failure removes the partial dir | FR-15 by construction; rename is atomic on the same volume.                                                                                           |
| Delete                         | `fs.rm({ recursive: true })` after the canonical check, never following links out of root                                             | No shell-out; link targets untouched.                                                                                                                 |
| Paste on the machine           | FL-07 `desktop-host.pasteText(text)` → helper sets the clipboard, sends `Ctrl/⌘+V` to the focused window                                | Reuses the admitted helper; the node never reads the clipboard.                                                                                       |
| Operation records              | FL-02 `operation.*` on channel 0 + `GET /api/fleet/operations/:id`; cancel via FL-02 (§8b)                                             | One operations tray for every long action.                                                                                                            |
| Web grid                       | `role="grid"` table with the existing `@/components/ui/*` primitives; no new dependency                                                 | Keyboard model (FR-41) by construction.                                                                                                               |

---

## 4. Data model

**No schema change.** CONTRACTS §13 reserves no FL-11 slot; files are never rows. What exists and
is used: `fleet_audit` (new action values), FL-02's operation records, `FleetNode.controlPolicy.files`
(FL-01 shape), `computer_sessions` (FL-07; the paste opt-in is in-memory relay state keyed by view
id, reset on view end, never persisted).

Contracts (`packages/contracts/src/fleet/`, additive):

- `fleet-files.types.ts` _(new)_: `FLEET_FILES_CAPABILITY = 'files'`;
  `FleetFileRootView { id, kind: 'checkout'|'workspace'|'listed', label, path }`;
  `FleetFileEntryView { name, kind: 'file'|'folder'|'link'|'other', size, modifiedAt, hidden, credentialShaped, linkInsideRoot: boolean | null }`;
  `FleetFileListView { root, path, entries, truncated }`; `FleetFileConflictView { name, size, modifiedAt }`;
  `FLEET_FILE_CONFLICT_POLICIES = ['skip','replace']`; `FleetFilesOperationView` (kind
  `download|upload|copy|delete`, bytes, total, entries, state, startedAt, endedAt, peerNodeId);
  `FLEET_FILES_LIMITS = { chunkBytes: 65536, windowBytes: 8 MiB, maxOpBytes: 2 GiB, maxEntries: 5000 }`;
  `FLEET_CREDENTIAL_FILE_PATTERNS` + `isCredentialShapedName(name)`.
- `fleet-clip.types.ts` _(new)_: `FLEET_CLIP_MAX_BYTES = 262144`; `FleetClipPasteRequest { text }`;
  `FleetClipPasteResult { bytes, pastedAt }`.
- `fleet-panic.types.ts`: `node.files.list|read|write|copy|delete`, `node.clip.paste`.

---

## 5. API surface

Root `/api/fleet/nodes/:id/files` (CONTRACTS §11.2), `FleetEnabledGuard` + `FLEET_MACHINE_FACTS_ENABLED`;
family `files` via FL-01 role derivation; errors `{ error: { code, hint, details } }`.

| Method | Path                           | Body / query                                                                 | Returns                                    | Errors                                                                                   | Tier    |
| ------ | ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- | ------- |
| GET    | `/roots`                       | —                                                                            | `FleetFileRootView[]`                      | `unreachable`, `consent_missing`, `permission_denied`                                    | 60/min  |
| GET    | `/list`                        | `?root&path&hidden`                                                          | `FleetFileListView`                        | + `invalid` (escape), `limit_exceeded` never (truncates)                                 | 120/min |
| GET    | `/stat`                        | `?root&path`                                                                 | `FleetFileEntryView`                       | `not_found`, `invalid`                                                                   | 120/min |
| GET    | `/download`                    | `?root&path&entries[]&confirm=<token>`                                       | stream (`attachment`, `nosniff`; zip or raw) + `X-Fleet-Operation-Id` | `confirmation_required` (credential-shaped, class `confirm`), `limit_exceeded`, `kill_switch` | 10/min  |
| POST   | `/conflicts`                   | `{ root, path, names[] }`                                                    | `FleetFileConflictView[]`                  | —                                                                                        | 60/min  |
| POST   | `/upload`                      | multipart: `root`, `path`, `policy` (per-name map or `replace-all`), files   | `202 { operationId }`                      | `limit_exceeded`, `operation_failed`, `invalid`                                          | 10/min  |
| POST   | `/copy`                        | `{ from: { root, path, entries[] }, to: { nodeId, root, path }, policy }`    | `202 { operationId }`                      | `invalid` (same folder), `consent_missing`/`permission_denied` naming which Node, `unreachable` | 10/min  |
| POST   | `/delete`                      | `{ root, path, entries[], confirmationToken }`                               | `202 { operationId }`                      | `confirmation_required` (class `confirm-destructive`)                                    | 10/min  |
| GET    | `/api/fleet/operations/:id`    | _(FL-02)_                                                                    | `FleetFilesOperationView`                  |                                                                                          |         |
| DELETE | `/api/fleet/operations/:id`    | _(FL-02, §8b)_                                                               | `204`                                      |                                                                                          |         |
| POST   | `/api/fleet/nodes/:id/desktop/views/:viewId/clip` | `{ text }` (≤ 256 KiB, UTF-8)                              | `FleetClipPasteResult`                     | `permission_denied` (not holder / opt-in off), `limit_exceeded`, `consent_missing` (attend), `unsupported_on_node` | 30/min  |
| PATCH  | `/api/fleet/nodes/:id/desktop/views/:viewId` _(FL-07 route)_ | `{ pasteAllowed: boolean }`                     | view                                       | holder only                                                                              | 30/min  |

Confirmation tokens: `POST /api/fleet/confirmations` _(FL-01/FL-02 shared helper, assumed)_ returns
a 2-minute single-use token bound to `{ action, target }`; the typed name is checked server-side.

DTOs in `apps/api/src/fleet/files/dto/fleet-files.dto.ts` (`class-validator`; `entries` ≤ 5 000;
names without path separators; `text` ≤ 262 144 bytes measured after UTF-8 encoding).

---

## 6. Node side

### 6.1 Modules

| Unit                                                                  | Responsibility                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/node/src/core/files/allowed-roots.ts` _(new)_                   | Builds the root list: FL-14 checkouts (from the node's checkout inventory; until FL-14 lands, the worktree pool entries under the workspace root), the workspace root, `--files-root` entries; `realpath` each once; refuses a root that does not exist. |
| `apps/node/src/core/files/path-guard.ts` _(new)_                      | Pure + IO: `resolveInsideRoot(root, rel)` → canonical absolute path or a typed refusal (`escape`, `link-escape`, `not-found`); `lstat` walk; Windows case-insensitive compare.                                                      |
| `apps/node/src/core/files/credential-shaped.ts` _(new)_               | Re-exports `isCredentialShapedName` from contracts (one definition).                                                                                                                                                              |
| `apps/node/src/core/files/list.ts` _(new)_                            | `files.list` / `files.stat`: `readdir` with `withFileTypes`, `lstat` per entry, 5 000 cap, hidden filter, flags.                                                                                                                  |
| `apps/node/src/core/files/pack.ts` _(new)_                            | `files.pack`: walks the selection, `tar-stream` pack, in-set links as links, out-of-set links skipped and counted, emits `DATA` ≤ 64 KiB honouring the 8 MiB window from `ACK`s, `END` with `{ entries, bytes, skippedLinks }`.    |
| `apps/node/src/core/files/unpack.ts` _(new)_                          | `files.unpack`: `tar-stream` extract into `<dest>/.ever-works-partial-<opId>/`, per-entry conflict policy, rename on `END`, remove partial dir on cancel/close/failure; sends `ACK` as it consumes.                                  |
| `apps/node/src/core/files/delete.ts` _(new)_                          | `files.delete`: canonical check per entry, `fs.rm` recursive, never follows links out of root.                                                                                                                                    |
| `apps/node/src/core/files/files-module.ts` _(new)_                    | The node module (D8): wires the above; advertises `files` iff `--manage` and roots non-empty; exposes `FilesHost` for the link channel.                                                                                           |
| `apps/node/src/core/link/channels/files-channel.ts` _(FL-02 dir, new file)_ | Message table in §6.3; one channel per operation; applies limits before the first byte.                                                                                                                                   |
| `apps/node/src/core/link/channels/clip-channel.ts` _(FL-02 dir, new file)_ | Opens with `{ sessionId }` (the desktop view id); accepts one `CLIP` ≤ 256 KiB; calls FL-07 `desktop-host.pasteText`; replies `{ ok, bytes }`.                                                                           |
| `apps/node/src/cli/program.ts`                                        | `start --files-root <dir>` (repeatable, absolute, same parser as `--workspace-root`); `doctor` prints roots.                                                                                                                       |
| `apps/node/src/core/capabilities.ts`                                  | `files` tag.                                                                                                                                                                                                                      |

### 6.2 OS matrix

| Concern                | Linux                                         | macOS                                         | Windows                                                               |
| ---------------------- | --------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Canonical path         | `realpath`, case-sensitive                    | `realpath`, case-insensitive compare          | `realpath` (long path), case-insensitive, drive-letter normalised, UNC refused |
| Links                  | symlinks preserved in-set                     | same                                          | symlinks/junctions listed as `link`; reparse points never followed out of root |
| Modes                  | preserved on unpack                           | preserved                                     | ignored (ACL inherited from the destination folder)                   |
| Hidden                 | dot-files                                     | dot-files + `UF_HIDDEN`                       | `FILE_ATTRIBUTE_HIDDEN` + dot-files                                   |
| Paste chord            | `Ctrl+V` via FL-07 helper                     | `⌘V`                                          | `Ctrl+V`                                                              |
| Shell-outs             | none                                          | none                                          | none                                                                  |

Consents: `files` needs `--manage`; `clip` needs `--attend`. Tags: `files`.

### 6.3 The `files` and `clip` channels, message by message

```
platform → node  channel.open { channel, family: 'files', params: { root, path } }
node → platform  channel.ready | channel.refused { code: 'consent_missing'|'invalid'|'not_found', hint }
platform → node  JSON { type: 'files.list', requestId, hidden }        → JSON { requestId, entries[], truncated }
platform → node  JSON { type: 'files.stat', requestId, name }          → JSON { requestId, entry } | error not_found
platform → node  JSON { type: 'files.pack', requestId, entries[], operationId }
node → platform  JSON { requestId, accepted: { entries, estimatedBytes } } | error limit_exceeded
node → platform  DATA(1) × N  (≤ 64 KiB each; at most 8 MiB unacknowledged)
platform → node  ACK(30) [bytes u32]                                   (as the consumer drains)
node → platform  END(31) then JSON { type: 'operation.done', operationId, bytes, entries, skippedLinks }
platform → node  JSON { type: 'files.unpack', requestId, destination, policy, operationId }
node → platform  JSON { requestId, accepted: true } | error limit_exceeded|operation_failed
platform → node  DATA(1) × N ; node → platform ACK(30) ; platform → node END(31)
node → platform  JSON { type: 'operation.done', operationId, bytes, entries, replaced, skipped }
platform → node  JSON { type: 'files.delete', requestId, entries[], confirmationClass: 'confirm-destructive', operationId }
node → platform  JSON { requestId, ok, removed } | error
either          CLOSE(11) reason: cancelled | kill_switch | node-unavailable   (node removes any partial dir)

platform → node  channel.open { channel, family: 'clip', params: { sessionId: <desktop view id> } }
node → platform  channel.ready | channel.refused { code: 'consent_missing'|'unsupported_on_node' }
platform → node  CLIP(40) UTF-8 text ≤ 256 KiB
node → platform  JSON { type: 'clip.pasted', bytes } | error operation_failed
```

Copy = the platform opens `files.pack` on Node A and `files.unpack` on Node B, pipes A's `DATA` to
B, forwards B's `ACK` to A, and reports one `operation.progress` stream; a `CLOSE` on either side
closes the other with the same reason.

---

## 7. Plugin surface

None. No capability, no plugin, no change to `docs/plugin-system/built-in-plugins.md`.

---

## 8. Web surface

- **Routes:** `/fleet/computers/[id]?tab=files[&root=&path=]` (FL-01 shell); paste lives on
  `?tab=desktop` (FL-07).
- **Registry entry** _(FL-01)_: `apps/web/src/components/fleet/registry.ts` →
  `{ id: 'files', label: 'fleet.computer.tabs.files', flag: 'FLEET_MACHINE_FACTS_ENABLED', load: () => import('./files/FilesTab') }`.
- **Components** under `apps/web/src/components/fleet/files/` _(new)_: `FilesTab.tsx`,
  `FilesRootPicker.tsx`, `FilesBreadcrumb.tsx`, `FilesGrid.tsx` (`role="grid"`, selection,
  keyboard), `FilesActionBar.tsx`, `FilesConflictDialog.tsx`, `FilesDeleteDialog.tsx`,
  `FilesCopyDialog.tsx` (destination computer/root/folder with greyed reasons),
  `FilesCredentialConfirm.tsx`, `FilesUnavailableCard.tsx`, `FilesOperationsStrip.tsx` (reads
  FL-02 operations), `use-files-api.ts`, `files.shared.ts` (pure: entry sort, size format, conflict
  merge, selection limits, hidden-toggle storage key `ew:fleet:files:hidden`).
- **Paste** under `apps/web/src/components/fleet/desktop/` _(FL-07 dir)_: `DesktopPasteDialog.tsx`
  (clipboard read via `navigator.clipboard.readText()` on user gesture, size meter, secret
  warning), `⋯` menu item **Allow paste into this desktop**, shortcut `Ctrl/⌘+Shift+V` registered
  in the desktop stage while controlling.
- **BFF**: `apps/web/src/app/api/fleet/nodes/[id]/files/{roots,list,stat,download,conflicts,upload,copy,delete}/route.ts`
  (download and upload are streaming proxies); `apps/web/src/app/api/fleet/nodes/[id]/desktop/views/[viewId]/clip/route.ts`.
- **i18n groups** (`apps/web/messages/en.json`, namespace `fleet`): `fleet.computer.tabs.files`,
  `fleet.files.roots.*`, `fleet.files.grid.*` (columns, kinds, flags), `fleet.files.actions.*`,
  `fleet.files.conflicts.*`, `fleet.files.delete.*`, `fleet.files.credential.*`, `fleet.files.copy.*`,
  `fleet.files.operations.*` (states, cancel notices), `fleet.files.unavailable.*`,
  `fleet.files.footer.*` (roots line, cost line), `fleet.files.a11y.*`, `fleet.desktop.paste.*`,
  `fleet.errors.*`.
- **Playwright** (`apps/web/e2e/`): `flow-fleet-files-browse.spec.ts`, `flow-fleet-files-transfer.spec.ts`
  (download raw + zip, upload with conflicts, cancel leaves nothing), `flow-fleet-files-copy.spec.ts`,
  `flow-fleet-desktop-paste.spec.ts`, `flow-fleet-files-contract.spec.ts`, `flow-fleet-files-a11y.spec.ts`.
  The e2e harness uses a fake node files host (a Node script speaking the `files`/`clip` channel
  messages over the FL-02 test link).

---

## 9. Agent / MCP / CLI surface

| Tool                 | Annotation                                                                 | Does                                                                                   | Family · consent      | Phase |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- | ----- |
| `fleet_files_list`   | `readOnly: true`                                                           | Entries of `{ nodeId, root, path, hidden? }` with flags                                | `files` · manage      | P1    |
| `fleet_files_stat`   | `readOnly: true`                                                           | One entry                                                                              | `files` · manage      | P1    |
| `fleet_files_copy`   | `destructive: true`, `confirmationClass: 'confirm'`                        | Lists conflicts first; writes only with `replace: true`; runs under the Run             | `files` on both Nodes · manage | P2 |
| `fleet_files_delete` | `destructive: true`, `confirmationClass: 'confirm-destructive'` → approval | Raises a Decision (AW-03) carrying the entries; executes on the owner's approval        | `files` · manage      | P2    |
| `fleet_clip_paste`   | `destructive: true`, denied unless granted (AW-15)                         | Pastes into a desktop view the Agent controls (FL-07 grant), opt-in respected           | `desktop` · attend    | P2    |

No tool downloads a credential-shaped file. Implemented in
`packages/agent/src/fleet/agent-fleet-files-tools.ts` _(new)_; MCP entries in
`apps/mcp/src/openapi-tools/whitelist.ts` with annotations; CLI
`ever-works fleet files ls|stat|get|put|cp|rm [--json]` and `ever-works fleet clip paste` in
`apps/cli/src/commands/fleet/files.ts` _(with FL-19)_, exit `0/1/2`.

---

## 10. Background jobs

None. Operations are link-bound and die with the link (R-11 posture); FL-02's operation records
and the kill switch cover cleanup. No retention: nothing is stored.

---

## 11. Security & permissions

- **Threats specific to this epic:** path traversal and link escapes; a credential file leaving a
  machine; a half-written file on a machine; the platform buffering unbounded bytes; a paste into
  the wrong machine or without consent; clipboard exfiltration from the machine; an Agent moving or
  deleting files without the owner knowing.
- **What the node refuses:** any path outside an allowed root after canonicalisation (`invalid`);
  following a link whose target leaves the root; more than 5 000 entries or 2 GiB per operation
  (`limit_exceeded`, before the first byte); a `files` channel without `--manage`; a `clip` channel
  without `--attend` or without the FL-07 desktop source; a `CLIP` over 256 KiB; any `clip` request
  the platform did not bind to a view the caller controls (the node trusts the platform's binding
  but still enforces size and consent).
- **What the platform refuses:** callers outside the `files` audience of **each** Node involved;
  a credential-shaped download without a `confirm` token (people) or at all (Agents); delete without
  a `confirm-destructive` token whose typed name matches; a paste from a caller who does not hold
  control of that view or whose view has paste off; a copy to the same folder.
- **Redaction:** no file names beyond the requested path, and no file contents, in logs; audit
  details hold `root`, `path`, `entries`, `bytes`, `peerNodeId`, `confirmed`; pasted text is never
  logged or audited (bytes only).
- **Audit:** `node.files.list` (first list per root per tab visit), `node.files.read` (download),
  `node.files.write` (upload), `node.files.copy` (both Nodes), `node.files.delete`, `node.clip.paste`;
  `requestedBy` = `user:<id>` | `agent:<id>`; `confirmationClass` recorded.
- **Kill switch (R-24):** `channel.open` refused `kill_switch`; in-flight operations closed within
  5 s; partial dirs removed by the node's `CLOSE` handler.
- **Consent hints:** `start the node with --manage on <node>`; `add --files-root <dir> on <node>`;
  `start the node with --attend on <node>` (paste).

---

## 12. Observability

- Activity Log: `fleet.files.downloaded|uploaded|copied|deleted` (bytes, entries, outcome),
  `fleet.desktop.pasted` (bytes).
- Metrics: `fleet_files_bytes_total{kind}`, `fleet_files_operations_total{kind,outcome}`,
  `fleet_files_refusals_total{code}`, `fleet_files_window_stalls_total`, `fleet_clip_pastes_total`.
- Node `doctor` prints the allowed roots and whether `files` is advertised.

---

## 13. Phased rollout (flag `FLEET_MACHINE_FACTS_ENABLED`, default off in production)

- **P1 — Browse and move:** contracts, node files module + flag + tag, `files` channel, platform
  transfer bridge (download raw/zip, upload), conflicts, credential gate, delete, Files tab and
  dialogs, operations strip, read-only tools, audit, i18n, e2e browse/transfer/contract. Green:
  `flow-fleet-files-browse|transfer|contract.spec.ts`.
- **P2 — Between machines, and paste:** copy bridge (two channels piped, credits forwarded),
  `clip` channel + `pasteText` wiring, paste dialog + opt-in + shortcut, copy/delete/paste tools
  with approvals, e2e copy/paste/a11y. Green: `flow-fleet-files-copy.spec.ts`,
  `flow-fleet-desktop-paste.spec.ts`, `flow-fleet-files-a11y.spec.ts`.
- **Default-on** after acceptance tests are green on `develop` (D12).

---

## 14. Test plan

Runners: contracts, node, web unit → **Vitest**; agent, api → **Jest**; e2e → **Playwright**.

- **Contracts** `packages/contracts/src/fleet/__tests__/fleet-files.types.spec.ts` — guards,
  limits constants, `isCredentialShapedName` truth table (positives from the list; `env.ts`,
  `keyboard.ts`, `README.md` negative); `fleet-clip.types.spec.ts`.
- **Node** `apps/node/src/core/files/path-guard.spec.ts` (`..`, absolute, drive letter, UNC, link
  escape, in-root link, case on Windows via injected platform), `allowed-roots.spec.ts` (home never
  default; missing root refused; checkouts + workspace + listed), `list.spec.ts` (cap, hidden,
  flags), `pack.spec.ts` (tar contents, in-set links, out-of-set skipped and counted, window
  respected with a slow ACK), `unpack.spec.ts` (partial dir, conflict policies, rename on END,
  removal on CLOSE/cancel), `delete.spec.ts`, `apps/node/src/core/link/channels/files-channel.spec.ts`
  (message table; limits before first byte), `clip-channel.spec.ts` (size cap; consent),
  `apps/node/src/cli/program.files-root.spec.ts`, `capabilities.spec.ts` (`files` iff roots).
- **Agent** `packages/agent/src/fleet/files/__tests__/fleet-files.service.spec.ts` (audience on
  each Node; credential gate for people vs Agents; same-folder refusal; every code with hint),
  `fleet-clip.service.spec.ts` (holder + opt-in required; reset on view end; cap),
  `agent-fleet-files-tools.spec.ts` (annotations; delete raises an approval; paste default denied).
- **API** `apps/api/src/fleet/files/fleet-files.controller.spec.ts`, `fleet-files-transfer.service.spec.ts`
  (raw vs zip; platform buffer ≤ 8 MiB with a slow client; cancel closes the channel; copy pipes
  and forwards credits; kill switch cancels within 5 s), `fleet-clip.controller.spec.ts`.
- **Web unit** `files.shared.unit.spec.ts`, `FilesGrid.unit.spec.tsx` (keyboard model),
  `FilesConflictDialog.unit.spec.tsx` (default Skip), `FilesDeleteDialog.unit.spec.tsx` (exact
  match), `FilesCopyDialog.unit.spec.tsx` (greyed reasons), `DesktopPasteDialog.unit.spec.tsx`
  (cap, warning, disabled reasons).
- **E2E** §8 list, with the fake files host; a 1 GiB synthetic download checksum; a network
  assertion that no request leaves the platform toward a node during a copy.

---

## 15. Risks

| Risk                                                                    | L   | I   | Mitigation                                                                                                    |
| ----------------------------------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------- |
| Browser-side zip expectations vs tar on the wire                        | M   | L   | Platform converts; single files stay raw; format is an internal detail.                                       |
| Platform memory under many concurrent transfers                         | M   | M   | One 8 MiB window per operation; per-owner concurrent-operation cap of 4 (hint names it); metrics on stalls.    |
| Windows path semantics (case, junctions, long paths)                    | M   | M   | Dedicated guard tests with injected platform; junctions treated as links; UNC refused.                         |
| Credential-shaped list misses a name                                    | M   | M   | Conservative fixed list, reviewable in one file; §8b asks whether owners may extend it.                        |
| Paste lands in the wrong window                                         | L   | M   | Only while controlling; the dialog says where focus is; the viewer sees the desktop as it pastes.              |
| FL-02 operations cancel not available                                   | M   | M   | §8b flags; fallback is `CLOSE(cancelled)` on the channel, which the node already handles.                      |
| FL-14 checkouts land after FL-11                                        | M   | L   | Roots fall back to the worktree pool under the workspace root until FL-14's inventory exists.                   |

---

## 16. Constitution reconciliation

- **I Plugin-first:** no external integration; machine facts as a node module (D8).
- **II Capability-driven:** no plugin id named.
- **III Source-of-truth repos:** nothing from a machine is stored; bytes stream through.
- **IV Job runtime:** no background job needed; link-bound operations.
- **V Forward-only migrations:** none (no slot).
- **VI Tests:** §14.
- **VII Secrets:** names gated, contents never logged, paste one-way and size-only in audit.
- **VIII Plugin counts:** untouched.
- **IX Behaviour-first:** spec names no class; this plan owns the implementation.
- **X Backwards compatibility:** additive tag, routes, audit members, tools.

---

## 17. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program: [README](../README.md) D2, D7, D8 · [CONTRACTS](../CONTRACTS.md) R-18, R-24, §3.2–3.3,
  §7, §8, §10, §11 · [CAPABILITY-MAP §D](../CAPABILITY-MAP.md)
- FL-07 plan §6.1 (`desktop-host.ts` hooks) · FL-02 plan (link, operations, relay bus)
- Security model: `docs/specs/security/fleet-session-trust-model.md`
