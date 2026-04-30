---
id: directory-members
title: Directory Members & Ownership
sidebar_label: Members & Ownership
sidebar_position: 8
---

# Directory Members & Ownership

The member and ownership services implement role-based access control (RBAC) for directories. Together, `DirectoryMemberService` and `DirectoryOwnershipService` manage who can access a directory and what they can do.

**Sources:**

- `packages/agent/src/services/directory-member.service.ts`
- `packages/agent/src/services/directory-ownership.service.ts`

## Role Hierarchy

Ever Works uses a four-level role hierarchy:

| Role      | Level | Permissions                                                        |
| --------- | ----- | ------------------------------------------------------------------ |
| `OWNER`   | 4     | Full control: delete directory, manage members, edit, view         |
| `MANAGER` | 3     | Manage members (invite, update roles, remove), edit, view          |
| `EDITOR`  | 2     | Edit content (generate items, update settings, manage repos), view |
| `VIEWER`  | 1     | Read-only access to all directory data                             |

The directory **creator** always has `OWNER` level access, even without an explicit membership record. This is enforced at the service level, not via database records.

## DirectoryOwnershipService

This service provides the authorization layer used by all other directory services.

### Access Check Methods

| Method                                            | Minimum Role | Used By             |
| ------------------------------------------------- | ------------ | ------------------- |
| `ensureAccess(directoryId, userId, minimumRole?)` | Configurable | Base method         |
| `ensureCanView(directoryId, userId)`              | VIEWER       | Query operations    |
| `ensureCanEdit(directoryId, userId)`              | EDITOR       | Generation, updates |
| `ensureCanManageMembers(directoryId, userId)`     | MANAGER      | Member management   |
| `ensureIsOwner(directoryId, userId)`              | OWNER        | Directory deletion  |

### DirectoryAccessResult

Every access check returns a detailed result:

```typescript
interface DirectoryAccessResult {
	directory: Directory; // The directory entity
	member: DirectoryMember | null; // Membership record (null for creators)
	role: DirectoryMemberRole; // Resolved role
	isCreator: boolean; // Whether user created the directory
}
```

### How Access Is Determined

1. **Find directory** -- Queries `directoryRepository.findById()`. Throws `NotFoundException` if not found.
2. **Check creator** -- If `directory.userId === userId`, the user is the creator and gets `OWNER` role.
3. **Check membership** -- For non-creators, queries `directoryMemberRepository.findMember()`.
4. **Verify role level** -- If a `minimumRole` is specified, checks that the user's role meets or exceeds it.

```typescript
private roleIsAtLeast(role: DirectoryMemberRole, minimumRole: DirectoryMemberRole): boolean {
    const roleHierarchy: Record<DirectoryMemberRole, number> = {
        [DirectoryMemberRole.OWNER]: 4,
        [DirectoryMemberRole.MANAGER]: 3,
        [DirectoryMemberRole.EDITOR]: 2,
        [DirectoryMemberRole.VIEWER]: 1,
    };
    return roleHierarchy[role] >= roleHierarchy[minimumRole];
}
```

### Non-Throwing Helpers

```typescript
// Returns true/false without throwing
const canAccess = await ownershipService.hasAccess(directoryId, userId);

// Returns the role or null
const role = await ownershipService.getUserRole(directoryId, userId);
```

## DirectoryMemberService

This service manages explicit membership records for directories.

### Listing Members

```typescript
const members = await memberService.listMembers(directoryId, userId);
```

Requires **Viewer** access. Returns an array of `DirectoryMemberDto`:

```typescript
interface DirectoryMemberDto {
	id: string;
	userId: string;
	username: string;
	email: string;
	avatar?: string;
	role: DirectoryMemberRole;
	invitedBy?: {
		id: string;
		username: string;
	};
	createdAt: string;
}
```

### Inviting Members

```typescript
const result = await memberService.inviteMember(directoryId, userId, {
	email: 'collaborator@example.com',
	role: DirectoryMemberRole.EDITOR
});
```

Requires **Manager** access. The invitation flow:

1. **Validate role** -- Only `VIEWER`, `EDITOR`, and `MANAGER` can be assigned. `OWNER` is reserved for the creator.
2. **Find invitee** -- Looks up the user by email. Throws `NotFoundException` if not found.
3. **Prevent self-invite** -- Cannot add the directory creator as a member.
4. **Prevent duplicates** -- Checks for existing membership.
5. **Create membership** -- Adds the member with the specified role and records the inviter.
6. **Return result** -- Includes the member DTO, invitee user, inviter user, and directory for downstream use (e.g., sending invitation emails).

```typescript
interface InviteMemberResult {
	member: DirectoryMemberDto;
	invitee: User;
	inviter: User;
	directory: Directory;
}
```

### Updating Member Roles

```typescript
const updated = await memberService.updateMemberRole(directoryId, userId, memberId, {
	role: DirectoryMemberRole.MANAGER
});
```

Requires **Manager** access. Validates the new role is assignable (viewer, editor, or manager).

### Removing Members

```typescript
await memberService.removeMember(directoryId, userId, memberId);
```

Requires **Manager** access. Verifies the member belongs to the specified directory before removal.

### Leaving a Directory

```typescript
await memberService.leaveDirectory(directoryId, userId);
```

Allows a member to remove themselves. The directory **creator cannot leave** -- this prevents orphaned directories.

### Getting Member Details

```typescript
const member = await memberService.getMember(directoryId, userId, memberId);
```

Requires **Viewer** access. Returns a single `DirectoryMemberDto`.

### Getting Owner Info

```typescript
const owner = await memberService.getDirectoryOwnerInfo(directoryId, userId);
// { id, username, email, avatar }
```

Returns the directory creator's basic profile information.

## Access Patterns Across Services

Here is how the role system integrates across the agent services:

| Service                    | Operation                | Required Role      |
| -------------------------- | ------------------------ | ------------------ |
| DirectoryLifecycleService  | `createDirectory`        | Authenticated user |
| DirectoryLifecycleService  | `updateDirectory`        | Editor             |
| DirectoryLifecycleService  | `syncFromDataRepository` | Editor             |
| DirectoryLifecycleService  | `deleteDirectory`        | Owner              |
| DirectoryGenerationService | `generateItems`          | Editor             |
| DirectoryGenerationService | `submitItem`             | Editor             |
| DirectoryGenerationService | `removeItem`             | Editor             |
| DirectoryQueryService      | `getDirectories`         | Authenticated      |
| DirectoryQueryService      | `getDirectory`           | Viewer             |
| DirectoryQueryService      | `directoryItems`         | Viewer             |
| DirectoryQueryService      | `updateWebsiteSettings`  | Editor             |
| DirectoryScheduleService   | `getSchedule`            | Viewer             |
| DirectoryScheduleService   | `updateSchedule`         | Editor             |
| DirectoryScheduleService   | `cancelSchedule`         | Editor             |
| DirectoryMemberService     | `listMembers`            | Viewer             |
| DirectoryMemberService     | `inviteMember`           | Manager            |
| DirectoryMemberService     | `updateMemberRole`       | Manager            |
| DirectoryMemberService     | `removeMember`           | Manager            |

## Error Responses

| Condition                           | Exception             | Message                                                                |
| ----------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| Directory not found                 | `NotFoundException`   | Directory with id 'X' not found                                        |
| No access (not creator, not member) | `ForbiddenException`  | You do not have permission to access this directory                    |
| Insufficient role                   | `ForbiddenException`  | You do not have the required permission level for this action          |
| User not found (invite)             | `NotFoundException`   | User with email 'X' not found                                          |
| Duplicate member                    | `BadRequestException` | User is already a member of this directory                             |
| Invalid role assignment             | `BadRequestException` | Invalid role. Members can only be assigned: viewer, editor, or manager |
| Creator trying to leave             | `BadRequestException` | Directory creator cannot leave the directory                           |
