# Fleet run asks the owner — implementation notes (self-build slice Q, EW-762)

Branch `feat/fleet-run-ask-human`, stacked on slice C2 (`feat/fleet-task-extra-repos`, #2307), which
is stacked on C1 (#2306), B (#2298) and A (#2297). Program: Workspace
`knowledge/notes/2026-09-02-self-build-fleet-program.md`.

Before this, an agent running on a fleet node had exactly one way to say "I cannot decide this": end
the run with an explanation in its final message, which the reconciler recorded as a _completed_ run
with that summary. There was no channel back to the owner mid-run (a node has no platform tools), no
way to park the run, and nothing that would carry the owner's answer into a later run. The
in-process path had all of that (`InboxService.askHuman`, `RunSteeringService.resume`, the Inbox
reply box); this slice gives the fleet path the same loop with a file as the out-of-band channel.

## What shipped

### Contracts (`@ever-works/contracts`)

- `FLEET_AGENT_TASK_QUESTION_FILE` = `.ever-works/QUESTION.md` (case-exact — NTFS finds
  `question.md`, ext4 does not) under `FLEET_AGENT_TASK_META_DIR` = `.ever-works`;
  `FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES = 65536` (the node reads at most this much),
  `FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS = INBOX_MAX_TITLE_CHARS` (300 — the question line IS the
  Inbox title), `FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES = 6144` (300 + 2 + 6144 ≤
  `INBOX_MAX_BODY_CHARS`, far below the 256 KB result cap the job service enforces by REJECTING the
  report).
- `FleetAgentTaskQuestion { text; context; truncated; mountDir }` and
  `FleetAgentTaskResult.question?` — present for ANY `status`; the node never fails a run for it.
- `parseFleetAgentTaskQuestionMarkdown(markdown, mountDir?)` (BOM stripped, CRLF/CR → LF, first
  non-blank line with a leading `#{1,6}` removed = text, remainder = context; a first line over 300
  code points is prepended in FULL to the context so nothing is lost) and
  `normalizeFleetAgentTaskQuestion(raw)` (coercing, never throws: first line only, code-point-safe
  cuts, context cut to 6144 UTF-8 bytes, `mountDir` must match `^[A-Za-z0-9._-]{1,64}$`, unknown keys
  dropped, `truncated` sticky; C0 controls, DEL and ANSI CSI sequences stripped from text and
  context, and a line that is nothing but control characters skipped like a blank one — review
  SR-3, a NUL would make the reconciler's first Postgres write throw). Barrel pin 83 → 90 runtime
  symbols (the stripper is private).
- Inbox: `InboxItemSourceType` += `'fleet-run'` (appended LAST — the web spec pins the order),
  `InboxItemSourceMeta { nodeId?; nodeName?; branch?; taskTitle?; prUrl?; mountDir? }`,
  `INBOX_SOURCE_META_MAX_FIELD_CHARS = 300`, `normalizeInboxSourceMeta(value)`,
  `InboxItemDto.sourceMeta?` (optional on the wire — an older API omits it).

### Node (`apps/node`)

- `core/executors/agent-task-question.ts` (new): the `AgentTaskQuestionFs` seam (`readHead`,
  `remove`, `removeDirIfEmpty`) + `defaultQuestionFs` (`lstat`-gated bounded read — only a regular,
  non-symlink entry is opened, with `O_NOFOLLOW` on POSIX; a symlink, directory or FIFO rejects with
  `EFTYPE` so the caller still removes it but never reads it, review SR-1 — `rm --force`, `rmdir`
  swallowing ENOENT/ENOTEMPTY/EEXIST), `ownerQuestionPath(workspacePath)`, `discardOwnerQuestion(...)` (the
  pre-model clean — the provisioner reuses a worktree in place with no reset, so a file left by an
  aborted attempt or the PREVIOUS run would otherwise become a phantom question), and
  `collectOwnerQuestion({ primaryPath, mounts? })` — primary first, then every WRITABLE mount in spec
  order; for every candidate: read → parse → remove the file → remove the empty `.ever-works` dir
  (a blank file is removed too); primary wins; `truncated` forced when the head filled the 64 KiB
  cap; every fs error swallowed except AbortError.
- `agent-task.ts`: `AgentTaskIo.questionFs?` seam; discard before the model step for the primary
  and each writable mount; collect right AFTER the model step and BEFORE the checks and both
  finalizers, so `git add -A` can never stage it; the result gains a CONDITIONAL `question` key
  (never `question: null`); a question never pushes to `failures` — the status, check and git
  verdicts stay honest and the platform decides what a paused run means.
- `workspaces/fleet-task-workspace.ts`: `FLEET_TASK_WORKSPACE_EXCLUDE_RULES` (`/.mounts/`,
  `/.ever-works/` and the UNANCHORED `.ever-works/` — review SR-5: a model that `cd`-ed into a
  package and wrote the file relative to its cwd would otherwise hand `git add -A` a nested
  `packages/api/.ever-works/QUESTION.md`; git matches an unanchored `dir/` pattern at any depth);
  `ensureMountsExcluded` → `ensureFleetExcluded(repoPath, signal)`, per-rule idempotent (a slice-C
  node whose `info/exclude` already carries `/.mounts/` gains the two question rules exactly once),
  written for the primary ALWAYS — single-repository workspaces included — and for every mount
  right after it is provisioned.

### Agent (`@ever-works/agent`)

- `InboxItem.sourceMeta` (`simple-json`, nullable) + migration `1788000000000-AddInboxItemSourceMeta`
  (portable `TableColumn`, guarded, reversible) + better-sqlite3 spec.
- `InboxItemRepository`: `CreateInboxItemInput.sourceMeta` (through `normalizeInboxSourceMeta`),
  `ListInboxItemsOptions.taskId`, `findOpenQuestionByRunId(agentRunId)` (producer dedup);
  `toInboxItemDto` emits `sourceMeta`.
- `InboxProducer.questionRaised(input: InboxQuestionRaisedInput)` — the fleet twin of `askHuman`:
  `{ userId; agentRunId; agentId?; question; context?; sourceMeta? }`; Task / Work / org links are
  derived from the OWNED run row inside the service, never from the caller.
- `InboxService`: `askHuman`'s filing extracted into a private `fileQuestion` (byte-identical
  outcomes for the cloud path); `questionRaised` (trim, empty → warn + return, dedup by open question
  per run, `sourceType: 'fleet-run'`, `sourceMeta`); `composeFleetAnswerMessage(title, answer)` =
  `Your question from the previous run: <title>` + blank line + `Owner's answer: <answer>` — the
  outbound text `routeQuestionReply` hands to steer/resume for `fleet-run` rows (cloud rows unchanged);
  `ListInboxOptions.taskId`; dismissal: archiving or deleting an OPEN `fleet-run` question clears the
  run's `awaitingInput`, un-archiving back to open re-parks it (`isOpenFleetQuestion`,
  `setFleetRunParked`); `agent-run` items keep today's behaviour byte-for-byte.
- `RunSteeringService.resume`: the source run's `awaitingInput` is cleared only AFTER the dispatch
  block — when the gate parked the successor or the enqueue succeeded — and never when the enqueue
  throws; the enqueue payload carries `tenantId` / `organizationId` from the run row.
  `RunDispatchGateService.drainForWork` carries the same pair for non-chat candidates.
- `TaskWorkspaceService.recordRemotePush({ task, branch, runId?, headSha?, baseSha?, changedFiles? })`
  — branch / `branchState` / base sha + the changed-files stamp, no pull request, no transition;
  `branchState` is `'pr-open'` when the Task already carries a pull request and `'pushed'` otherwise
  (review Q-R1-01 — a question in a later run of a Task with a PR must not drop the PR link from
  the branch chip); `finalizeRemotePush` delegates its prelude to it and no longer re-writes
  `pr-open` itself (behaviour unchanged).
- `AgentRunRepository.tryMarkCompleted(runId, summary): Promise<boolean>` — the CAS outcome.
  `markCompleted` keeps its `void` return (its spec pins `resolves.toBeUndefined()`) and delegates.

### API (`apps/api`)

- `InboxApiModule`'s lazy `INBOX_PRODUCER` factory passes `questionRaised` through.
- `FleetAgentTaskReconcilerService`: `parseAgentTaskResult` redacts secrets from the question's
  `text` / `context` (`redactQuestionFields` → `redactSecrets`, review SR-2 — the question line
  becomes the run summary, the Inbox title that `composeFleetAnswerMessage` replays into the next
  prompt, and the Inbox body; nothing downstream redacts) and THEN normalises it; `git.error` is
  redacted inside `describeQuestionNotes` (a failed push quotes the remote URL with its token).
  `reconcileCompletion` branches to `reconcileQuestion` BEFORE the succeeded / failed split, for ANY
  result status, gate verdict or git error. Order inside: terminal-row replay guard →
  `tryMarkCompleted` (summary `Paused with a question for the owner: <text>`; a lost CAS returns) →
  `setAwaitingInput(true)` (NOT best-effort: a throw aborts before the Inbox row exists — and both
  parking writes log at ERROR level with the run id and what state the run was left in, review
  SR-3, instead of the listener's generic warn) → board
  denorm `'completed'` → `recordRemotePush` when the primary was pushed (never `finalizeRemotePush`)
  → `finalizeMountPush({ agentCanOpenPullRequests: false })` per pushed mount → `lookupNode` →
  `inbox.questionRaised` with `sourceMeta { nodeId, nodeName, branch, taskTitle, prUrl, mountDir }`
  (ids from the event / run row only) → Task-chat message ("Fleet run paused — waiting for your
  answer") → `drainForWork`. Never `markFailed`. Helpers `describeQuestionNotes`,
  `composeQuestionContext` (capped to `INBOX_MAX_BODY_CHARS − 300 − 2`), `composeQuestionMessage`.
- `FleetAgentTaskPlannerService`: `@Optional() AgentRunRepository` appended LAST; refuses
  `TaskStatus.DONE` / `CANCELLED` with a `FleetAgentTaskPlanError` naming the status;
  `resolveOwnerMessages(payload)` reads the NEW run's `pendingInput` (owner-checked,
  `neutralizeControlTokens`, 16 KiB per message, 32 KiB for the section, oldest dropped behind
  `[earlier owner messages omitted]`, best-effort); `composeInstructions` renders `# OWNER ANSWER`
  between `# TASK` and `# WORKSPACE (fleet node)` inside the never-truncated tail — branch,
  pushed-or-not from `task.branchState`, PR URL, `--- BEGIN OWNER MESSAGES ---` /
  `--- END OWNER MESSAGES ---` markers, `Message N:` numbering; the OUTPUT CONTRACT question
  paragraph and the WORKSPACE "ask the owner through `.ever-works/QUESTION.md`" line only when
  `permissionMode !== 'plan'`.
- `GET /api/inbox?taskId=` (`ListInboxQueryDto.taskId`, `@IsUUID()` like every other id filter —
  review SR-4: `inbox_items.taskId` is a `uuid` column and Postgres answers a non-UUID comparison
  with `22P02`, a 500 for a client typo; conditional spread in the controller).

### Web (`apps/web`)

- `lib/api/inbox.shared.ts`: `'fleet-run'`, `InboxItemSourceMeta`, `InboxItem.sourceMeta?`,
  `isFleetQuestion(item)`; `lib/api/inbox.ts`: `ListInboxInput.taskId`.
- `components/inbox/InboxFleetSource` (new): `compact` = the "From your fleet" chip on the list row
  next to the kind badge; full = the provenance line under the detail title (node — name or the
  first 8 chars of the id —, Task, branch in `<code>` with ` (.mounts/<dir>)` when the question came
  from a mount, and a pull-request link only for an `http(s)` URL). Everything is rendered as text.
- `components/tasks/TaskRunControls`: prop `openQuestion?: TaskRunOpenQuestion | null`; on a
  non-live awaiting run with a known question it renders the amber "The agent paused this run with a
  question for you" banner, the question, an _Answer it in the Inbox_ link (`/inbox?id=<item>`) and
  the archive hint INSTEAD of the hint + free-text Resume form; every other state is unchanged.
  `TaskDetailClient.initialOpenQuestion` threads it; the Task page adds
  `inboxAPI.list({ taskId, status: 'open', limit: 5 })` to its `Promise.allSettled` and picks the
  newest open `question`.
- i18n (all 21 locales, English fallback text): `dashboard.inbox.fleet.{badge,node,task,branch,pullRequest}`,
  `dashboard.tasksPage.detail.runControls.{waitingForAnswer,answerInInbox,parkedHintQuestion}`.

## Critic gaps and how each closed

| #   | Gap (code fact)                                                                                                                                                                                                                                                                              | Closed by                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | The reconciler split on `event.succeeded && result.status === 'succeeded'` before anything else; partial work almost always reports `failed`, so a question on such a result would have been reconciled as a failure with a "Fleet run failed" notice.                                       | `reconcileQuestion` runs BEFORE the split, for any status; the node keeps `question` a conditional key and never fails a run for it.                                                                                                |
| B2  | `InboxService.askHuman` parks via `setAwaitingInput` itself; a question filed while the run row is still `running` lets a fast reply hit `RunSteeringService.steer` → `appendPendingInput` (NON_TERMINAL only) → `'steered'`, and nothing on a node drains `pendingInput`.                   | Reconciler order `tryMarkCompleted` → `setAwaitingInput(true)` → THEN `questionRaised`; asserted by invocation order in the reconciler spec.                                                                                        |
| B3  | `RunSteeringService.resume` seeds `pendingInput` on the NEW run and only `AgentRunService.runToolLoop` drains it — nothing would have delivered the answer to a node.                                                                                                                        | The planner reads the new run's `pendingInput` and renders `# OWNER ANSWER`; the question text rides inside the resume message (`composeFleetAnswerMessage`) because `TasksModule` cannot reach `InboxItemRepository`.              |
| B4  | `resume()` cleared the source run's `awaitingInput` BEFORE `dispatcher.enqueue` and never restored it when the enqueue threw; with the fleet-aware dispatcher now running the planner on resume, a `FleetAgentTaskPlanError` would orphan the parked run and the reopened item route `none`. | The clear moved after the enqueue block (skipped on throw); the reopened item can be answered again or archived.                                                                                                                    |
| M1  | Resume / drain payloads omitted `tenantId` / `organizationId`; `FleetRunRouterService.resolveRuntimeId(undefined)` returns the INSTANCE default, so a tenant-overlay fleet would resume onto the cloud.                                                                                      | Both payloads carry the pair from the run row / candidate, mirroring `TaskTransitionService.dispatchAgentRun`.                                                                                                                      |
| M2  | `finalizeRemotePush` → `openPullRequestForBranch` transitions the Task to `IN_REVIEW` even for pushed-no-PR.                                                                                                                                                                                 | `TaskWorkspaceService.recordRemotePush` (the bookkeeping half only); the question path never calls `finalizeRemotePush`; mounts use `finalizeMountPush({ agentCanOpenPullRequests: false })`, which only records `state: 'pushed'`. |
| M3  | The local-workspace plugin reuses a worktree in place with no clean when the stamp branch matches; a stale `QUESTION.md` would have been reported as a fresh question.                                                                                                                       | `discardOwnerQuestion` before the model step (primary + writable mounts) plus the exclude rule.                                                                                                                                     |
| M4  | No idempotency: `markCompleted` swallowed the CAS boolean, `setAwaitingInput` is unguarded, `askHuman` has no dedup.                                                                                                                                                                         | Terminal-row guard on the loaded run, `tryMarkCompleted` (parks / files only on `true`), `findOpenQuestionByRunId` dedup in `questionRaised`.                                                                                       |
| M5  | Two resume paths would strand each other, and a parked fleet run had no exit: `cancel` refuses terminal rows and the sweeper never reaps `awaitingInput` rows.                                                                                                                               | The Task page hides the free-text Resume while an open fleet question exists and links to the Inbox; archiving / deleting the open question clears `awaitingInput` (un-archive re-parks); cloud items untouched.                    |
| M6  | `FleetJobService.completeJob` rejects an oversize result with 400 and the worker loop then reports the job failed with "settlement was rejected".                                                                                                                                            | Contracts caps + deterministic, code-point-safe truncation on the node, re-normalised by the reconciler; the node reads at most 64 KiB of the file.                                                                                 |
| M7  | The exclude rule was only written on the mounts path (single-repository provision returned early) and only for the primary; a question file in a mount would have been committed and never read.                                                                                             | `ensureFleetExcluded` for the primary ALWAYS and for every mount; the node scans writable mounts and reports `mountDir`.                                                                                                            |
| M8  | Resume bypasses every Task-status guard; an unpinned Agent may resume on another node with nothing but the base ref.                                                                                                                                                                         | The planner refuses done / cancelled Tasks (safe because B4 keeps the source run resumable and `reply` reopens the item); `# OWNER ANSWER` states the branch, whether it was pushed, and the PR; the docs state the no-push caveat. |

Smaller items folded in: no question paragraph in permission mode `plan` (the model cannot write the
file under `--permission-mode plan` / Codex `--sandbox read-only`); CRLF / BOM / case-exact file
name; prompt-injection boundaries (ids only from the event / run row, the answer through
`neutralizeControlTokens` inside explicit BEGIN / END markers with a sentence telling the model the
text is the owner's words, not platform instructions); board denorm `'completed'` with the web
deriving the waiting state from `awaitingInput`; every typed `InboxProducer` double gained
`questionRaised`.

## Review round 1 — findings and how each closed

| #       | Finding (code fact)                                                                                                                                                                                                                                                                                                      | Closed by                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q-R1-01 | `recordRemotePush` wrote `branchState: 'pushed'` unconditionally; only `finalizeRemotePush` repaired it to `pr-open`, and the question path never calls that. A question in a later run of a Task with a PR left `pushed` + `prNumber`/`prUrl` set: the branch chip dropped the PR link the Inbox item still advertised. | `recordRemotePush` writes `pr-open` when the Task carries a PR (`finalizeRemotePush`'s duplicate write removed). Specs: remote-push (`keeps pr-open…`, the idempotent case now asserts the single write) and the reconciler (Task row with PR handed through, `sourceMeta.prUrl`).                           |
| SR-1    | `defaultQuestionFs.readHead` did `fs.open` straight away: a symlink was followed and its target reported as the question; on POSIX a FIFO (or a link to `/dev/tty`) blocked the node until the lease ran out — no abort reaches a blocked syscall.                                                                       | `lstat` first; only a regular non-symlink entry is opened (`O_NOFOLLOW` on POSIX closes the window); anything else rejects `EFTYPE`, which `collectOwnerQuestion` treats as "present, unreadable" and removes (`fs.rm` unlinks the link / FIFO, never a target). Real-fs specs for symlink, directory, FIFO. |
| SR-2    | The question text / context and `git.error` reached the run summary, the Inbox title + body and the next prompt unredacted; only the Task-chat post went through `redactSecrets`.                                                                                                                                        | `parseAgentTaskResult` redacts BEFORE normalising (caps apply to the redacted text); `describeQuestionNotes` redacts `git.error`. Reconciler spec with a `ghp_` PAT in the text, an `sk-` key in the context and a token-bearing push URL.                                                                   |
| SR-3    | The normalizer kept C0 controls: a NUL in the first line made the `summary` update inside `tryMarkCompleted` throw (Postgres `22021`), the exception unwound into `onCompleted`'s warn and the run stayed `running` — never parked, never failed — with the branch, board and Inbox item lost.                           | Contracts strip C0 / DEL / ANSI CSI from text and context and skip control-only lines; the reconciler wraps both parking writes and logs at error level with the run id and the state the run was left in. Specs in contracts and the reconciler.                                                            |
| SR-4    | `?taskId=` was `@IsString() @Length(1, 64)` against a `uuid` column: `GET /api/inbox?taskId=abc` was a 500 (`22P02`) on Postgres instead of a 400.                                                                                                                                                                       | `@IsUUID()`; the DTO spec accepts a UUID and rejects a slug, empty and oversize strings. The web only ever sends the route's task id.                                                                                                                                                                        |
| SR-5    | The exclude rule was root-anchored (`/.ever-works/`): a model that `cd`-ed into a package and wrote `.ever-works/QUESTION.md` there produced a nested file that `git add -A` committed and pushed, and that nobody scanned.                                                                                              | The unanchored `.ever-works/` rule joins the list (`/.mounts/` stays anchored on purpose); real-git specs write a nested file in the primary and in a mount and assert it never reaches `status` or the index. A nested file is still not REPORTED — follow-up below.                                        |

## Where the brief and the code disagreed

1. **`InboxItemRepository` is not reachable from `TasksModule`** (it is provided and exported only by
   `packages/agent/src/inbox/inbox.module.ts`), so the planner cannot read the Inbox row of the run
   it resumes. The question text therefore travels INSIDE the resume message
   (`composeFleetAnswerMessage`) and the planner renders `pendingInput` verbatim.
2. **`TaskRepository` is not reachable from `AgentsModule`**, so the done / cancelled refusal lives
   in the api planner (which already loads the Task) rather than in `RunSteeringService.resume`.
3. **`markCompleted` keeps `void`**: `agent-run.repository.spec.ts` pins `resolves.toBeUndefined()`,
   so the CAS boolean is exposed as the additive `tryMarkCompleted` and `markCompleted` delegates.
4. **No test seam for the exclude write**: every fake-plugin test in `fleet-task-workspace.spec.ts`
   rejects before the end of `provision`, and the happy-path describe uses real git, so
   `ensureFleetExcluded` needed no injectable.
5. **Plan mode cannot write the file**, so the protocol is simply not offered there — the WORKSPACE
   section keeps today's "explain exactly what is missing in your final message" sentence.

## Deliberate limits

- **No CLI session resume.** `result.model.sessionId` is not persisted; the answer run starts a fresh
  CLI session whose instructions carry the answer. Passing `--resume` on the same node is a
  follow-up.
- **A question run is a NORMAL terminal job on the node.** The job is `done`, the run is
  `completed` + `awaitingInput`; the wait is server-side only, and the answer always travels as
  text in the NEXT job's instructions. A node never holds a lease waiting for a human.
- **No Q&A replay.** Only the reply that resumed the run rides along; earlier questions and answers
  are not re-rendered into later runs (one Inbox item per run).
- **API-level resume from the Sessions page leaves the Inbox item open** (auto-closing it would need
  `InboxItemRepository` inside `AgentsModule` — a module cycle). The Task page hides its own Resume
  while a question is open, which covers the surface the owner actually uses.
- **Free text only**: `QUESTION.md` options are context, not buttons.
- **One question per run**; the answer run may ask a new one, which files a new item.
- **Single-owner Inbox** for organisation Tasks — the question goes to the run's owner.
- `MAX_STEER_BYTES` versus an 8000-character multibyte reply is a pre-existing limit of the resume
  message path, unchanged here.

## Verification

| Check                                                                                                                                                                                                                                                                                                      | Result                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `cd packages/contracts && npx vitest run src/fleet src/inbox`                                                                                                                                                                                                                                              | green; barrel pin 90 runtime symbols |
| `npx turbo build --filter=@ever-works/contracts` (worktree root, before any `tsc`)                                                                                                                                                                                                                         | dist current                         |
| `cd apps/node && npx vitest run src/core/executors src/core/workspaces src/core/runtime.spec.ts` + `npx tsc --noEmit`                                                                                                                                                                                      | green; type-check clean              |
| `cd packages/agent && npx jest inbox run-steering run-dispatch-gate task-workspace-remote-push agent-run.repository agent-run-sweeper` + `npx tsc --noEmit -p tsconfig.json`                                                                                                                               | green; type-check clean              |
| `npx turbo build --filter=@ever-works/agent` (worktree root — api ts-jest and `tsc` resolve `@ever-works/agent` types from `dist`)                                                                                                                                                                         | dist current                         |
| `cd apps/api && npx jest src/fleet src/inbox src/migrations/__tests__/AddInboxItemSourceMeta.spec.ts src/migrations/__tests__/migrations-directory-contract.spec.ts` + `npx tsc -p tsconfig.build.json --noEmit`                                                                                           | green; type-check clean              |
| `cd apps/web && npx vitest run src/lib/api/inbox.shared.unit.spec.ts src/components/inbox src/components/tasks/TaskRunControls.unit.spec.tsx`                                                                                                                                                              | 3 files, 20 tests                    |
| `cd apps/web && npx tsc --noEmit`                                                                                                                                                                                                                                                                          | clean                                |
| i18n: a script asserts the 8 keys resolve in all 21 `apps/web/messages/*.json` (inserted line-wise next to `waitingBanner` / `parkedHint`, so the diff is exactly 10 lines per file)                                                                                                                       | 168 / 168                            |
| Prettier on every changed file (root config for contracts / node, local config for api / agent / web / docs)                                                                                                                                                                                               | clean                                |
| Review round 1 re-run: contracts `src/fleet src/inbox` (618) + dist rebuild; node question / workspace / executor suites (113, the FIFO case skipped on Windows) + `tsc`; agent `task-workspace-remote-push task-workspace.service` (28) + `tsc`; api reconciler + inbox controller (47) + `tsc`; Prettier | green; type-checks clean             |

Not run: the end-to-end scenario on a real node (needs the self-build lane on prod); the Workspace
runbook `EVER_WORKS_FLEET_NODES.md` describes the manual check.

## Follow-ups

- Persist `result.model.sessionId` → `cliSessionId` and pass `--resume` when the answer run lands on
  the same node, so the model keeps its own context instead of re-reading the branch.
- Replay answered questions (the whole Q&A trail of a Task) into later runs.
- Option buttons parsed from `QUESTION.md` (a `- [ ]` list → `InboxItemOption[]`).
- Steer on a LIVE fleet run is still undeliverable (nothing on a node drains `pendingInput`); the
  Task page keeps offering it because it cannot tell a fleet run from a cloud one.
- A `fleet-run` filter / tab in the Inbox UI; a chip in `TaskRunsHistory` for the parked run.
- A nested `.ever-works/QUESTION.md` (written from a subdirectory) is kept out of Git by the
  unanchored exclude rule but not collected: have the node scan for it (a cheap glob, or
  `git status --porcelain --ignored`) and at least warn in the run report so a misplaced question
  is visible.
- An organisation-visible Inbox so a teammate can answer a question on an org Task.
- `apps/web/scripts/sync-locale-parity.mjs` has no check mode — it writes — and on this branch it
  reports 79 English-only keys missing from EVERY non-English locale, none of them from this slice
  (the run was reverted; the slice adds its 8 keys by hand). A parity sweep is its own ticket.
