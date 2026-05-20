# Ever Works E2E expansion — implementation plan

State at 2026-05-20: E2E is RED on the most recent commits (duplicate-test-title regression
in `api-malformed-authorization-header.spec.ts` from PRs #876/#877). Restore green first,
then build out the feature backlog below.

## Order

### Step 0 — restore E2E to green

- [ ] Fix `api-malformed-authorization-header.spec.ts:34` duplicate test title (same pattern
      as `f6b119d3`). Push, confirm suite green.

### Step 1 — feature work (user-approved scope)

- [ ] **1a — Webhook subscriptions** (CRUD + HMAC delivery + retry). New module:
      `apps/api/src/webhooks/`. Entity already exists (`WebhookSubscription`). Add service +
      controller + delivery worker. E2E specs unblock `webhook-delivery-retry`,
      `webhook-subscriptions`, `webhook-redelivery`, `webhook-secret-rotation`.

- [ ] **1b — Public `/api/config`**. Strict allow-list of public flags + branding + version.
      Add e2e tests pinning shape + no-leak. Unblocks `feature-flags-runtime.spec.ts`.

- [ ] **1c — `/api/uploads` file uploads**. Multipart, auth-gated, MIME-checked,
      size-capped, user-scoped storage path. Unblocks `image-uploads`, `media-mime-sniffing`.

- [ ] **1d — JIRA ticket for team/org membership** (no code work, just a ticket in the
      Ever Works JIRA project).

- [ ] **1e — Queue tech audit**. Confirm whether platform uses BullMQ. If yes, implement
      `/api/works/:id/queue-status`. If only Trigger.dev, document + skip.

- [ ] **1f — Magic-link auth** via Better Auth plugin. Server endpoints + login-page option
      to choose password / magic / social. E2E coverage of the full flow with MailHog.

- [ ] **1g — Work-proposal preferences**. Diagnose 404 in test env. Likely a missing
      default-row seed.

- [ ] **1h — Plugin device-auth path alignment**. One-liner to either alias the controller
      or update the spec list.

- [ ] **1i — Item bulk-\* operations**. `/api/works/:id/items/bulk-delete|update|publish`.
      Auth + ownership gates, batch cap. E2E specs.

- [ ] **1j — Activity-log seed on registration**. Listener on `UserCreatedEvent` writes
      `account.created` row.

### Step 2 — test-side path drift audit

- [ ] Walk every remaining `'no X exposed'` skip, map to actual mounted route, update spec
      candidate list. Same template as the webhook fix in `eb8fd35f`.

### Step 3 — environment-conditional follow-ups

- [ ] Where reasonable, harden specs against slow first-compile / fixture gaps.

## Rules

- Every commit ends with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Push directly to develop (user-approved for this task).
- Don't push when prettier complains on changed files.
- Don't bypass hooks (no `--no-verify`).
- Security: any new public endpoint MUST require auth (default), validate input via
  class-validator DTOs, refuse to echo secrets in responses, and be rate-limited.

## Progress log

(filled in as we go)
