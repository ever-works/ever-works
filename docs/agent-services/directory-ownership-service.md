---
id: directory-ownership-service
title: "DirectoryOwnershipService Deep Dive"
sidebar_label: "Directory Ownership"
sidebar_position: 13
---

# DirectoryOwnershipService Deep Dive

## Overview

The `DirectoryOwnershipService` provides centralized access control for directories, enforcing role-based permissions across the platform. It determines whether a user can view, edit, manage members, or own a directory by checking both creator status and membership records. Nearly every directory operation in the system delegates authorization to this service.

## Architecture

This service acts as a cross-cutting authorization layer used by all directory-related services. It sits between API controllers and domain services, ensuring no operation proceeds without proper access verification.

```
Any Service / Controller
        |
        v
DirectoryOwnershipService.ensureAccess(directoryId, userId, minimumRole?)
        |
        +-- DirectoryRepository.findById()
        |
        +-- Check if user is creator (userId === directory.userId)
        |       |
        |       YES --> Return OWNER role
        |       NO  --> DirectoryMemberRepository.findMember()
        |                |
        |                +-- Member found --> Check role hierarchy
        |                +-- No member   --> Throw ForbiddenException
        |
        v
DirectoryAccessResult { directory, member, role, isCreator }
```

### Role Hierarchy

The service enforces a four-level role hierarchy:

| Role | Level | Capabilities |
|------|-------|-------------|
| `OWNER` | 4 | Full control, can delete directory |
| `MANAGER` | 3 | Can manage members and settings |
| `EDITOR` | 2 | Can modify directory content |
| `VIEWER` | 1 | Read-only access |

## API Reference

### Methods

#### `ensureAccess(directoryId, userId, minimumRole?)`

The core authorization method. Verifies a user has at least the specified minimum role.

| Parameter | Type | Description |
|-----------|------|-------------|
| `directoryId` | `string` | The directory to check |
| `userId` | `string` | The user requesting access |
| `minimumRole` | `DirectoryMemberRole` (optional) | Minimum required role level |

**Returns:** `Promise<DirectoryAccessResult>`

**Throws:**
- `NotFoundException` if the directory does not exist
- `ForbiddenException` if the user lacks access or the required role level

```typescript
interface DirectoryAccessResult {
    directory: Directory;
    member: DirectoryMember | null;  // null for creators
    role: DirectoryMemberRole;
    isCreator: boolean;
}
```

#### `ensureCanView(directoryId, userId)`

Shorthand for `ensureAccess(directoryId, userId, DirectoryMemberRole.VIEWER)`.

#### `ensureCanEdit(directoryId, userId)`

Shorthand for `ensureAccess(directoryId, userId, DirectoryMemberRole.EDITOR)`.

#### `ensureCanManageMembers(directoryId, userId)`

Shorthand for `ensureAccess(directoryId, userId, DirectoryMemberRole.MANAGER)`.

#### `ensureIsOwner(directoryId, userId)`

Shorthand for `ensureAccess(directoryId, userId, DirectoryMemberRole.OWNER)`.

#### `hasAccess(directoryId, userId)`

Non-throwing access check. Returns `true` if the user has any level of access, `false` otherwise.

| Parameter | Type | Description |
|-----------|------|-------------|
| `directoryId` | `string` | The directory to check |
| `userId` | `string` | The user to check |

**Returns:** `Promise<boolean>`

#### `getUserRole(directoryId, userId)`

Returns the user's role in a directory without throwing exceptions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `directoryId` | `string` | The directory to check |
| `userId` | `string` | The user to check |

**Returns:** `Promise<DirectoryMemberRole | null>` -- `null` if no access.

## Implementation Details

### Creator Privilege

The directory creator (identified by `directory.userId`) always receives `OWNER`-level access regardless of membership records. This is checked before any membership lookups, making it the fast path for the most common case.

### Role Comparison

The `roleIsAtLeast()` helper uses a numeric hierarchy map to compare roles:

```typescript
const roleHierarchy: Record<DirectoryMemberRole, number> = {
    OWNER: 4,
    MANAGER: 3,
    EDITOR: 2,
    VIEWER: 1,
};
```

A role satisfies a minimum requirement when its numeric value is greater than or equal to the minimum role's value.

### Non-Throwing Pattern

The `hasAccess()` method wraps `ensureAccess()` in a try-catch, returning a boolean. This pattern is useful for conditional UI rendering or optional permission checks without disrupting control flow.

## Database Interactions

| Repository | Method | Purpose |
|------------|--------|---------|
| `DirectoryRepository` | `findById(directoryId)` | Load the directory entity to check creator status |
| `DirectoryMemberRepository` | `findMember(directoryId, userId)` | Look up membership record for non-creator users |

## Event System

This service does not emit or consume any events. It is a pure authorization service.

## Error Handling

| Scenario | Exception | HTTP Status |
|----------|-----------|-------------|
| Directory not found | `NotFoundException` | 404 |
| User not creator and not a member | `ForbiddenException` | 403 |
| User role below minimum requirement | `ForbiddenException` | 403 |

All exceptions include structured error bodies with `status: 'error'` and a descriptive `message`.

## Usage Examples

```typescript
// Check editor access before modifying taxonomy
const { directory } = await this.ownershipService.ensureCanEdit(directoryId, userId);

// Non-throwing check for conditional logic
const canAccess = await this.ownershipService.hasAccess(directoryId, userId);
if (canAccess) {
    // show directory in list
}

// Get role for UI rendering
const role = await this.ownershipService.getUserRole(directoryId, userId);
if (role === DirectoryMemberRole.OWNER) {
    // show delete button
}

// Full access result with member info
const result = await this.ownershipService.ensureAccess(directoryId, userId);
console.log(result.isCreator);  // true if they created it
console.log(result.role);       // 'owner', 'manager', 'editor', or 'viewer'
```

## Configuration

This service has no configuration. Role hierarchy is hardcoded as it represents a fundamental domain invariant.

## Related Services

- [Directory Members](/agent-services/directory-members) -- manages membership CRUD, delegates auth to this service
- [Directory Taxonomy](/agent-services/directory-taxonomy-service) -- uses `ensureCanEdit` for category/tag modifications
- [Directory Advanced Prompts](/agent-services/directory-advanced-prompts) -- uses `ensureCanEdit` and `ensureAccess` for prompt management
