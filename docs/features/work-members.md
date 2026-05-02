---
id: work-members
title: Work Members
sidebar_label: Work Members
sidebar_position: 6
---

# Work Members

Work Members lets you invite collaborators to work on a work together. Each member is assigned a role that controls what they can do — from full management down to read-only access.

## Roles

| Role        | Description                                                 | Assignable?   |
| ----------- | ----------------------------------------------------------- | ------------- |
| **Owner**   | Full access — reserved for the work creator                 | No (implicit) |
| **Manager** | Can invite/remove members, edit content, trigger generation | Yes           |
| **Editor**  | Can edit content and items, cannot manage members           | Yes           |
| **Viewer**  | Read-only access                                            | Yes           |

The work creator is always the Owner and does not appear in the members list. Ownership cannot be transferred.

### Permission Matrix

| Action                                   | Owner | Manager | Editor | Viewer |
| ---------------------------------------- | :---: | :-----: | :----: | :----: |
| View work, items, and taxonomy           |  Yes  |   Yes   |  Yes   |  Yes   |
| View member list                         |  Yes  |   Yes   |  Yes   |  Yes   |
| Edit content (items, taxonomy, settings) |  Yes  |   Yes   |  Yes   |   —    |
| Trigger AI generation                    |  Yes  |   Yes   |  Yes   |   —    |
| Manage schedules and advanced prompts    |  Yes  |   Yes   |  Yes   |   —    |
| Invite and remove members                |  Yes  |   Yes   |   —    |   —    |
| Update member roles                      |  Yes  |   Yes   |   —    |   —    |
| Delete the work                          |  Yes  |    —    |   —    |   —    |
| Leave the work                           |   —   |   Yes   |  Yes   |  Yes   |

## How Invitation Works

1. A Manager or Owner calls the invite endpoint with the collaborator's email and desired role.
2. The platform looks up the email — the user must already have an Ever Works account.
3. A membership record is created immediately (no pending/accept flow).
4. The invitee receives an email notification with the work name, their role, and a link to the work.

:::info
Invitations are direct — the invited user becomes a member as soon as the API call succeeds. There is no invitation token or acceptance step.
:::

## API

All endpoints require JWT authentication. Base path: `/api/works/:workId/members`

### List Members

| Method | Endpoint                 | Description                    |
| ------ | ------------------------ | ------------------------------ |
| `GET`  | `/api/works/:id/members` | List all members and the owner |

```bash
curl http://localhost:3100/api/works/<work-id>/members \
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

The `owner` field always shows the work creator. The `members` array contains only explicit membership records (the owner is not included).

### Invite a Member

| Method | Endpoint                 | Description            |
| ------ | ------------------------ | ---------------------- |
| `POST` | `/api/works/:id/members` | Invite a user by email |

**Required role:** Manager or Owner

```bash
curl -X POST http://localhost:3100/api/works/<work-id>/members \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "role": "editor"
  }'
```

**Request body:**

| Field   | Type   | Required | Description                                                 |
| ------- | ------ | -------- | ----------------------------------------------------------- |
| `email` | string | Yes      | Email of the user to invite (must have an existing account) |
| `role`  | string | Yes      | `manager`, `editor`, or `viewer`                            |

**Errors:**

| Status | Reason                                  |
| ------ | --------------------------------------- |
| `400`  | Role is `owner` or invalid              |
| `400`  | Email belongs to the work creator       |
| `400`  | User is already a member                |
| `404`  | No registered user found for that email |

### Get Member

| Method | Endpoint                           | Description                   |
| ------ | ---------------------------------- | ----------------------------- |
| `GET`  | `/api/works/:id/members/:memberId` | Get a single member's details |

### Update Member Role

| Method | Endpoint                           | Description            |
| ------ | ---------------------------------- | ---------------------- |
| `PUT`  | `/api/works/:id/members/:memberId` | Change a member's role |

**Required role:** Manager or Owner

```bash
curl -X PUT http://localhost:3100/api/works/<work-id>/members/<member-id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "role": "manager" }'
```

### Remove a Member

| Method   | Endpoint                           | Description                   |
| -------- | ---------------------------------- | ----------------------------- |
| `DELETE` | `/api/works/:id/members/:memberId` | Remove a member from the work |

**Required role:** Manager or Owner

```bash
curl -X DELETE http://localhost:3100/api/works/<work-id>/members/<member-id> \
  -H "Authorization: Bearer <token>"
```

### Leave a Work

| Method | Endpoint                       | Description                      |
| ------ | ------------------------------ | -------------------------------- |
| `POST` | `/api/works/:id/members/leave` | Leave a work you are a member of |

```bash
curl -X POST http://localhost:3100/api/works/<work-id>/members/leave \
  -H "Authorization: Bearer <token>"
```

:::warning
The work creator (Owner) cannot leave their own work. Only invited members can use this endpoint.
:::

## Related

- [Works API](/api/works) — Full endpoint reference including member management
- [Authentication](/api/authentication) — User accounts and JWT authentication
