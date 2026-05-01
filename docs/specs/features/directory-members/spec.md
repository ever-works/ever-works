# Feature Specification: Directory Members

**Feature ID**: `directory-members`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

Directory Members lets the directory owner invite collaborators with
role-based access: **Manager** (can invite/remove members and edit
content), **Editor** (can edit content but not manage members),
**Viewer** (read-only). Invitations are direct — the invited user must
already have an Ever Works account, and membership becomes effective
immediately when the invite endpoint succeeds. The Owner role is
implicit (the directory creator), cannot be reassigned, and never
appears in the members list.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I'm the Owner or a Manager, **when** I `POST` to the
  members endpoint with an existing user's email and a role,
  **then** the user becomes a member immediately and receives an
  email notification linking back to the directory.
- **Given** I'm a Viewer, **when** I open the directory, **then** I
  can see items, taxonomy, and the member list, but action buttons
  for editing/generation/management are disabled.
- **Given** I'm an Editor, **when** I edit an item or trigger a
  generation, **then** the action succeeds; **when** I try to
  invite a member, **then** I get `403 Forbidden`.
- **Given** I no longer want to be part of a directory, **when** I
  `POST` to the leave endpoint, **then** my membership row is
  deleted and the directory disappears from my dashboard.

### 2.2 Edge cases & failures

- **Given** I try to invite the directory creator, **when** the
  server checks ownership, **then** the request is rejected with
  `400` ("cannot invite the directory owner").
- **Given** the email I invite doesn't have an Ever Works account,
  **when** the lookup fails, **then** I get `404` ("no registered
  user found for that email") — invitations are direct, not pending.
- **Given** I try to assign role `owner`, **when** the validator
  checks the role, **then** the request is rejected with `400`
  (ownership cannot be reassigned).
- **Given** the user is already a member, **when** I try to invite
  again, **then** I get `400` ("already a member").
- **Given** I'm the Owner, **when** I try to leave my own directory,
  **then** the request is rejected with `400` ("owner cannot
  leave"). Ownership is non-transferable; the only way out is to
  delete the directory.

## 3. Functional Requirements

- **FR-1** The system MUST support exactly four role values:
  `owner` (implicit), `manager`, `editor`, `viewer`.
- **FR-2** The Owner role MUST be implicit (set at directory
  creation) and MUST NOT appear in the members list.
- **FR-3** Ownership MUST NOT be transferable.
- **FR-4** Member invitations MUST require the invitee to already
  have an Ever Works account; no pending/accept flow.
- **FR-5** The server MUST send an email notification to the new
  member with the directory name, role, and a link.
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

## 4. Non-Functional Requirements

- **Performance**: member endpoints respond in P95 < 200 ms.
- **Reliability**: race conditions between invite and remove resolve
  deterministically (last writer wins; the API returns the resulting
  state).
- **Security & privacy**: every endpoint enforces the role check
  server-side; UI is the same as a defence in depth.
- **Observability**: activity-log entries for invite, role change,
  remove, leave.
- **Compatibility**: role enum is closed; new roles would require an
  additive enum change.

## 5. Key Entities & Domain Concepts

| Entity / concept      | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `DirectoryMembership` | Row with `userId`, `directoryId`, `role`, `invitedBy`, `createdAt` |
| Owner                 | Implicit membership equal to `directory.userId`; never in the list |
| Permission matrix     | Action → role mapping (see user-facing doc table)                  |
| Invite                | Synchronous — succeeds or fails, no pending state                  |

## 6. Out of Scope

- Pending invitations / accept tokens (today: direct).
- Public link sharing (today: explicit per-user invitations only).
- Custom roles beyond the four built-ins.
- Group / org membership (today: per-user only).
- Ownership transfer.

## 7. Acceptance Criteria

- [x] Four roles with the documented permission matrix.
- [x] Owner is implicit and never appears in the members list.
- [x] Ownership is non-transferable.
- [x] Invite requires existing Ever Works account.
- [x] Email notification sent on invite.
- [x] Owner cannot leave own directory.
- [x] Tests cover every cell of the permission matrix.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: N/A.
- [x] **II**: N/A.
- [x] **III**: members are platform-side metadata, not in the data repo
      (membership is about access to platform features, not content).
- [x] **IV**: invitation email is sent inline; no background job needed.
- [x] **V**: `directory_memberships` table is additive.
- [x] **VI**: covered by `directory-members.service.spec.ts` + e2e.
- [x] **VII**: no secret leakage; emails are PII but not credentials.
- [x] **VIII**: N/A.
- [x] **IX**: behaviour-first.
- [x] **X**: role enum is additive; APIs are stable.

## 10. References

- User-facing doc: [`../../../features/directory-members.md`](../../../features/directory-members.md)
- API ref: [`../../../api/authentication.md`](../../../api/authentication.md)
- Implementation: `apps/api/src/directories/members/`,
  `packages/agent/src/services/directory-members.service.ts`
