---
id: work-members
title: Work Members & Ownership
sidebar_label: Members & Ownership
sidebar_position: 8
---

# Work Members & Ownership

The member and ownership services implement role-based access control (RBAC) for works. Together, `WorkMemberService` and `WorkOwnershipService` manage who can access a work and what they can do.

**Sources:**

- `packages/agent/src/services/work-member.service.ts`
- `packages/agent/src/services/work-ownership.service.ts`

## Role Hierarchy

Ever Works uses a four-level role hierarchy:

| Role      | Level | Permissions                                                        |
| --------- | ----- | ------------------------------------------------------------------ |
| `OWNER`   | 4     | Full control: delete work, manage members, edit, view         |
| `MANAGER` | 3     | Manage members (invite, update roles, remove), edit, view          |
| `EDITOR`  | 2     | Edit content (generate items, update settings, manage repos), view |
| `VIEWER`  | 1     | Read-only access to all work data                             |

The work **creator** always has `OWNER` level access, even without an explicit membership record. This is enforced at the service level, not via database records.

## WorkOwnershipService

This service provides the authorization layer used by all other work services.

### Access Check Methods

| Method                                            | Minimum Role | Used By             |
| ------------------------------------------------- | ------------ | ------------------- |
| `ensureAccess(workId, userId, minimumRole?)` | Configurable | Base method         |
| `ensureCanView(workId, userId)`              | VIEWER       | Query operations    |
| `ensureCanEdit(workId, userId)`              | EDITOR       | Generation, updates |
| `ensureCanManageMembers(workId, userId)`     | MANAGER      | Member management   |
| `ensureIsOwner(workId, userId)`              | OWNER        | Work deletion  |

### WorkAccessResult

Every access check returns a detailed result:

```typescript
interface WorkAccessResult {
	work: Work; // The work entity
	member: WorkMember | null; // Membership record (null for creators)
	role: WorkMemberRole; // Resolved role
	isCreator: boolean; // Whether user created the work
}
```

### How Access Is Determined

1. **Find work** -- Queries `workRepository.findById()`. Throws `NotFoundException` if not found.
2. **Check creator** -- If `work.userId === userId`, the user is the creator and gets `OWNER` role.
3. **Check membership** -- For non-creators, queries `workMemberRepository.findMember()`.
4. **Verify role level** -- If a `minimumRole` is specified, checks that the user's role meets or exceeds it.

```typescript
private roleIsAtLeast(role: WorkMemberRole, minimumRole: WorkMemberRole): boolean {
    const roleHierarchy: Record<WorkMemberRole, number> = {
        [WorkMemberRole.OWNER]: 4,
        [WorkMemberRole.MANAGER]: 3,
        [WorkMemberRole.EDITOR]: 2,
        [WorkMemberRole.VIEWER]: 1,
    };
    return roleHierarchy[role] >= roleHierarchy[minimumRole];
}
```

### Non-Throwing Helpers

```typescript
// Returns true/false without throwing
const canAccess = await ownershipService.hasAccess(workId, userId);

// Returns the role or null
const role = await ownershipService.getUserRole(workId, userId);
```

## WorkMemberService

This service manages explicit membership records for works.

### Listing Members

```typescript
const members = await memberService.listMembers(workId, userId);
```

Requires **Viewer** access. Returns an array of `WorkMemberDto`:

```typescript
interface WorkMemberDto {
	id: string;
	userId: string;
	username: string;
	email: string;
	avatar?: string;
	role: WorkMemberRole;
	invitedBy?: {
		id: string;
		username: string;
	};
	createdAt: string;
}
```

### Inviting Members

```typescript
const result = await memberService.inviteMember(workId, userId, {
	email: 'collaborator@example.com',
	role: WorkMemberRole.EDITOR
});
```

Requires **Manager** access. The invitation flow:

1. **Validate role** -- Only `VIEWER`, `EDITOR`, and `MANAGER` can be assigned. `OWNER` is reserved for the creator.
2. **Find invitee** -- Looks up the user by email. Throws `NotFoundException` if not found.
3. **Prevent self-invite** -- Cannot add the work creator as a member.
4. **Prevent duplicates** -- Checks for existing membership.
5. **Create membership** -- Adds the member with the specified role and records the inviter.
6. **Return result** -- Includes the member DTO, invitee user, inviter user, and work for downstream use (e.g., sending invitation emails).

```typescript
interface InviteMemberResult {
	member: WorkMemberDto;
	invitee: User;
	inviter: User;
	work: Work;
}
```

### Updating Member Roles

```typescript
const updated = await memberService.updateMemberRole(workId, userId, memberId, {
	role: WorkMemberRole.MANAGER
});
```

Requires **Manager** access. Validates the new role is assignable (viewer, editor, or manager).

### Removing Members

```typescript
await memberService.removeMember(workId, userId, memberId);
```

Requires **Manager** access. Verifies the member belongs to the specified work before removal.

### Leaving a Work

```typescript
await memberService.leaveWork(workId, userId);
```

Allows a member to remove themselves. The work **creator cannot leave** -- this prevents orphaned works.

### Getting Member Details

```typescript
const member = await memberService.getMember(workId, userId, memberId);
```

Requires **Viewer** access. Returns a single `WorkMemberDto`.

### Getting Owner Info

```typescript
const owner = await memberService.getWorkOwnerInfo(workId, userId);
// { id, username, email, avatar }
```

Returns the work creator's basic profile information.

## Access Patterns Across Services

Here is how the role system integrates across the agent services:

| Service                    | Operation                | Required Role      |
| -------------------------- | ------------------------ | ------------------ |
| WorkLifecycleService  | `createWork`        | Authenticated user |
| WorkLifecycleService  | `updateWork`        | Editor             |
| WorkLifecycleService  | `syncFromDataRepository` | Editor             |
| WorkLifecycleService  | `deleteWork`        | Owner              |
| WorkGenerationService | `generateItems`          | Editor             |
| WorkGenerationService | `submitItem`             | Editor             |
| WorkGenerationService | `removeItem`             | Editor             |
| WorkQueryService      | `getWorks`         | Authenticated      |
| WorkQueryService      | `getWork`           | Viewer             |
| WorkQueryService      | `workItems`         | Viewer             |
| WorkQueryService      | `updateWebsiteSettings`  | Editor             |
| WorkScheduleService   | `getSchedule`            | Viewer             |
| WorkScheduleService   | `updateSchedule`         | Editor             |
| WorkScheduleService   | `cancelSchedule`         | Editor             |
| WorkMemberService     | `listMembers`            | Viewer             |
| WorkMemberService     | `inviteMember`           | Manager            |
| WorkMemberService     | `updateMemberRole`       | Manager            |
| WorkMemberService     | `removeMember`           | Manager            |

## Error Responses

| Condition                           | Exception             | Message                                                                |
| ----------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| Work not found                 | `NotFoundException`   | Work with id 'X' not found                                        |
| No access (not creator, not member) | `ForbiddenException`  | You do not have permission to access this work                    |
| Insufficient role                   | `ForbiddenException`  | You do not have the required permission level for this action          |
| User not found (invite)             | `NotFoundException`   | User with email 'X' not found                                          |
| Duplicate member                    | `BadRequestException` | User is already a member of this work                             |
| Invalid role assignment             | `BadRequestException` | Invalid role. Members can only be assigned: viewer, editor, or manager |
| Creator trying to leave             | `BadRequestException` | Work creator cannot leave the work                           |
