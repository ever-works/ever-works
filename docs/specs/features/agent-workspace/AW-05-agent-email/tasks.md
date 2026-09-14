# AW-05 — Agent email end to end · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths,
> a definition of done, and its phase. An engineer or coding agent should be able to run these top
> to bottom without guessing.

**Epic ID**: `AW-05-agent-email`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are sequential unless marked `(parallel)`.
- Every task ships with its tests in the same PR (Constitution VI). A task whose "Done" clause
  names a spec file is not done until that file passes.
- Phase boundaries (`P1` / `P2` / `P3`) are shippable cut lines. Do not start a P2 task before
  every P1 task is merged and `develop` is green.
- Add new tasks at the bottom rather than renumbering.
- Repo root is the worktree root; all paths are relative to it.
- Before any migration work: `cd apps/api` — migrations are generated from there against
  `typeorm.config.ts`.

---

## Phase 1 — the loop

### 1.1 Contracts and types

- [ ] **T1** `(P1)` Add the email contracts package.
    - Create `packages/contracts/src/email/email.types.ts` with: `EmailMessageStatus`
      (`'received'|'draft'|'revising'|'scheduled'|'sending'|'sent'|'failed'|'escalated'|'discarded'|'blocked'`),
      `AgentInboxMode`, `AgentInboxState`, `EmailRuleType`, `EmailRuleMatchKind`,
      `EmailRuleDirection`, `EmailAllowListMode`, `EmailSendingDomainStatusValue`,
      plus the canonical `readonly` arrays for `@IsIn` validators (mirror the shape of
      `packages/contracts/src/agents/escalation.types.ts`).
    - Create `packages/contracts/src/email/email.constants.ts` with **every** numeric limit from
      `plan.md` §3.4 — this is the single source of truth for all of them.
    - Create `packages/contracts/src/email/email.dto.ts` with `AgentInboxDto`, `EmailThreadDto`,
      `EmailMessageDto`, `EmailRuleDto`, `EmailSendingDomainDto`, `EmailCapMeterDto`
      (ISO date strings on the wire, matching `InboxItemDto`).
    - Create `packages/contracts/src/email/index.ts`; export it from
      `packages/contracts/src/index.ts` next to the existing `./inbox/index.js` line.
    - **Done**: `pnpm --filter @ever-works/contracts build` is green and every constant in
      `plan.md` §3.4 exists exactly once in the repo.

- [ ] **T2** `(P1, parallel with T1)` Add the email escalation reason code.
    - `packages/contracts/src/agents/escalation.types.ts`: append `'email-escalated'` to
      `AgentEscalationReasonCode` **and** to `AGENT_ESCALATION_REASON_CODES` (append only — the
      array order feeds `@IsIn` validators; never reorder).
    - **Done**: no migration needed (the column is `varchar(32)`); `pnpm --filter @ever-works/contracts type-check` green.

- [ ] **T3** `(P1, parallel with T1)` Add the email activity action types.
    - `packages/agent/src/entities/activity-log.types.ts`: append the 14 members listed in
      `plan.md` §3.2 to `ActivityActionType`.
    - **Done**: appended, nothing reordered; `actionType` stays a free `varchar(50)` so no
      migration is required — state that in the enum's block comment.

### 1.2 Entities and migrations

- [ ] **T4** `(P1)` Add the three new entities.
    - `packages/agent/src/entities/agent-inbox.entity.ts` — fields exactly as `plan.md` §3.1.
      No `@ManyToOne` to `Agent` (EW-654 cycle avoidance); `@ManyToOne` to `TenantEmailAddress`
      with `onDelete: 'RESTRICT'`. Use `PortableDateColumn` from `./_types` for every date.
    - `packages/agent/src/entities/email-rule.entity.ts`
    - `packages/agent/src/entities/email-sending-domain.entity.ts`
    - Register all three in **four** places — missing any one breaks boot:
      `packages/agent/src/entities/index.ts`,
      `packages/agent/src/database/_entities-inventory.ts` (concrete per-file import, never the
      barrel — see that file's header comment),
      `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_repository-inventory.ts`.
    - **Done**: `pnpm --filter @ever-works/agent build` green; `apps/api` boots against a fresh
      database.

- [ ] **T5** `(P1)` Additive columns on the two existing email tables.
    - `packages/agent/src/entities/email-message.entity.ts` — add the 16 columns from
      `plan.md` §3.2 and the three new `@Index` declarations. **Update the class JSDoc**: the
      "either `taskId` OR `conversationId` (never both)" paragraph is superseded — every message now
      carries a `conversationId`; `taskId` is an additional link. Leave the prompt-injection warning
      intact.
    - `packages/agent/src/entities/email-conversation.entity.ts` — add the 10 columns and the
      `idx_email_conversations_inbox_state_last` index.
    - **Done**: entities compile; no existing column touched.

- [ ] **T6** `(P1)` Migration 1 — new tables.
    - `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddAgentInboxesAndEmailRules`
    - Land it as `apps/api/src/migrations/1791050000000-AddAgentInboxesAndEmailRules.ts` (AW-05 slot 00,
      [README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)).
    - Hand-edit the generated file to match the house style of
      `apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts`: a block comment explaining
      each table and why it is not an existing one, portable `TableColumn` / `Table` DDL,
      existence guards (`await queryRunner.getTable(...)`), and a real `down()`.
    - **Done**: applies cleanly on Postgres and on the better-sqlite3 CI stack; re-running is a
      no-op; `down()` drops only what `up()` created.

- [ ] **T7** `(P1)` Migration 2 — message and thread lifecycle columns + status backfill.
    - `apps/api/src/migrations/1791050100000-AddEmailMessageLifecycle.ts`.
    - Adds the columns from T5 and the four new indices.
    - Backfill, batched at 5,000 rows: inbound → `status='received'`, outbound → `status='sent'`,
      outbound → `readAt = createdAt`.
    - **Done**: on a database with existing `email_messages` rows, every row has a non-null
      `status` after the migration and no row's existing data changed.

- [ ] **T8** `(P1)` Migration 3 — thread backfill.
    - `apps/api/src/migrations/1791050200000-BackfillEmailThreads.ts`.
    - For every `email_messages` row with `conversationId IS NULL`, find-or-create an
      `email_conversations` row keyed `(agentId, deriveThreadKey(subject))` — import the **existing**
      `deriveThreadKey` from
      `packages/agent/src/notifications/agent-inbound-email-dispatcher.ts`, do not reimplement it.
      Then set `conversationId`, and recompute `subject` / `messageCount` / `hasAttachments` /
      `lastMessageAt` / `lastInboundAt` per thread.
    - Batched at 2,000 rows, idempotent (guards on `IS NULL`), re-runnable.
    - **Done**: after running, `SELECT count(*) FROM email_messages WHERE conversationId IS NULL` is
      0; running it twice changes nothing; **test**:
      `apps/api/src/migrations/__tests__/backfill-email-threads.spec.ts` seeds 3 messages sharing a
      subject and asserts one thread with `messageCount = 3`.

### 1.3 Repositories

- [ ] **T9** `(P1)` Repositories for the three new entities.
    - `packages/agent/src/database/repositories/agent-inbox.repository.ts` —
      `findByAgent`, `findByIdForUser`, `findByAddress`, `listForUser`, `updateState`,
      `casSetState(id, from, to)`.
    - `packages/agent/src/database/repositories/email-rule.repository.ts` —
      `listForEvaluation(userId, inboxId, direction)` (one query returning both scopes),
      `countForUser`, `countForInbox`, `bumpMatch(id, at)`.
    - `packages/agent/src/database/repositories/email-sending-domain.repository.ts` —
      `listForUser`, `findDue(now, limit)`, `countForUser`.
    - **Done**: each has a `.spec.ts` beside it asserting owner scoping (a foreign `userId` returns
      nothing, never someone else's row).

- [ ] **T10** `(P1)` Extend the two existing email repositories.
    - `packages/agent/src/database/repositories/email-message.repository.ts` — add
      `casTransition(id, from, to, patch?)` returning the affected-row count (this is the primitive
      every race guard in the epic is built on), `countSentInWindow(inboxId, sinceMs)`,
      `countHeldScheduled(inboxId)`, `listRecipientsInWindow(inboxId, sinceMs)`,
      `findDueScheduled(now, limit)`, `listForThread(threadId)`, `listStaleDrafts(olderThan)`.
    - `packages/agent/src/database/repositories/email-conversation.repository.ts` — add
      `listThreads(userId, {inboxId, filter, q, limit, cursor})` using **keyset** pagination on
      `(lastMessageAt, id)` — never `OFFSET` — plus `recomputeCounters(threadId)`.
    - **Done**: `casTransition` has a spec proving that two concurrent calls with the same `from`
      yield exactly one affected row.

### 1.4 Domain services

- [ ] **T11** `(P1)` `EmailRuleResolver` — pure and separately testable.
    - `packages/agent/src/email/email-rule-resolver.ts`.
    - Export a **pure** `resolveRuleVerdict(rules, {address, direction, allowListMode})` implementing
      the score function in `plan.md` §3.1 (inbox 4 · exact 2 · allow 1), plus an injectable
      `EmailRuleResolver` service that loads rules through the repository and calls it.
    - Normalise: lower-case, trim, strip display names, treat `@example.com` and `example.com` as the
      same domain match.
    - **Test**: `packages/agent/src/email/__tests__/email-rule-resolver.spec.ts`, table-driven over
      every case in `plan.md` §10.1 including S12 and both allow-list modes.
    - **Done**: the pure function has zero Nest imports and 100% branch coverage.

- [ ] **T12** `(P1)` `EmailSendCapGuard`.
    - `packages/agent/src/email/email-send-cap-guard.service.ts` and
      `packages/agent/src/email/email-send-cap-exceeded.exception.ts`.
    - `checkOrThrow({userId, inboxId, recipients, now})` evaluates, in this order:
      recipients-per-message (50) → inbox 60s burst (10) → inbox 5m distinct recipients (20) →
      inbox rolling 24h (`dailySendCap`, counting `status='sent' AND sentAt > now-24h` **plus**
      every outstanding `status='scheduled'` row, per FR-46) → workspace rolling 24h (500) →
      workspace rolling 30d (10,000).
    - On refusal throw `EmailSendCapExceededException` (HTTP 429) with the `details` shape in
      `plan.md` §4.6 — model it on `packages/agent/src/budgets/budget-exceeded.exception.ts`.
    - Also expose `getMeter(inboxId)` returning `EmailCapMeterDto` for the UI, and
      `markPausedIfNeeded` / `clearPauseIfCleared` writing `agent_inboxes.capPausedUntil`.
    - **Never** read a ceiling or a count from anything a model can write (FR-67) — counts come from
      `email_messages`, ceilings from `agent_inboxes` and the constants module.
    - **Test**: `packages/agent/src/email/__tests__/email-send-cap-guard.spec.ts` with a frozen
      clock, covering every row of the FR-60 table plus reservation hold/release and
      `retryAfterSeconds`.

- [ ] **T13** `(P1)` `AgentInboxService`.
    - `packages/agent/src/email/agent-inbox.service.ts`.
    - `provision(userId, {agentId, localPart?, sendingDomainId?})` — idempotent (FR-2); allocates
      `<localPart>@<workspaceSlug>.<EVER_WORKS_AGENT_MAIL_DOMAIN>` (default `agents.ever.works`,
      read via `packages/agent/src/config/`); creates the backing `tenant_email_addresses` row with
      `direction='both'`, `verified=true` (the platform owns the domain), and both
      `agent_email_assignments` rows (inbound + outbound, priority 100) so the existing dispatcher
      and `sendEmail` resolution keep working unchanged.
    - `update`, `remove` (cancels outstanding scheduled sends), `rename` (pushes the old address into
      `previousAddresses` with a 30-day `expiresAt`, max 5), `releaseForArchivedAgent`.
    - **Test**: `packages/agent/src/email/__tests__/agent-inbox.service.spec.ts` — FR-1…FR-9.

- [ ] **T14** `(P1)` `EmailDraftService` — the state machine.
    - `packages/agent/src/email/email-draft.service.ts`.
    - `submit(input)` — the draft gate (`plan.md` §2.1 seam 2): reads the inbox mode, persists the
      message, creates the `agent_action_proposals` row (`actionType:'send_message'`,
      payload `{kind:'email-draft', emailMessageId, inboxId, threadId}`) through
      `AgentApprovalsService.createProposal`, and either holds or auto-decides.
    - `approve(userId, messageId, edit?)` — applies the inline edit, pushes the prior version into
      `draftHistory` (cap 10), `casTransition('draft' → 'sending')`, sends through
      `EmailFacadeService.send`, transitions to `sent` or `failed`.
    - `revise(userId, messageId, notes)` — increments `reviseCount` (max 5),
      `casTransition('draft' → 'revising')`, dispatches a Run via the existing
      `AGENT_TASK_EXECUTE_DISPATCHER`.
    - `discard`, `markStaleOnInbound(threadId)`, `expireStaleDrafts(now)`.
    - **Test**: `packages/agent/src/email/__tests__/email-draft.service.spec.ts` — every legal
      transition, every illegal one rejected, the approval race (FR-33), the revise ceiling, the
      version-history cap.

- [ ] **T15** `(P1)` Emit an approval-decided event and listen for it.
    - `packages/agent/src/agent-approvals/agent-approvals.service.ts`: emit
      `AgentActionProposalDecidedEvent` from `decide()` and `approveAll()` via an `@Optional()`
      injected `EventEmitter2` (the pattern `BudgetGuardService` already uses). New event class at
      `packages/agent/src/agent-approvals/agent-action-proposal-decided.event.ts`.
    - `packages/agent/src/email/email-approval.listener.ts`: `@OnEvent(...)`; when
      `payload.kind === 'email-draft'`, approve → `EmailDraftService.approve`, reject →
      `discard`. This is what makes approving from **My Decisions** send exactly once (FR-23).
    - **Done**: existing approvals tests stay green; a new spec proves a decision from either
      surface sends exactly one message.

- [ ] **T16** `(P1)` `EmailEscalationBridge`.
    - `packages/agent/src/email/email-escalation.service.ts` — creates an `agent_escalations` row
      with `reasonCode: 'email-escalated'`, links it from `email_messages.escalationId` and
      `email_conversations.escalationId`, and suppresses further agent replies on the thread while
      it is open (FR-36).
    - Extend `packages/agent/src/agents/agent-escalation-tools.ts` so an Agent handling mail can
      escalate with a thread reference.
    - **Done**: resolving via the existing `POST /api/escalations/:id/resolve` clears the thread
      badge (FR-39) — asserted by a spec.

- [ ] **T17** `(P1)` Wire the cap gate and the outbound rule check into the choke point.
    - `packages/agent/src/facades/email.facade.ts`: inject `EmailSendCapGuard` and
      `EmailRuleResolver` as `@Optional()` constructor params (matching the five optional repos
      already there so bare test contexts keep constructing). At the **top** of `send()`, before
      `resolveOutboundPlugin`: evaluate outbound rules against every `to`/`cc`/`bcc` recipient
      (throw `EmailRecipientBlockedException`, HTTP 403), then `checkOrThrow`.
    - New exception at `packages/agent/src/email/email-recipient-blocked.exception.ts`.
    - **Test**: `packages/agent/src/facades/__tests__/email.facade.cap.spec.ts` proves the guard runs
      before any plugin resolution and that **every** send path is refused identically (FR-63).

- [ ] **T18** `(P1)` Wire the draft gate into the agent tool path.
    - `apps/api/src/agents/agents.module.ts`: the `AGENT_EMAIL_FACADE` adapter calls
      `EmailDraftService.submit` instead of `EmailFacadeService.send` directly.
    - `packages/agent/src/agents/agent-tool.service.ts` `buildSendEmailTool`: on a held draft return
      a structured, model-readable result (`{held: true, reason: 'awaiting-approval', messageId}`);
      on no inbox return `This agent has no email inbox. Ask your owner to give it an address.`
      (S22). Update the tool `description` to say replies may be held for approval.
    - **Done**: an agent-initiated send with the inbox in `draft-review` makes **zero** provider
      calls — asserted with a mocked facade, not inferred.

- [ ] **T19** `(P1)` Wire the inbound rule check.
    - `packages/agent/src/notifications/default-inbound-email-dispatcher.service.ts`: as step 1 of
      `dispatch()`, resolve the recipient to an `agent_inboxes` row and evaluate inbound rules.
      On `block`: persist the message with `status='blocked'` + `blockedByRuleId`, bump the rule's
      match counters, emit `EMAIL_BLOCKED_BY_RULE`, and **return before** any thread write, Task
      spawn or Run (FR-51).
    - Also: always resolve/create the thread and set `conversationId` for inbound messages,
      regardless of dispatch mode (§2.2), and record `attachmentsMeta` (max 25).
    - **Test**: `packages/agent/src/notifications/__tests__/default-inbound-email-dispatcher.rules.spec.ts`
      asserts the spawner mock was **not** called and no thread row was created.

- [ ] **T20** `(P1)` Module wiring.
    - New `packages/agent/src/email/email-domain.module.ts` exporting the five services; imported by
      `packages/agent/src/facades/` and by `apps/api/src/email/email.module.ts`.
    - Barrel `packages/agent/src/email/index.ts`; add the sub-path export to
      `packages/agent/package.json` if the package's export map is explicit.
    - **Done**: `apps/api` boots; `pnpm --filter @ever-works/agent test` green.

### 1.5 API surface

- [ ] **T21** `(P1)` `AgentInboxController`.
    - `apps/api/src/email/agent-inbox.controller.ts` + `dto/agent-inbox.dto.ts` with the validators
      in `plan.md` §4.1. Six routes. `@Throttle` on `POST /`.
    - Register in `apps/api/src/email/email.module.ts`.
    - **Test**: `apps/api/src/email/agent-inbox.controller.spec.ts` — owner scoping, idempotent
      provisioning, `localPart` validation, the workspace-owner gate on `mode` / `dailySendCap` /
      `sendingDomainId`.

- [ ] **T22** `(P1)` `EmailThreadsController`.
    - `apps/api/src/email/email-threads.controller.ts` + `dto/email-thread.dto.ts`.
    - `GET /` with the six filters, keyset cursor and per-filter counts; `GET /:id`; `PATCH /:id`.
    - **Test**: `apps/api/src/email/email-threads.controller.spec.ts` — each filter returns the right
      set, the cursor round-trips, a foreign `inboxId` returns the same 404 as a missing one.

- [ ] **T23** `(P1)` Message lifecycle routes on the existing controller.
    - `apps/api/src/email/email.controller.ts`: add `approve`, `revise`, `discard`, `read`.
      **Declare them before the existing `messages/:id` route** — the file already carries a
      route-order note for `messages/stream`; extend that comment.
    - Add `@Throttle({ long: { ttl: 60_000, limit: 30 } })` to the existing `POST /api/email/messages`
      (closing the "no throttle on compose" gap) and optional `saveAsDraft` to `SendMessageInput` in
      `apps/api/src/email/email.service.ts`.
    - **Test**: extend `apps/api/src/email/email.controller.spec.ts` with the 409 bodies for the
      approval race and the revise ceiling, plus a case proving the throttle decorator is present.

- [ ] **T24** `(P1)` `EmailRulesController`.
    - `apps/api/src/email/email-rules.controller.ts` + `dto/email-rule.dto.ts`.
    - Five routes including `GET /blocked`. Workspace-owner gate on writes; activity-log emit on
      every write (FR-59). Enforce the 500-per-workspace / 200-per-inbox ceilings server-side.
    - **Test**: `apps/api/src/email/email-rules.controller.spec.ts`.

### 1.6 Web surface

- [ ] **T25** `(P1)` Route constants and shell entries.
    - `apps/web/src/lib/constants.ts`: add `DASHBOARD_EMAIL`, `DASHBOARD_EMAIL_THREAD`,
      `DASHBOARD_EMAIL_COMPOSE`, `DASHBOARD_AGENT_INBOX`, `SETTINGS_EMAIL_DOMAINS`.
    - `apps/web/src/components/dashboard/DashboardSidebar.tsx`: one `navigation` entry after the
      existing `inbox` entry. Remove nothing.
    - `apps/web/src/components/dashboard/SidebarEmailBadge.tsx`: copy the structure of
      `SidebarInboxBadge.tsx` (30s poll).
    - `apps/web/src/components/agents/AgentDetailTabs.tsx`: append the `inbox` tab — this alone
      closes the orphan-route gap.
    - **Done**: the Agent Inbox page is reachable by clicking, not only by typing a URL.

- [ ] **T26** `(P1)` Data plumbing.
    - `apps/web/src/lib/api/agent-inboxes.ts` and `apps/web/src/lib/api/email-threads.ts` —
      server-only `serverFetch`, `X-Scope-Slug` attached, mirroring
      `apps/web/src/lib/api/email-addresses.ts`.
    - `apps/web/src/app/actions/dashboard/email.ts` — the read server actions.
    - BFF route handlers under `apps/web/src/app/api/email/`: `threads/route.ts`,
      `messages/[id]/approve/route.ts`, `.../revise/route.ts`, `.../discard/route.ts`.
      Each copies the token handling in `apps/web/src/app/api/email/messages/route.ts` exactly —
      `getAuthAccessCookie()`, 401 on no token, never expose the token to the browser.
    - **Test**: `apps/web/src/app/api/email/threads/route.unit.spec.ts` asserts the 401 path and that
      no `Set-Cookie` leaks.

- [ ] **T27** `(P1)` `useEmailStream` — the hook the SSE endpoint never got.
    - `apps/web/src/components/email/useEmailStream.ts`: `EventSource` against
      `/api/email/messages/stream`, `mutate()` per event, exponential-backoff reconnect (1s → 30s),
      a 30-second polling fallback when `EventSource` is unavailable or the stream errors twice.
    - **Done**: a new inbound message appears within 30s with no manual refresh (FR-20).

- [ ] **T28** `(P1)` The Email screen shell.
    - `apps/web/src/app/[locale]/(dashboard)/email/page.tsx` (RSC entry) and
      `apps/web/src/components/email/EmailScreen.tsx` (`'use client'`).
    - `InboxSwitcher.tsx`, `EmailFilterBar.tsx`, `ThreadList.tsx`, `ThreadRow.tsx`.
    - URL state `?inbox=&filter=&thread=`; six filters; keyset "Load more".
    - All copy from `dashboard.email.*` keys — zero hard-coded strings.
    - **Done**: matches the wireframe in `spec.md` §6.1 including the per-filter empty states and
      the skeleton/error states in §6.2.

- [ ] **T29** `(P1)` Thread view and message cards.
    - `apps/web/src/components/email/ThreadView.tsx`, `MessageCard.tsx`,
      `SanitizedHtmlBody.tsx` (sandboxed `<iframe srcDoc>` with `sandbox=""`, remote images stripped
      behind **Load images** — this is the posture the comments in
      `apps/web/src/components/agents/MessageDetail.tsx` already demand), quoted-history disclosure,
      the Run link and the sticky cap footer.
    - **Done**: no path renders inbound HTML via `dangerouslySetInnerHTML` (FR-19).

- [ ] **T30** `(P1)` The draft card and its controls.
    - `apps/web/src/components/email/DraftCard.tsx`, `SendGraceToast.tsx`, `ReviseDialog.tsx`,
      `VersionHistory.tsx`.
    - Inline editor, the four controls, the 5-second Undo grace, the stale banner and its second
      confirmation, the `alreadyApproved` 409 handling, the revision counter.
    - **Done**: matches `spec.md` §6.3 and §6.4 exactly, including every copy string.

- [ ] **T31** `(P1)` The escalation card.
    - `apps/web/src/components/email/EscalationCard.tsx` — reason, decision-needed, Dismiss (with
      its confirmation), Instruct (deep-links into the Agent's chat with the thread referenced), and
      the **Also in My Decisions** link.
    - **Done**: matches `spec.md` §6.5.

- [ ] **T32** `(P1)` Inbox settings.
    - `apps/web/src/components/email/InboxSettingsSheet.tsx` with four sections, plus
      `CapMeter.tsx` and `RulesTable.tsx`.
    - Identity (address editor, previous-address notice), Standing instructions (8,000-char counter,
      edit history disclosure), Rules & lists (table, allow-list-mode radio, the precedence
      explainer, the Blocked view link), Sending limits (three bars, the cap field, the workspace
      line, the "enforced at send" note).
    - Auto-send confirmation dialog with the exact copy from `spec.md` §6.8.
    - **Done**: matches `spec.md` §6.8; read-only collaborators see disabled controls with the
      `a11y.readOnly` tooltip.

- [ ] **T33** `(P1)` Compose.
    - `apps/web/src/app/[locale]/(dashboard)/email/compose/page.tsx` +
      `apps/web/src/components/email/ComposeSheet.tsx`.
    - Send-as selector with the live cap line, to/cc/bcc, blocked-recipient inline error, Save as
      draft. The legacy `agents/[id]/inbox/compose` page and `Composer.tsx` stay untouched.
    - **Done**: matches `spec.md` §6.7; a send from here counts against the Agent's cap (FR-34),
      proven by an e2e assertion on the meter.

- [ ] **T34** `(P1)` Keyboard affordances and accessibility.
    - `apps/web/src/components/email/useEmailShortcuts.ts` implementing the full table in
      `spec.md` §6.10, with a `?` overlay listing them.
    - Status badges carry text, never colour alone; countdown announced at 1h / 10m / 1m only;
      full `Tab` order.
    - **Done**: `apps/web/e2e/accessibility-email.spec.ts` passes axe and walks every shortcut.

### 1.7 i18n, telemetry, tests

- [ ] **T35** `(P1)` i18n keys.
    - Add the complete `dashboard.email.*` tree from `plan.md` §8 to
      `apps/web/messages/en.json`, plus `dashboard.sidebar.navigation.email`,
      `dashboard.sidebar.emailUnread` and `dashboard.agentsPage.tabs.inbox`.
    - Mirror the key tree into all 20 sibling locale files in `apps/web/messages/`
      (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh`).
    - **Hard rule**: every leaf key name is camelCase and contains **no literal dot**. A dotted leaf
      is rejected by next-intl at runtime and the hydration spec turns that into a five-shard e2e
      failure.
    - Leave `notifications-v2.*` untouched.
    - **Done**: `pnpm --filter web lint` green; no missing-key console error in any locale; a grep
      for `"[a-z]+\.[a-z]" *:` in the new subtree returns nothing.

- [ ] **T36** `(P1)` Activity log, notifications and Sentry.
    - Emit every action type from T3 through `ActivityLogService` with ids only — never bodies.
    - Register the six notification events with the FR-83 defaults in
      `packages/agent/src/notifications/notification.service.ts` and the preferences surface.
    - Sentry tags and breadcrumbs per `plan.md` §9.2; assert in a spec that no subject, body or
      address local part is attached.
    - **Done**: a cap refusal and a rule block are both visible in the Activity feed with the actor
      and the matched rule.

- [ ] **T37** `(P1)` End-to-end specs, wave one.
    - `apps/web/e2e/flow-agent-inbox-provisioning.spec.ts`
    - `apps/web/e2e/flow-email-draft-approve.spec.ts`
    - `apps/web/e2e/flow-email-draft-revise.spec.ts`
    - `apps/web/e2e/flow-email-escalation.spec.ts`
    - `apps/web/e2e/flow-email-rules-precedence.spec.ts`
    - `apps/web/e2e/flow-email-send-cap.spec.ts`
    - `apps/web/e2e/flow-email-unified-view.spec.ts`
    - `apps/web/e2e/sec-email-inbox-cross-tenant.spec.ts`
    - Use role-based locators sparingly and prefer stable `data-testid` for list rows — `*ByRole` is
      the known flake source in this suite under CI load.
    - **Done**: all eight green locally and in CI; the five pre-existing email specs
      (`notifications-v2-inbox`, `flow-agent-inbox-messaging`, `flow-email-addresses-deep`,
      `email-bounce-handling`, `sec-pin-email-agent-ownership`) still green untouched — that is the
      proof this epic is additive.

- [ ] **T38** `(P1)` P1 close-out.
    - Update `docs/specs/features/agent-workspace/TRACKER.md`: AW-05 spec `Draft`, impl `PR open`.
    - Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
    - **Done**: all green; `develop` shippable with drafts, escalations, rules and caps live, and no
      Schedule button rendered anywhere (P1 hides it rather than disabling it).

---

## Phase 2 — later and elsewhere

- [ ] **T39** `(P2)` Scheduled-send domain logic.
    - `packages/agent/src/email/email-schedule.service.ts` — `schedule`, `cancel`, `reschedule`,
      `fire`. Enforce the 60-second minimum lead, the 90-day horizon and the 200-outstanding
      ceiling. Reserve capacity via the existing cap-guard accounting (a `scheduled` row already
      counts — no extra bookkeeping).
    - `cancel` is `casTransition('scheduled' → 'draft')`; 0 rows affected → 409 `TooLate`.
    - **Test**: `packages/agent/src/email/__tests__/email-schedule.service.spec.ts` including the
      cancel/fire race.

- [ ] **T40** `(P2)` Scheduled-send job.
    - Declare `EMAIL_SCHEDULED_SEND_DISPATCHER` in `packages/agent/src/email/email-schedule.service.ts`
      and re-export from `packages/agent/src/facades/index.ts`.
    - Bind it in `packages/tasks/src/trigger/trigger.module.ts` using the exact
      `JobRuntimeProviderRegistry` factory shape the `NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER`
      binding uses, including the `?.()` opt-out guard.
    - `packages/tasks/src/tasks/trigger/email-scheduled-send.task.ts` — enqueued with `delay`,
      CAS-guarded, provider `messageRef` reused.
    - `packages/tasks/src/tasks/trigger/email-scheduled-send-sweeper.task.ts` — cron `*/5 * * * *`,
      re-enqueues anything overdue by 2 minutes.
    - Register both in `packages/tasks/src/tasks/trigger/index.ts`.
    - **No call site imports `@trigger.dev/sdk`** (Constitution IV).
    - **Done**: running the task twice for one message sends once (FR-49), proven by a spec.

- [ ] **T41** `(P2)` Scheduled-send API + UI.
    - `apps/api/src/email/email.controller.ts`: `POST /messages/:id/schedule`,
      `POST /messages/:id/cancel-send`, `POST /messages/:id/retry`; DTO validators per
      `plan.md` §4.3. Controller spec extended.
    - `apps/web/src/components/email/ScheduledCard.tsx` (one `setInterval` per view, not per card)
      and the `Schedule…` control on `DraftCard.tsx`; the Scheduled filter becomes populated.
    - **Test**: `apps/web/e2e/flow-email-scheduled-send.spec.ts`.

- [ ] **T42** `(P2)` Sending-domain plugin capability.
    - `packages/plugin/src/contracts/capabilities/email-provider.interface.ts`: add
      `EmailSendingDomainRecord`, `EmailSendingDomainStatus` and the two **optional** methods.
    - `packages/plugin/src/contracts/facade-capabilities.ts`: add `EMAIL_SENDING_DOMAIN` and
      `EMAIL_SCHEDULED_SEND` capability strings.
    - Implement `describeSendingDomain` / `verifySendingDomain` in `packages/plugins/postmark/src/`
      and `packages/plugins/mailgun/src/`, declaring the new capability in each
      `package.json` `everworks.plugin` block.
    - **Test**: `packages/plugins/postmark/src/postmark.sending-domain.spec.ts` and the Mailgun
      equivalent (Vitest) — SPF/DKIM/DMARC/MX records returned, the four states mapped, a provider
      error becomes `failureReason` rather than a throw.
    - **Done**: optional methods mean every other plugin still compiles (Constitution X).

- [ ] **T43** `(P2)` Sending-domain service, endpoints and sweeper.
    - `packages/agent/src/email/email-sending-domain.service.ts` — add / verify / assign / remove,
      the 15-minute cadence, the 288-attempt give-up, the 24-hour re-verify of verified domains, and
      the fallback-on-removal path (FR-74).
    - `apps/api/src/email/email-domains.controller.ts` + DTOs + `GET /:id/impact`.
    - `packages/tasks/src/tasks/trigger/email-domain-verify-sweeper.task.ts`, cron `*/5 * * * *`,
      wrapped in `DistributedTaskLockService.runExclusive`; registered in
      `packages/tasks/src/tasks/trigger/index.ts`.
    - `apps/web/src/app/[locale]/(dashboard)/settings/integrations/email-domains/page.tsx` +
      `apps/web/src/components/email/SendingDomainsSettings.tsx` — the records table with copy
      buttons, the purpose explainer, the failed state, the remove-impact dialog.
    - The domain resolver must never name a plugin: ask the facade, then feature-detect the method;
      if absent, render `domains.unsupported`.
    - **Test**: `apps/api/src/email/email-domains.controller.spec.ts`,
      `packages/agent/src/email/__tests__/email-sending-domain.service.spec.ts`,
      `apps/web/e2e/flow-email-domain-verify.spec.ts`.

- [ ] **T44** `(P2)` The maintenance sweeper.
    - `packages/tasks/src/tasks/trigger/email-draft-staleness-sweeper.task.ts`, cron `17 3 * * *`
      (off-the-hour so it does not collide with the per-minute crons or `anonymous-user-cleanup`).
    - Does four things: 7-day draft warning, 14-day auto-discard, `email_rules.matchCount7d` roll,
      and expiry of address aliases plus blocked-mail past 30 days.
    - Registered in `packages/tasks/src/tasks/trigger/index.ts`.
    - **Test**: `packages/agent/src/email/__tests__/email-maintenance.service.spec.ts` with a frozen
      clock at each boundary.

- [ ] **T45** `(P2)` Fix the tenant-address verification loop.
    - `packages/email-templates/src/components/address-verification.tsx` + export from
      `packages/email-templates/src/index.ts`.
    - `apps/api/src/email/email.service.ts` `triggerVerification`: persist the token the plugin
      returns instead of discarding it, and actually send the verification message through
      `EmailFacadeService.send`.
    - **Done**: the pre-existing `GET /api/email/verify/:token` endpoint becomes reachable by a real
      user for the first time; `apps/web/e2e/flow-email-verification-deep.spec.ts` extended.

- [ ] **T46** `(P2)` Bounce handling.
    - In the delivery-event path in `apps/api/src/email/email.controller.ts` /
      `packages/agent/src/facades/email.facade.ts`: surface the provider reason on the card, count
      hard bounces per inbox, and at 3 in 24 hours force `mode='draft-review'`, notify the owner and
      log `EMAIL_MODE_CHANGED` with the reason.
    - **Done**: `apps/web/e2e/email-bounce-handling.spec.ts` extended, still green.

- [ ] **T47** `(P2)` P2 close-out — tracker, format, lint, type-check, test, build.

---

## Phase 3 — depth

- [ ] **T48** `(P3)` `describeSendingDomain` / `verifySendingDomain` on
      `packages/plugins/resend/src/` and `packages/plugins/sendgrid/src/`.
- [ ] **T49** `(P3)` Declare `EMAIL_INBOUND` on `packages/plugins/sendgrid/src/` via its Inbound
      Parse API, closing the long-standing inbound-coverage shortfall (2 of 5 providers today).
- [ ] **T50** `(P3)` One-click DNS publish. Extend `DnsRecordType` in
      `packages/plugin/src/contracts/capabilities/dns.interface.ts` with `'TXT'` and `'MX'`, implement
      in `packages/plugins/cloudflare-dns/src/`, and add a **Publish for me** button to the records
      table when a DNS connection covers the zone. Additive to the union; audit every existing switch
      on `DnsRecordType` first.
- [ ] **T51** `(P3)` Attachment content: storage, download endpoint, outbound attachments —
      currently metadata-only per `spec.md` §7.
- [ ] **T52** `(P3)` Body search behind a real index rather than `ILIKE`.
- [ ] **T53** `(P3)` "Learn from my edits" consolidation against AW-07's memory load meter —
      cap style facts per Agent and consolidate older ones. Blocked on AW-07 confirming the mechanism.
- [ ] **T54** `(P3)` Restore action on the Blocked view ("this was not spam, deliver it") with a
      one-click rule correction.

---

## Definition of done

- Every checkbox above for the phases being shipped.
- All new tests green locally and in CI; **all five pre-existing email e2e specs still green,
  untouched** — the additivity proof.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` all green.
- Every `[NEEDS CLARIFICATION: …]` in `spec.md` §9 either answered in the spec or explicitly
  deferred with a linked follow-up issue.
- Every acceptance-criteria line in `spec.md` §8 checked off by a reviewer against a running build.
- `docs/specs/features/agent-workspace/TRACKER.md` updated; `spec.md` status moved to
  `Implemented`; `plan.md` and `tasks.md` moved to `Done`.
- `docs/plugin-system/built-in-plugins.md` updated with the two new capability strings against the
  five email providers (Constitution VIII — the canonical doc, and only that doc).
