# Feature Specification: Per-Agent Inbox UI

**Feature ID**: `agent-inbox-ui`
**Branch**: `feat/notifications-v2-multichannel` (umbrella)
**Status**: `Draft`
**Jira Epic**: TBD (sibling of [EW-650](https://evertech.atlassian.net/browse/EW-650))
**Created**: 2026-05-28
**Last updated**: 2026-05-28
**Owner**: Product (Ruslan)
**Related code today**:

- API surface this UI consumes: [`../email-providers/spec.md`](../email-providers/spec.md)
- Existing per-Agent detail page: `apps/web/src/app/[locale]/(app)/agents/[id]/`
- Existing settings layout: `apps/web/src/app/[locale]/(app)/settings/`
- shadcn/ui registry: `apps/web/components.json`

> **Scope of this document:** the **web app** surfaces for per-Agent inboxes — list view, message detail, composer with React-Email preview, and the tenant-level Address Management wizard. The backend (entities, plugin contract, send mechanics) lives in [`email-providers`](../email-providers/spec.md); this spec owns only what users see and click.
>
> **Hard rule (additive only):** no existing agent-detail tab or settings page is removed. The Inbox tab + the Notification Channels settings page are _added_ alongside.

---

## 1. Personas + use cases

| Persona  | Use case                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Operator | Opens Agent "Support Triage" → Inbox tab → sees recent inbound emails, can click into a message and read the full thread.                  |
| Operator | Compose a one-off email from the Agent's outbound address using the rich composer; pick a React-Email template and preview before sending. |
| Operator | Manage tenant email addresses under Settings → Integrations → Emails — add Postmark address, verify, assign to one or more Agents.         |
| Operator | Manage tenant notification channels under Settings → Integrations → Channels — add Discord webhook, test, assign for which events.         |

---

## 2. Routes + page map

| Route                             | Owns                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `/settings/integrations/emails`   | Tenant email addresses (list + add wizard) — consumed from `email-providers`. |
| `/settings/integrations/channels` | Tenant notification channels — consumed from `notification-channels`.         |
| `/agents/[id]` → new "Inbox" tab  | Per-Agent inbox: assigned addresses, inbound + outbound message list.         |
| `/agents/[id]/inbox/[messageId]`  | Per-message detail (full body, thread context if conversation mode).          |
| `/agents/[id]/inbox/compose`      | New-message composer (React-Email preview pane on the right).                 |
| `/settings/notifications`         | Event-subscriptions matrix — consumed from `event-subscriptions`.             |

---

## 3. Component inventory

### 3.1 React-Email rendering

- Install **`@react-email/components`** (for templates) + **`@react-email/render`** (server-side) in `apps/web` (used by the preview pane only; outbound rendering happens in `apps/api`).
- Preview pane: `<iframe srcDoc={renderedHtml} sandbox="" />` to isolate template styles from app chrome.

### 3.2 shadcn/ui pieces used

- `Table` for inbox list and addresses list.
- `Sheet` for the add-address wizard (4-step) and add-channel wizard (3-step).
- `Form` + `Field` + `FieldGroup` (per `.claude/skills/shadcn/rules/forms.md`).
- `Dialog` for "Test send" + "Send confirmation".
- `Tabs` for inbox vs identity vs assignments on the agent detail page.
- `Card` for the per-channel test-result panel.

### 3.3 Composer

- **Subject** input.
- **To / CC / BCC** chip multi-input with `tenant_email_addresses` autocomplete (for agent-to-agent) and free-form email entry (for external recipients).
- **Body**: rich-text Markdown editor (reuse the existing one from Tasks). Optional: switch to "Template mode" which presents the template's Zod-derived form and renders the React-Email output live.
- **Send** button → `POST /api/email/messages` with `from` defaulted to the Agent's primary outbound assignment.
- **Save Draft** persists to `email_messages` with `direction='outbound'` + `sentAt=null`.

### 3.4 Per-Agent inbox tab

- Left rail: list of assigned addresses (highlights the one currently filtered).
- Center: paginated message list (50/page, max 100). Columns: `from`/`to`, `subject`, `direction` chip, `receivedAt`/`sentAt`.
- Right: selected-message preview (collapsed to chip mode on narrow viewports).

### 3.5 Add-address wizard (under Settings → Integrations → Emails)

Mirrors spec §2.1 of [`email-providers`](../email-providers/spec.md):

1. Direction (Outbound / Inbound / Both)
2. Provider (filtered by capability)
3. Address + provider-specific settings (with DNS-check + webhook URL display)
4. Verification (test email or DNS poll)

---

## 4. Data flow

```
UI -- SWR hook --> GET /api/email/messages?agentId=X&direction=inbound --
   <-- 50 rows + pagination cursor

User clicks "Send"
UI --> POST /api/email/messages {from, to, subject, body[Text|Html], template?}
   <-- 201 with messageId
UI optimistically inserts the row, then revalidates list
```

Live updates: the inbox tab subscribes to a server-sent-events channel `/api/email/messages/stream?agentId=X` for inbound notifications, so new messages appear without manual refresh. (Falls back to 30s SWR poll if SSE not supported.)

---

## 5. Empty / error states

- **No addresses configured.** Inbox tab shows an empty state with a "Configure email addresses" CTA linking to Settings → Integrations → Emails.
- **No assignments for this Agent.** Inbox tab shows "This agent has no email assignments yet" + "Assign address" CTA inline.
- **Provider verification pending.** Address row shows a yellow chip + "Resend verification" action.
- **Provider delivery error.** Outbound message row shows a red chip + tooltip with the error; "Retry" action available.

---

## 6. Accessibility

- Compose dialog focus-traps with `Escape` to close + "discard?" confirm if dirty.
- All table actions are keyboard-reachable; visible focus ring; aria-labels per row action.
- Per `.claude/skills/accessibility/SKILL.md` WCAG 2.2: 4.5:1 contrast on all chips, screen-reader-announced live region for new inbound mail.

---

## 7. Out of scope (v1)

- **Search** across inbox messages. Filter by direction/agent is in v1; full-text search lands in v2.
- **Bulk actions** (multi-select + archive/delete). v1 is one-at-a-time.
- **Drag-drop attachments** into the composer (the existing Task attachment uploader is reused; attachment field accepts file picker only).
- **Side-by-side dual inbox view** (compare two agents' inboxes). Not in v1.
- **Mobile-optimised composer.** Desktop-first; mobile renders a stacked layout but no dedicated mobile UX.

---

## 8. Acceptance criteria

- [ ] Operator can land on Settings → Integrations → Emails and complete the 4-step add-address wizard for Postmark.
- [ ] Operator can land on an Agent detail page, click Inbox tab, see assigned addresses + paginated message list.
- [ ] Composer opens, accepts rich-text body, sends via the Agent's outbound address; sent message appears in list within 5s.
- [ ] Inbound webhook delivery is reflected in the inbox list within 5s (SSE).
- [ ] React-Email template picker renders a live preview as form fields change.
- [ ] All routes pass `pnpm lint` + `pnpm type-check`.
- [ ] Playwright E2E smoke covers the happy path of opening the inbox + sending a message (mocked provider).

---

## 9. Constitution gates

- [x] **I** Plugin-first — UI consumes the plugin-backed API surfaces, no plugin-specific UI branches.
- [x] **II** Capability-driven — provider picker is data-driven from the plugin registry.
- [x] **III–V** N/A (no DB schema).
- [x] **VI** Tests — Playwright E2E + unit tests for composer state.
- [x] **VII** Secret hygiene — never log full message bodies on the client; redact in browser console traces.
- [x] **VIII** N/A.
- [x] **IX** Behaviour-first — spec defines clickable surfaces.
- [x] **X** Backwards-compat — purely additive UI; no existing routes removed.

---

## 10. References

- Sibling specs: [`email-providers`](../email-providers/spec.md), [`notification-channels`](../notification-channels/spec.md), [`event-subscriptions`](../event-subscriptions/spec.md)
- React-Email docs: https://react.email/docs/introduction
- Novu React widget: https://docs.novu.co/inbox/react/get-started
- Plan: [`plan.md`](./plan.md)
- Tasks: [`tasks.md`](./tasks.md)
