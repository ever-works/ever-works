---
id: work-ownership-service
title: 'WorkOwnershipService Deep Dive'
sidebar_label: 'Work Ownership'
sidebar_position: 13
---

# WorkOwnershipService Deep Dive

## Overview

The `WorkOwnershipService` provides centralized access control for works, enforcing role-based permissions across the platform. It determines whether a user can view, edit, manage members, or own a work by checking both creator status and membership records. Nearly every work operation in the system delegates authorization to this service.

## Architecture

This service acts as a cross-cutting authorization layer used by all work-related services. It sits between API controllers and domain services, ensuring no operation proceeds without proper access verification.

```
Any Service / Controller
        |
        v
WorkOwnershipService.ensureAccess(workId, userId, minimumRole?)
        |
        +-- WorkRepository.findById()
        |
        +-- Check if user is creator (userId === work.userId)
        |       |
        |       YES --> Return OWNER role
        |       NO  --> WorkMemberRepository.findMember()
        |                |
        |                +-- Member found --> Check role hierarchy
        |                +-- No member   --> Throw ForbiddenException
        |
        v
WorkAccessResult { work, member, role, isCreator }
```

### Role Hierarchy

The service enforces a four-level role hierarchy:

| Role      | Level | Capabilities                       |
| --------- | ----- | ---------------------------------- |
| `OWNER`   | 4     | Full control, can delete work |
| `MANAGER` | 3     | Can manage members and settings    |
| `EDITOR`  | 2     | Can modify work content       |
| `VIEWER`  | 1     | Read-only access                   |

## API Reference

### Methods

#### `ensureAccess(workId, userId, minimumRole?)`

The core authorization method. Verifies a user has at least the specified minimum role.

| Parameter     | Type                             | Description                 |
| ------------- | -------------------------------- | --------------------------- |
| `workId` | `string`                         | The work to check      |
| `userId`      | `string`                         | The user requesting access  |
| `minimumRole` | `WorkMemberRole` (optional) | Minimum required role level |

**Returns:** `Promise<WorkAccessResult>`

**Throws:**

- `NotFoundException` if the work does not exist
- `ForbiddenException` if the user lacks access or the required role level

```typescript
interface WorkAccessResult {
	work: Work;
	member: WorkMember | null; // null for creators
	role: WorkMemberRole;
	isCreator: boolean;
}
```

#### `ensureCanView(workId, userId)`

Shorthand for `ensureAccess(workId, userId, WorkMemberRole.VIEWER)`.

#### `ensureCanEdit(workId, userId)`

Shorthand for `ensureAccess(workId, userId, WorkMemberRole.EDITOR)`.

#### `ensureCanManageMembers(workId, userId)`

Shorthand for `ensureAccess(workId, userId, WorkMemberRole.MANAGER)`.

#### `ensureIsOwner(workId, userId)`

Shorthand for `ensureAccess(workId, userId, WorkMemberRole.OWNER)`.

#### `hasAccess(workId, userId)`

Non-throwing access check. Returns `true` if the user has any level of access, `false` otherwise.

| Parameter     | Type     | Description            |
| ------------- | -------- | ---------------------- |
| `workId` | `string` | The work to check |
| `userId`      | `string` | The user to check      |

**Returns:** `Promise<boolean>`

#### `getUserRole(workId, userId)`

Returns the user's role in a work without throwing exceptions.

| Parameter     | Type     | Description            |
| ------------- | -------- | ---------------------- |
| `workId` | `string` | The work to check |
| `userId`      | `string` | The user to check      |

**Returns:** `Promise<WorkMemberRole | null>` -- `null` if no access.

## Implementation Details

### Creator Privilege

The work creator (identified by `work.userId`) always receives `OWNER`-level access regardless of membership records. This is checked before any membership lookups, making it the fast path for the most common case.

### Role Comparison

The `roleIsAtLeast()` helper uses a numeric hierarchy map to compare roles:

```typescript
const roleHierarchy: Record<WorkMemberRole, number> = {
	OWNER: 4,
	MANAGER: 3,
	EDITOR: 2,
	VIEWER: 1
};
```

A role satisfies a minimum requirement when its numeric value is greater than or equal to the minimum role's value.

### Non-Throwing Pattern

The `hasAccess()` method wraps `ensureAccess()` in a try-catch, returning a boolean. This pattern is useful for conditional UI rendering or optional permission checks without disrupting control flow.

## Database Interactions

| Repository                  | Method                            | Purpose                                           |
| --------------------------- | --------------------------------- | ------------------------------------------------- |
| `WorkRepository`       | `findById(workId)`           | Load the work entity to check creator status |
| `WorkMemberRepository` | `findMember(workId, userId)` | Look up membership record for non-creator users   |

## Event System

This service does not emit or consume any events. It is a pure authorization service.

## Error Handling

| Scenario                            | Exception            | HTTP Status |
| ----------------------------------- | -------------------- | ----------- |
| Work not found                 | `NotFoundException`  | 404         |
| User not creator and not a member   | `ForbiddenException` | 403         |
| User role below minimum requirement | `ForbiddenException` | 403         |

All exceptions include structured error bodies with `status: 'error'` and a descriptive `message`.

## Usage Examples

```typescript
// Check editor access before modifying taxonomy
const { work } = await this.ownershipService.ensureCanEdit(workId, userId);

// Non-throwing check for conditional logic
const canAccess = await this.ownershipService.hasAccess(workId, userId);
if (canAccess) {
	// show work in list
}

// Get role for UI rendering
const role = await this.ownershipService.getUserRole(workId, userId);
if (role === WorkMemberRole.OWNER) {
	// show delete button
}

// Full access result with member info
const result = await this.ownershipService.ensureAccess(workId, userId);
console.log(result.isCreator); // true if they created it
console.log(result.role); // 'owner', 'manager', 'editor', or 'viewer'
```

## Configuration

This service has no configuration. Role hierarchy is hardcoded as it represents a fundamental domain invariant.

## Related Services

- [Work Members](/agent-services/work-members) -- manages membership CRUD, delegates auth to this service
- [Work Taxonomy](/agent-services/work-taxonomy-service) -- uses `ensureCanEdit` for category/tag modifications
- [Work Advanced Prompts](/agent-services/work-advanced-prompts) -- uses `ensureCanEdit` and `ensureAccess` for prompt management
