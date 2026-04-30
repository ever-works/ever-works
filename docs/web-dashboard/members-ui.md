---
id: members-ui
title: Team Members Interface
sidebar_label: Members UI
sidebar_position: 17
---

# Team Members Interface

The Members UI provides directory-level team management, allowing directory owners and managers to invite collaborators, assign roles, update permissions, and remove members. Access control is enforced through a role-based permission system.

## Component Hierarchy

```
MembersPage
  |
  +-- Header section
  |     +-- Title & subtitle
  |     +-- "Invite Member" button (if canManageMembers)
  |
  +-- MembersList
  |     +-- Owner row (always first, with "Creator" badge)
  |     +-- MemberRow (for each member)
  |           +-- Avatar (first letter)
  |           +-- Username & email
  |           +-- Role selector (Select) or role badge
  |           +-- Remove button (trash icon)
  |           +-- Confirm Remove Dialog
  |
  +-- InviteMemberDialog
        +-- Email input
        +-- Role selector (Select)
        +-- Role description panel
        +-- Submit / Cancel buttons
```

## Key Components

### MembersPage

**File**: `apps/web/src/components/directories/detail/members/MembersPage.tsx`

The top-level container that manages the members list state and coordinates the invite dialog.

```typescript
interface MembersPageProps {
	directory: Directory;
	members: DirectoryMember[];
	owner: DirectoryOwner;
}
```

**State Management**:

- `members` state is initialized from `initialMembers` prop and updated locally on add/remove/update
- `inviteDialogOpen` controls the invite modal visibility
- `canInvite` is derived from `canManageMembers(directory.userRole)`

**Callback Handlers**:

- `handleMemberAdded(member)` -- appends the new member to the list
- `handleMemberRemoved(memberId)` -- filters the member from the list
- `handleMemberUpdated(updated)` -- replaces the member entry in the list

### MembersList

**File**: `apps/web/src/components/directories/detail/members/MembersList.tsx`

Renders the owner row followed by all member rows in a bordered card with dividers.

```typescript
interface MembersListProps {
	directory: Directory;
	members: DirectoryMember[];
	owner: DirectoryOwner;
	onMemberRemoved: (memberId: string) => void;
	onMemberUpdated: (member: DirectoryMember) => void;
}
```

The owner is always displayed at the top with a highlighted background and a "Creator" badge pill. If there are no members, a centered empty state message is shown.

### MemberRow

**File**: `apps/web/src/components/directories/detail/members/MemberRow.tsx`

Renders a single member with inline role management and removal capabilities.

```typescript
interface MemberRowProps {
	directoryId: string;
	member: DirectoryMember;
	canManage: boolean;
	onRemoved: () => void;
	onUpdated: (member: DirectoryMember) => void;
}
```

**Role Change Flow**:

1. Manager selects a new role from the inline `Select` dropdown
2. `updateMemberRole(directoryId, memberId, newRole)` server action is called
3. On success, `onUpdated` callback propagates the change to `MembersPage`
4. Toast notification confirms the update

**Member Removal Flow**:

1. Manager clicks the trash icon button
2. A confirmation `Dialog` opens with the member's username
3. On confirm, `removeMember(directoryId, memberId)` server action is called
4. On success, `onRemoved` callback removes the member from the list
5. Toast notification confirms removal

### InviteMemberDialog

**File**: `apps/web/src/components/directories/detail/members/InviteMemberDialog.tsx`

A modal form for inviting new members by email with a role assignment.

```typescript
interface InviteMemberDialogProps {
	directoryId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onMemberAdded: (member: DirectoryMember) => void;
}
```

**Form Fields**:

| Field | Type   | Validation             |
| ----- | ------ | ---------------------- |
| Email | Input  | Required, email format |
| Role  | Select | Default: `VIEWER`      |

**Available Roles**:

| Role      | Label   | Description                                              |
| --------- | ------- | -------------------------------------------------------- |
| `VIEWER`  | Viewer  | Can view directory content and settings (read-only)      |
| `EDITOR`  | Editor  | Can edit items, categories, and content                  |
| `MANAGER` | Manager | Can manage members, settings, and all directory features |

The dialog displays a contextual description panel below the role selector that updates dynamically based on the selected role.

**Submission Flow**:

1. User enters email and selects role
2. Form validation checks for non-empty email
3. `inviteMember(directoryId, email, role)` server action is called
4. On success: toast notification, form reset, dialog closes, `onMemberAdded` callback fires
5. On failure: inline error message displayed below the email field

## Role-Based Permissions

The `canManageMembers` utility from `@/lib/permissions` determines whether the current user can manage team members:

| User Role | Can Invite | Can Change Roles | Can Remove Members | Sees Role Selector |
| --------- | ---------- | ---------------- | ------------------ | ------------------ |
| Owner     | Yes        | Yes              | Yes                | Yes (Select)       |
| Manager   | Yes        | Yes              | Yes                | Yes (Select)       |
| Editor    | No         | No               | No                 | No (badge only)    |
| Viewer    | No         | No               | No                 | No (badge only)    |

When `canManage` is `false`, the role is displayed as a static badge rather than an interactive selector, and the remove button is hidden.

## State Management Patterns

```
MembersPage (state owner)
  |
  |-- members: DirectoryMember[]        // local state, initialized from server
  |-- inviteDialogOpen: boolean          // dialog visibility
  |
  +-- MembersList (stateless display)
  |     |
  |     +-- MemberRow (local state for isUpdating, isRemoving, confirmRemoveOpen)
  |
  +-- InviteMemberDialog (local form state: email, role, isSubmitting, error)
```

All server mutations go through Next.js server actions. Optimistic updates are applied locally to avoid full-page refreshes, maintaining a responsive feel.

## Related API Endpoints

| Action        | Server Action Function                          | HTTP Method |
| ------------- | ----------------------------------------------- | ----------- |
| Invite member | `inviteMember(directoryId, email, role)`        | POST        |
| Update role   | `updateMemberRole(directoryId, memberId, role)` | PATCH       |
| Remove member | `removeMember(directoryId, memberId)`           | DELETE      |

## Internationalization

All strings use `next-intl` with the namespace `dashboard.directoryDetail.members`:

- `title`, `subtitle` -- page header
- `inviteMember` -- invite button label
- `roles.creator`, `roles.viewer`, `roles.editor`, `roles.manager` -- role labels
- `roleDescriptions.viewer`, `roleDescriptions.editor`, `roleDescriptions.manager` -- role descriptions
- `invite.*` -- invite dialog labels and messages
- `confirmRemove.*` -- removal confirmation dialog
- `noMembers` -- empty state message

## Cross-References

- [Deployment UI](./deployment-ui.md) -- members need appropriate roles to trigger deployments
- [Items Management UI](./items-ui.md) -- editors and above can manage directory items
- [Schedule UI](./schedule-ui.md) -- schedule management permissions
