# Implementation Plan: Work Members

**Feature ID**: `work-members`
**Spec**: `./spec.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## 1. Architecture

```mermaid
flowchart LR
    Req[POST /members] --> Auth[JWT]
    Auth --> Perm[ensureCanManage]
    Perm --> Lookup[UserRepository.findByEmail]
    Lookup --> Insert[work_memberships row]
    Insert --> Mail[MailService.sendInviteEmail]
    Insert --> Resp[Return member DTO]
```

## 2. Tech Choices

| Concern          | Choice                                 | Rationale                              |
| ---------------- | -------------------------------------- | -------------------------------------- |
| Permission model | Static role matrix in code             | Closed enum; matrix is small           |
| Auth check       | `WorkOwnershipService.ensureCan*` | Single source of truth across features |
| Notification     | Mail facade                            | Extensible to in-app notifications     |
| Invite mechanism | Direct (no pending tokens)             | Simpler UX for collaborators           |

## 3. Data Model

```ts
@Entity('work_memberships')
@Index(['workId', 'userId'], { unique: true })
export class WorkMembership {
	@PrimaryGeneratedColumn('uuid') id: string;
	@Column() workId: string;
	@Column() userId: string;
	@Column({ type: 'varchar' }) role: 'manager' | 'editor' | 'viewer';
	@Column() invitedBy: string;
	@CreateDateColumn() createdAt: Date;
}
```

Migration: additive, with composite unique index `(workId, userId)`.

## 4. API Surface

| Method   | Endpoint                                 | Required role    |
| -------- | ---------------------------------------- | ---------------- |
| `GET`    | `/api/works/:id/members`           | viewer           |
| `POST`   | `/api/works/:id/members`           | manager / owner  |
| `GET`    | `/api/works/:id/members/:memberId` | viewer           |
| `PUT`    | `/api/works/:id/members/:memberId` | manager / owner  |
| `DELETE` | `/api/works/:id/members/:memberId` | manager / owner  |
| `POST`   | `/api/works/:id/members/leave`     | non-owner member |

## 5. Plugin / Web / CLI

- Plugins: none.
- Web: **Settings → Members** UI with the role matrix and invite form.
- CLI: not exposed.

## 6. Background Jobs

None — invite emails are sent inline.

## 7. Security & Permissions

- Every endpoint runs through `WorkOwnershipService`'s
  `ensureCanRead` / `ensureCanEdit` / `ensureCanManage` helpers.
- The Owner role is checked separately because it's implicit on
  `works.userId`.

## 8. Observability

Activity log: `member_invited`, `member_role_updated`, `member_removed`,
`member_left` with the affected user id and role.

## 9. Risks & Mitigations

| Risk                                | Mitigation                                              |
| ----------------------------------- | ------------------------------------------------------- |
| Race: two managers invite same user | Unique index `(workId, userId)` rejects the second |
| Owner accidentally locked out       | Owner role is implicit and immutable                    |
| Permission cache lag                | Permission checks read fresh from DB                    |

## 10. Constitution Reconciliation

See `spec.md` §9.

## 11. References

- Spec: `./spec.md`
- Implementation:
    - `apps/api/src/works/members/`
    - `packages/agent/src/services/work-members.service.ts`
    - `packages/agent/src/services/work-ownership.service.ts`
