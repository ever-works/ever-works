# Feature Specification: Work Members

**Feature ID**: `work-members`
**Status**: `Shipped`
**Created**: 2026-05-01
**Last updated**: 2026-05-21
**Owner**: Ever Works Team

> **Note (2026-05-21, EW-632 close-out).** This feature shipped in two
> phases. The original direct-invite flow (this spec, sections 1–5)
> landed before 2026-05-01. The tokenised-claim flow on top of it
> shipped via PR #687 / EW-600 on 2026-05-11 — see section 5.1 below.
> EW-632 was filed by E2E automation that mistook the controllers
> for stubs; the work was already done.

---

## 1. Overview

Work Members lets a work owner invite collaborators with role-based
access: **Manager** (can invite/remove members and edit content),
**Editor** (can edit content but not manage members), **Viewer**
(read-only). The Owner role is implicit (the work creator) and never
appears in the members list.

Two invitation flows coexist:

- **Direct invite** (sections 1–5 — original flow): owner POSTs an
  email + role to `/api/works/:id/members`; the invitee must already
  have an Ever Works account; membership becomes effective immediately.
- **Tokenised claim** (section 5.1 — added by EW-600): owner POSTs to
  `/api/works/:id/invitations`; the API returns a single-use claim
  URL; the recipient (account-holder or not — they can register on
  the claim page) consumes the token via `POST /api/claim/accept` to
  create the membership. The same endpoint also supports
  `owner-claim` for transferring ownership of imported works.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I'm the Owner or a Manager, **when** I `POST` to the
  members endpoint with an existing user's email and a role,
  **then** the user becomes a member immediately and receives an
  email notification linking back to the work.
- **Given** I'm a Viewer, **when** I open the work, **then** I
  can see items, taxonomy, and the member list, but action buttons
  for editing/generation/management are disabled.
- **Given** I'm an Editor, **when** I edit an item or trigger a
  generation, **then** the action succeeds; **when** I try to
  invite a member, **then** I get `403 Forbidden`.
- **Given** I no longer want to be part of a work, **when** I
  `POST` to the leave endpoint, **then** my membership row is
  deleted and the work disappears from my dashboard.

### 2.2 Edge cases & failures

- **Given** I try to invite the work creator, **when** the
  server checks ownership, **then** the request is rejected with
  `400` ("cannot invite the work owner").
- **Given** I try to direct-invite an email without an Ever Works
  account, **when** the lookup fails, **then** I get `404`. The
  caller should fall back to the tokenised claim flow (`POST
/api/works/:id/invitations`) for off-platform recipients.
- **Given** I try to assign role `owner` via the direct-invite
  endpoint, **when** the validator checks the role, **then** the
  request is rejected with `400` (use the `owner-claim` invitation
  role for ownership transfer).
- **Given** the user is already a member, **when** I try to invite
  again, **then** I get `400` ("already a member").
- **Given** I'm the Owner, **when** I try to leave my own work,
  **then** the request is rejected with `400` ("owner cannot
  leave"). To hand off the work, use the `owner-claim` invitation
  flow (section 5.1).

## 3. Functional Requirements

- **FR-1** The system MUST support exactly four role values:
  `owner` (implicit), `manager`, `editor`, `viewer`.
- **FR-2** The Owner role MUST be implicit (set at work
  creation) and MUST NOT appear in the members list.
- **FR-3** Ownership MAY be transferred only via the `owner-claim`
  invitation flow (section 5.1). The direct-invite endpoint MUST
  reject role `owner`.
- **FR-4** The direct-invite endpoint MUST require the invitee to
  already have an Ever Works account; the tokenised-claim endpoint
  MAY accept arbitrary emails (recipients register at claim time
  if needed).
- **FR-5** The server MUST send an email notification on invite:
  the direct flow sends a "you've been added" notification, the
  tokenised flow sends a claim-link email with the single-use URL.
- **FR-6** Manager and Owner roles MUST be allowed to
  invite/remove/update other members.
- **FR-7** Editor role MUST be allowed to edit content (items,
  taxonomy, settings) and trigger generation; MUST NOT be allowed
  to manage members.
- **FR-8** Viewer role MUST be allowed to read everything visible to
  members; MUST NOT be allowed to mutate anything.
- **FR-9** The `leave` endpoint MUST allow Manager / Editor / Viewer
  members to remove themselves; MUST reject Owner attempts.
- **FR-10** The List Members endpoint MUST return the owner
  separately from the members array.
- **FR-11** Role updates MUST be effective immediately (cached
  permission checks must invalidate or be short-lived).
- **FR-12** Tokenised invitations MUST be single-use: a token that
  has been consumed (status `accepted`) MUST be rejected on
  subsequent claim attempts with a 4xx. Tokens MUST expire after at
  most 90 days (default 30); expired tokens MUST be rejected.

## 4. Non-Functional Requirements

- **Performance**: member endpoints respond in P95 < 200 ms.
- **Reliability**: race conditions between invite and remove resolve
  deterministically (last writer wins; the API returns the resulting
  state). Tokenised claim acceptance uses CAS-based status
  transitions so concurrent claim/revoke races resolve to a single
  winner.
- **Security & privacy**: every endpoint enforces the role check
  server-side; UI is the same as a defence in depth. Claim tokens
  are stored as sha256 hashes at rest and compared in constant time.
  The public `/api/claim/preview` endpoint is throttled per-IP
  (10/min) to make brute-forcing truncated tokens infeasible.
- **Observability**: activity-log entries for invite, role change,
  remove, leave (`MEMBER_INVITED`, `MEMBER_ROLE_CHANGED`,
  `MEMBER_REMOVED` action types).
- **Compatibility**: role enum is closed; new roles would require an
  additive enum change.

## 5. Key Entities & Domain Concepts

| Entity / concept  | Description                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| `WorkMember`      | Row in `work_members`: `workId`, `userId`, `role`, `invitedById`, etc. |
| `WorkInvitation`  | Row in `work_invitations`: tokenised pending invite (see §5.1).        |
| Owner             | Implicit membership equal to `work.userId`; never in the list.         |
| Permission matrix | Action → role mapping (see user-facing doc table).                     |
| Direct invite     | Synchronous — succeeds or fails, no pending state.                     |
| Tokenised claim   | Asynchronous — pending until consumed via `POST /api/claim/accept`.    |

### 5.1 Tokenised claim flow (EW-600, shipped 2026-05-11)

`POST /api/works/:workId/invitations` issues a `WorkInvitation` with
a random 32-byte token. The raw token is returned ONCE in the
response (`claimUrl` field, format `${webAppUrl}/claim/${token}`);
the server stores only the sha256 hash. Subsequent reads of the
invitation never expose the token again.

Recipients consume the token via the public claim endpoints in
`apps/api/src/onboarding/claim.controller.ts`:

- `GET  /api/claim/preview?token=...` — public, throttled (10/min/IP),
  read-only. Returns `{ workName, role, expiresAt,
expectedProviderUsername?, sourceUrl? }`.
- `POST /api/claim/accept` — authenticated, throttled. Body:
  `{ token }`. On success creates a `WorkMember` row (member roles)
  or transfers `work.userId` (owner-claim role) via CAS, and marks
  the invitation `accepted`.

Invitation roles are `manager | editor | viewer | owner-claim`. The
`owner-claim` role additionally requires
`metadata.expectedProviderUsername` (the git host login that must
match at claim time) and may trigger a follow-up repo transfer via
the active `IGitProviderPlugin`'s `transferRepository` capability.

## 6. Out of Scope

- Public link sharing without an explicit invitation (today:
  invitation tokens go to one recipient).
- Custom roles beyond the four built-ins.
- Group / org membership — cross-Work organisations where one org
  owns multiple Works. Tracked separately: see the EW org-layer
  follow-up ticket linked from EW-632.
- SSO group sync.
- Billing-side seat management.

## 7. Acceptance Criteria

- [x] Four roles with the documented permission matrix.
- [x] Owner is implicit and never appears in the members list.
- [x] Direct-invite requires an existing Ever Works account; rejects
      role `owner`.
- [x] Tokenised-claim invitations support any email; `owner-claim`
      role transfers ownership at accept time.
- [x] Email notification sent on both invite flows.
- [x] Owner cannot leave own work.
- [x] Single-use token guarantee: re-accepting a consumed token
      returns 4xx.
- [x] Tests cover every cell of the permission matrix.
- [x] E2E covers the full invite → claim → role-change → remove
      lifecycle (see `apps/web/e2e/member-invitation-happy-path.spec.ts`).

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: N/A.
- [x] **II**: N/A.
- [x] **III**: members are platform-side metadata, not in the data repo
      (membership is about access to platform features, not content).
- [x] **IV**: invitation email is sent inline; no background job needed.
- [x] **V**: `work_members` and `work_invitations` tables are additive.
- [x] **VI**: covered by `work-member.service.spec.ts`,
      `work-invitation.service.spec.ts`, controller specs, and e2e.
- [x] **VII**: claim tokens are hashed at rest, returned once at
      creation, compared in constant time; preview endpoint is rate-limited.
- [x] **VIII**: N/A.
- [x] **IX**: behaviour-first.
- [x] **X**: role enum is additive; APIs are stable.

## 10. References

- User-facing doc: [`../../../features/work-members.md`](../../../features/work-members.md)
- API ref: [`../../../api/authentication.md`](../../../api/authentication.md)
- Implementation:
    - Controllers: `apps/api/src/works/members.controller.ts`,
      `apps/api/src/works/invitations.controller.ts`,
      `apps/api/src/onboarding/claim.controller.ts`
    - Services: `packages/agent/src/services/work-member.service.ts`,
      `packages/agent/src/services/work-invitation.service.ts`,
      `packages/agent/src/services/work-ownership.service.ts`
    - Entities: `packages/agent/src/entities/work-member.entity.ts`,
      `packages/agent/src/entities/work-invitation.entity.ts`
- E2E specs (`apps/web/e2e/`): `work-members.spec.ts`,
  `multi-user-invitation.spec.ts`,
  `invitation-token-single-use.spec.ts`,
  `member-invitation-happy-path.spec.ts`
- Tracking tickets: EW-632 (close-out), EW-600 (tokenised-claim
  flow), and the org-layer follow-up filed at EW-632 close.
