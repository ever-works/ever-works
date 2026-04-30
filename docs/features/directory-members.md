---
id: directory-members
title: Directory Members
sidebar_label: Directory Members
sidebar_position: 6
---

# Directory Members

Directory Members lets you invite collaborators to work on a directory together. Each member is assigned a role that controls what they can do — from full management down to read-only access.

## Roles

| Role | Description | Assignable? |
|------|-------------|-------------|
| **Owner** | Full access — reserved for the directory creator | No (implicit) |
| **Manager** | Can invite/remove members, edit content, trigger generation | Yes |
| **Editor** | Can edit content and items, cannot manage members | Yes |
| **Viewer** | Read-only access | Yes |

The directory creator is always the Owner and does not appear in the members list. Ownership cannot be transferred.

### Permission Matrix

| Action | Owner | Manager | Editor | Viewer |
|--------|:-----:|:-------:|:------:|:------:|
| View directory, items, and taxonomy | Yes | Yes | Yes | Yes |
| View member list | Yes | Yes | Yes | Yes |
| Edit content (items, taxonomy, settings) | Yes | Yes | Yes | — |
| Trigger AI generation | Yes | Yes | Yes | — |
| Manage schedules and advanced prompts | Yes | Yes | Yes | — |
| Invite and remove members | Yes | Yes | — | — |
| Update member roles | Yes | Yes | — | — |
| Delete the directory | Yes | — | — | — |
| Leave the directory | — | Yes | Yes | Yes |

## How Invitation Works

1. A Manager or Owner calls the invite endpoint with the collaborator's email and desired role.
2. The platform looks up the email — the user must already have an Ever Works account.
3. A membership record is created immediately (no pending/accept flow).
4. The invitee receives an email notification with the directory name, their role, and a link to the directory.

:::info
Invitations are direct — the invited user becomes a member as soon as the API call succeeds. There is no invitation token or acceptance step.
:::

## API

All endpoints require JWT authentication. Base path: `/api/directories/:directoryId/members`

### List Members

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/directories/:id/members` | List all members and the owner |

```bash
curl http://localhost:3100/api/directories/<directory-id>/members \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
  "status": "success",
  "members": [
    {
      "id": "<membership-uuid>",
      "userId": "<user-uuid>",
      "username": "alice",
      "email": "alice@example.com",
      "role": "editor",
      "invitedBy": { "id": "<user-uuid>", "username": "bob" },
      "createdAt": "2026-02-15T10:00:00.000Z"
    }
  ],
  "owner": {
    "id": "<user-uuid>",
    "username": "bob",
    "email": "bob@example.com"
  }
}
```

The `owner` field always shows the directory creator. The `members` array contains only explicit membership records (the owner is not included).

### Invite a Member

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/directories/:id/members` | Invite a user by email |

**Required role:** Manager or Owner

```bash
curl -X POST http://localhost:3100/api/directories/<directory-id>/members \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "role": "editor"
  }'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Email of the user to invite (must have an existing account) |
| `role` | string | Yes | `manager`, `editor`, or `viewer` |

**Errors:**

| Status | Reason |
|--------|--------|
| `400` | Role is `owner` or invalid |
| `400` | Email belongs to the directory creator |
| `400` | User is already a member |
| `404` | No registered user found for that email |

### Get Member

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/directories/:id/members/:memberId` | Get a single member's details |

### Update Member Role

| Method | Endpoint | Description |
|--------|----------|-------------|
| `PUT` | `/api/directories/:id/members/:memberId` | Change a member's role |

**Required role:** Manager or Owner

```bash
curl -X PUT http://localhost:3100/api/directories/<directory-id>/members/<member-id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "role": "manager" }'
```

### Remove a Member

| Method | Endpoint | Description |
|--------|----------|-------------|
| `DELETE` | `/api/directories/:id/members/:memberId` | Remove a member from the directory |

**Required role:** Manager or Owner

```bash
curl -X DELETE http://localhost:3100/api/directories/<directory-id>/members/<member-id> \
  -H "Authorization: Bearer <token>"
```

### Leave a Directory

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/directories/:id/members/leave` | Leave a directory you are a member of |

```bash
curl -X POST http://localhost:3100/api/directories/<directory-id>/members/leave \
  -H "Authorization: Bearer <token>"
```

:::warning
The directory creator (Owner) cannot leave their own directory. Only invited members can use this endpoint.
:::

## Related

- [Directories API](/api/directories) — Full endpoint reference including member management
- [Authentication](/api/authentication) — User accounts and JWT authentication
