# Task Triggers — implementation notes

Branch: `session/feat-task-triggers`. Feature L of the trigger/tasks program.

A **Triggers** tab on the Tasks surface: rules that fire on inbound webhooks or
ingested platform events and create (and optionally dispatch) Tasks. Built by
EXTENDING the existing `inbound_triggers` machinery — nothing was forked, and
the pre-existing signed-webhook contract still holds byte for byte.

Cron/schedule modes deliberately stay in feature I (tasks-upgrades); this branch
adds no scheduling.

## What shipped

### Data model

`inbound_triggers` (extended, all additive with behaviour-preserving defaults):

| column                    | type                                      | meaning                                                            |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `sourceType`              | varchar(16) `'webhook'`\|`'event'`        | what fires it; `'webhook'` default                                 |
| `eventMatcher`            | simple-json                               | `{source?, kind?, workId?}`, trailing-`*` wildcards on source/kind |
| `taskDescriptionTemplate` | text                                      | `{{…}}` description template                                       |
| `taskTemplateSlug`        | varchar(80)                               | RESERVED feature-I linkage (string slug, never a FK)               |
| `mode`                    | varchar(16) `'single-task'`\|`'template'` | what a fire produces — **locked at create**                        |
| `agentPrompt`             | text                                      | `'single-task'` instructions; payload appended in `<webhook_body>` |
| `showOnBoard`             | boolean (false)                           | primary Task of a fire appears on the Kanban                       |
| `replayWindowSec`         | int (300)                                 | timestamp freshness AND duplicate-delivery window                  |
| `autoStart`               | varchar(16) `'always'`\|`'manual'`        | dispatch the first Task, or leave it in the backlog                |
| `defaultVariables`        | simple-json                               | `[{key, label?, required}]` payload contract                       |

`inbound_trigger_fires` (new) — both the idempotency ledger AND the "recent
fires" log: `triggerId`, `dedupeKey` (UNIQUE with triggerId), `origin`
(`webhook`\|`event`\|`manual`\|`test`), `status`
(`running`\|`done`\|`failed`\|`refused`), `reason`, `taskId`, `firedAt`.

`tasks.hiddenFromBoard` boolean (false) — server-written only (absent from
`CreateTaskDto`); `ListTasksFilter.includeHidden` opts hidden rows back in.

Migrations: `1786890000000-ExtendInboundTriggersForEvents` (sourceType/matcher/
templates + the fires table) and `1786890001000-AddTriggerModesAndBoardVisibility`
(mode/prompt/board/replay/autoStart/variables + `tasks.hiddenFromBoard`).

### Firing

Every delivery path funnels through one private `executeFire`, so they cannot
drift: required-variable gate → mode-driven Task body → `hiddenFromBoard` →
`autoStart` dispatch through the gated `runTask` → atomic `fireCount` /
`lastFiredAt` bump → ledger row closed with the outcome.

- **Webhook** (`POST /api/inbound-triggers/:id/fire`, public, HMAC): unchanged
  verification, now with a per-trigger replay window and duplicate suppression.
  Dedupe identity is `x-everworks-delivery` when the sender supplies one, else
  the request signature (a byte-identical replay signs identically). A duplicate
  answers `200 { ok, taskId, taskSlug: null, duplicate: true }` pointing at the
  original fire's Task.
- **Event**: `TriggerEventFiringService` registers a wildcard (`kinds: ['*']`)
  processor on `EventIngestService`; each drained `ingested_events` row is
  offered to the owner's active `'event'` triggers, matched by `eventMatcher`,
  and claimed permanently per `(trigger, event)` so drain retries never
  double-fire. Scope rule: same user AND same organization.
- **Manual** (`POST :id/fire-now`): a REAL fire with a sample payload built from
  the trigger's own declared variables (so a contract-carrying trigger does not
  trip its own gate). Counters move; `autoStart` is honoured.
- **Test** (`POST :id/test-fire`): rehearsal — real Task labelled `trigger-test`,
  logged as an `origin: 'test'` fire, but never dispatched and never counted.

`'single-task'` mode builds the Task body with `buildSingleTaskPrompt`: the
owner's instructions, then the payload as JSON inside a `<webhook_body>` block
with every `<` emitted as its unicode JSON escape — a payload containing
`</webhook_body>` cannot close the block and be read as instructions.

### API (`/api/inbound-triggers`)

Existing: `GET /`, `POST /`, `GET :id`, `PATCH :id`, `POST :id/rotate-secret`,
`POST :id/pause`, `POST :id/resume`, `POST :id/test-fire`, `DELETE :id`,
`POST :id/fire` (public).
Added: **`POST :id/fire-now`**, **`GET :id/fires`** (newest first, cap 50).

`mode` is create-only: it is absent from `UpdateInboundTriggerDto`, so a PATCH
carrying it 400s with `property mode should not exist`. `mode: 'template'`
without a `taskTemplateSlug` is refused at create, and a template-mode trigger
cannot later clear that slug.

### Web

- `/tasks/triggers` — Triggers tab (Name → detail link, Mode badge from `mode`,
  Target, Enabled toggle, Last fired, Fires, row menu: fire now / test fire /
  edit / rotate / delete) + New Trigger dialog covering mode, prompt, matcher,
  templates, agent, variables, auto-start, replay window, show-on-board.
- `/tasks/triggers/[id]` — NEW detail page: webhook URL + copy, expandable
  signed-curl example, **Rotate secret** (one-time reveal), **Fire now**,
  **Pause/Resume**, and the recent-fires panel with status chips.
- The webhook URL is built from `resolvePublicApiBaseUrl()`, not
  `window.location.origin` (they differ in every split-origin deployment).
- i18n keys added to all 21 locale files under `dashboard.taskTriggers`.

## Test commands

```bash
cd packages/agent && npx jest --testPathPattern='triggers/__tests__|task.repository'
cd apps/api     && npx jest --testPathPattern='tasks.controller'
cd packages/agent && npx tsc -p tsconfig.json --noEmit
cd apps/api      && npx tsc -p tsconfig.json --noEmit   # needs `turbo build --filter=ever-works-api^...` first
cd apps/web      && npx tsc -p tsconfig.json --noEmit
```

New/updated specs: `inbound-triggers-modes.spec.ts` (modes, variable contract,
board visibility, auto-start, replay window, fire-now, fire log),
`inbound-trigger-fire.repository.spec.ts` (the claim contract),
`trigger-prompt.spec.ts`, `trigger-variables.spec.ts`,
`inbound-triggers-events.spec.ts` (updated for the ledger contract),
`task.repository.spec.ts` (board visibility),
`tasks.controller.board-visibility.spec.ts` (the `includeHidden` query→filter copy),
`flow-inbound-triggers-validation-matrix.spec.ts` (new DTO fields).

## Decisions worth knowing

- **`attachTask` is gone.** The ledger now claims with an outcome and is closed
  by `complete(...)`; there is no second write that can silently no-op.
- **Signature-as-delivery-id.** Falling back to the signature for dedupe is the
  textbook replay check (identical bytes + identical timestamp = a replay).
  Senders that retry with a fresh timestamp are treated as new deliveries, which
  is why an explicit `x-everworks-delivery` header is the better contract.
- **Webhook fires now dispatch.** Previously the webhook path assigned the agent
  but never started a run; `autoStart` makes that policy explicit and uniform
  across paths. Dispatch stays best-effort — a credits gate refusing the run
  never undoes a legitimately created Task (the fire logs as `done`, not
  `running`).
- **Template mode degrades, it does not refuse.** With feature I unmerged there
  is no `TASK_TEMPLATE_LOOKUP` provider, so a template-mode trigger falls back to
  its own title/description templates instead of failing every fire.
- **`firedAt` is reset through an explicit UPDATE**, not `save()`: it is a
  `@CreateDateColumn`, which entity persistence treats as insert-only, and a
  re-claim that failed to move it would leave the replay window anchored on the
  original delivery.
- **The `1786890000000` migration was edited in place** (`eventId` → `dedupeKey`,
  plus the log columns) rather than patched by a follow-up migration. It is
  branch-local and has never been applied anywhere, so this yields the correct
  final schema without a rename migration.

## Known follow-ups

- `defaultVariables` is edited as text (`key`, `key*`, `key | Label` per line) in
  the New Trigger dialog. A row builder would be nicer once the shape settles.
- The fire log has no pagination beyond the 50-row cap and no filter by status.
- `GET :id/fires` is not covered by an e2e spec (the unit specs pin the service
  contract); worth adding when the e2e trigger suite is next touched.
- Pre-existing, unrelated to this branch: `apps/api` type-check reports 4
  unresolved-module errors (`@ever-works/k8s-plugin` in a deploy e2e spec, and
  three `@src/*` aliases inside `packages/agent` entity files) that reproduce
  without these changes.
