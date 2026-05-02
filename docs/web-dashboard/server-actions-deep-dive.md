---
id: server-actions-deep-dive
title: Server Actions Deep Dive
sidebar_label: Server Actions
sidebar_position: 29
---

# Server Actions Deep Dive

## Overview

Server actions are the primary data mutation layer in the Ever Works web application. They run server-side via Next.js's `'use server'` directive and are called directly from client components using `useTransition` or form actions. All server actions live in `apps/web/src/app/actions/` and proxy requests to the NestJS backend API. They handle authentication token management, input validation (via Zod), error normalization, and cookie/redirect operations.

## Architecture

```
apps/web/src/app/actions/
├── auth.ts                    # Authentication actions
├── api-keys.ts                # API key management
├── email-verification.ts      # Email verification
├── notifications.ts           # Notification management
├── plugins.ts                 # Plugin management
├── settings.ts                # User settings
├── validation.ts              # Shared validation schemas
│
└── dashboard/
    ├── index.ts               # Barrel re-exports
    ├── works.ts         # Work CRUD + advanced operations
    ├── generator.ts           # AI generation actions
    ├── generator-form.ts      # Generator form schema
    ├── items.ts               # Item CRUD
    ├── comparisons.ts         # Comparison management
    ├── deploy.ts              # Deployment actions
    ├── work-schedule.ts  # Schedule management
    ├── members.ts             # Team member management
    ├── navigation.ts          # Navigation data
    ├── oauth.ts               # OAuth connection management
    ├── organizations.ts       # Organization management
    └── taxonomy.ts            # Category/tag management
```

All actions follow a consistent pattern: validate input, call the backend API, handle errors, and return a typed result object.

## Components

### Auth Actions

**File:** `apps/web/src/app/actions/auth.ts`

| Action            | Parameters                                  | Returns                     | Description                                     |
| ----------------- | ------------------------------------------- | --------------------------- | ----------------------------------------------- |
| `login`           | `FormData \| { email, password }`           | Redirect or `{ error }`     | Email/password login with Zod validation        |
| `register`        | `FormData \| { username, email, password }` | Redirect or `{ error }`     | New user registration                           |
| `logout`          | None                                        | Redirect                    | Clears cookies and redirects to home            |
| `connectProvider` | `provider: OAuthProvider`                   | `{ success, url?, error? }` | Initiates OAuth flow, returns authorization URL |
| `forgotPassword`  | `{ email }`                                 | `{ success, error? }`       | Sends password reset email                      |
| `resetPassword`   | `{ token, password }`                       | `{ success, error? }`       | Sets new password using reset token             |

**Login flow:**

1. Parse input with Zod schema (`LoginSchema`).
2. On validation failure, return field-level errors.
3. Call `authAPI.login({ email, password })`.
4. On success, set `access_token` and `refresh_token` cookies.
5. Redirect to `/dashboard`.

**Register flow:**

1. Parse input with `RegisterSchema` (username 3-50 chars, email, password 8+ chars).
2. Call `authAPI.register(...)`.
3. On success, set auth cookies and redirect to `/dashboard`.

**OAuth flow (connectProvider):**

1. Call backend to generate OAuth authorization URL with state parameter.
2. Set `oauth_state` cookie for CSRF protection.
3. Return the URL for the client to redirect to.

```tsx
// Client component usage
'use client';
import { login } from '@/app/actions/auth';

function LoginForm() {
	const [error, setError] = useState(null);

	async function handleSubmit(formData: FormData) {
		const result = await login(formData);
		if (result?.error) setError(result.error);
		// On success, login redirects automatically
	}

	return <form action={handleSubmit}>{/* fields */}</form>;
}
```

### Work Actions

**File:** `apps/web/src/app/actions/dashboard/works.ts`

This is the largest action file, covering all work operations:

| Action                       | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `createWork`                 | Create a new work with name, type, and optional repository config |
| `createWorkWithAI`           | Create a work with AI-assisted content generation                 |
| `updateWork`                 | Update work metadata (name, description, etc.)                    |
| `deleteWork`                 | Delete a work and its associated repositories                     |
| `getWorks`                   | Fetch all works for the current user                              |
| `syncWorkData`               | Trigger a sync with the source repository                         |
| `analyzeRepository`          | Analyze a URL to detect format and content structure              |
| `analyzeForLinking`          | Check if a repository has existing Ever Works structure           |
| `importWork`                 | Import a work from an external source                             |
| `getUserRepositories`        | List repositories from the user's git provider                    |
| `updateWorkSchedule`         | Configure automated generation schedule                           |
| `getRepositoryVisibility`    | Check if a repository is public or private                        |
| `toggleRepositoryVisibility` | Toggle repository public/private state                            |
| `getAdvancedPrompts`         | Fetch custom AI prompts for a work                                |
| `updateAdvancedPrompts`      | Update custom AI prompts                                          |
| `getWebsiteSettings`         | Fetch website deployment configuration                            |
| `updateWebsiteSettings`      | Update website deployment configuration                           |
| `updateCommunityPrSettings`  | Update community PR settings for a work                           |
| `fetchWorkGenerationHistory` | Get the generation history log                                    |

**Example: createWorkWithAI**

```typescript
'use server';

export async function createWorkWithAI(params: {
	name: string;
	description: string;
	aiProvider: string;
	aiModel: string;
}) {
	const session = await getSession();
	if (!session) return { success: false, error: 'Unauthorized' };

	const result = await workAPI.createWithAI(params, session.token);

	if (!result.success) {
		return { success: false, error: result.error };
	}

	revalidatePath('/dashboard');
	return { success: true, data: result.data };
}
```

### Generator Actions

**File:** `apps/web/src/app/actions/dashboard/generator.ts`

| Action               | Description                                                 |
| -------------------- | ----------------------------------------------------------- |
| `generateItems`      | Start AI generation for a work with sanitized plugin config |
| `updateItems`        | Batch update generated items                                |
| `regenerateMarkdown` | Regenerate markdown output from existing items              |

**generateItems** is notable for its `sanitizePluginConfig` step, which strips sensitive data (like API keys marked with `x-secret`) from the plugin configuration before logging or transmitting it over non-secure channels. The actual secret values are resolved server-side from the stored plugin settings.

```tsx
// Client component usage
startTransition(async () => {
	const result = await generateItems({
		workId: work.id,
		providers: selectedProviders,
		options: generatorOptions
	});

	if (result.success) {
		toast.success('Generation started');
	} else {
		toast.error(result.error);
	}
});
```

### Notification Actions

**File:** `apps/web/src/app/actions/notifications.ts`

| Action                       | Description                            |
| ---------------------------- | -------------------------------------- |
| `getNotifications`           | Fetch paginated notifications          |
| `getUnreadNotificationCount` | Get the number of unread notifications |
| `markNotificationAsRead`     | Mark a single notification as read     |
| `markAllNotificationsAsRead` | Mark all notifications as read         |
| `dismissNotification`        | Remove a notification                  |

These actions are consumed by `NotificationDropdown` in the dashboard header.

### Plugin Actions

**File:** `apps/web/src/app/actions/plugins.ts`

| Action                 | Description                        |
| ---------------------- | ---------------------------------- |
| `updatePluginSettings` | Save plugin configuration settings |
| `getPluginSettings`    | Fetch current plugin settings      |
| `enablePlugin`         | Enable a plugin                    |
| `disablePlugin`        | Disable a plugin                   |

### OAuth Actions

**File:** `apps/web/src/app/actions/dashboard/oauth.ts`

| Action                    | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `connectOAuthProvider`    | Initiate OAuth connection for a git provider or plugin |
| `disconnectOAuthProvider` | Remove an OAuth connection                             |

Used by both `GitProviderConnections` and `PluginOAuthConnection` settings components.

### Settings Actions

**File:** `apps/web/src/app/actions/settings.ts`

| Action           | Description               |
| ---------------- | ------------------------- |
| `updateProfile`  | Update username           |
| `updatePassword` | Change password           |
| `deleteAccount`  | Delete the user's account |

### API Key Actions

**File:** `apps/web/src/app/actions/api-keys.ts`

| Action         | Description                                            |
| -------------- | ------------------------------------------------------ |
| `createApiKey` | Create a new API key with name and optional expiration |
| `revokeApiKey` | Revoke an existing API key                             |

## Implementation Details

### Common Pattern

All server actions follow this structure:

```typescript
'use server';

import { getSession } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';

export async function someAction(params: SomeInput) {
	// 1. Authenticate
	const session = await getSession();
	if (!session) {
		return { success: false, error: 'Unauthorized' };
	}

	// 2. Validate (optional, for form inputs)
	const parsed = SomeSchema.safeParse(params);
	if (!parsed.success) {
		return { success: false, errors: parsed.error.flatten().fieldErrors };
	}

	// 3. Call backend API
	try {
		const result = await backendAPI.someMethod(parsed.data, session.token);

		// 4. Revalidate cached data
		revalidatePath('/dashboard');

		return { success: true, data: result };
	} catch (error) {
		return { success: false, error: 'Operation failed' };
	}
}
```

### Authentication

Every action that requires authentication calls `getSession()` to retrieve the current user's session from cookies. The session contains the JWT access token used to authenticate requests to the NestJS backend API.

### Input Validation with Zod

Form-based actions use Zod schemas for validation:

```typescript
const LoginSchema = z.object({
	email: z.string().email('Invalid email'),
	password: z.string().min(1, 'Password required')
});

const RegisterSchema = z.object({
	username: z.string().min(3).max(50),
	email: z.string().email(),
	password: z.string().min(8, 'Minimum 8 characters')
});
```

Validation errors are returned as field-level error maps that client components display inline under each form field.

### Error Normalization

Backend API errors are caught and normalized into a consistent `{ success: false, error: string }` shape. This prevents backend implementation details from leaking to the client.

### Cache Revalidation

After successful mutations, actions call `revalidatePath()` to invalidate Next.js's data cache for the affected pages. This ensures that server components re-fetch fresh data on the next render.

### Cookie Management

Auth actions (`login`, `register`, `logout`) manage HTTP-only cookies:

- `cookies().set('access_token', token, { httpOnly: true, secure: true, sameSite: 'lax' })`
- `cookies().set('refresh_token', token, { ... })`
- `cookies().delete('access_token')` on logout

### Redirect Handling

Actions that change authentication state use `redirect()` from `next/navigation`:

- `login` and `register` redirect to `/dashboard` on success.
- `logout` redirects to `/`.
- `deleteAccount` clears cookies and redirects to `/`.

## Styling & Theming

Server actions have no visual component. They are consumed by client components that handle all styling. The consistent return type pattern (`{ success, data?, error? }`) enables client components to show toast notifications and inline errors using the project's standard patterns.

## Usage Examples

### Form Action with Validation Errors

```tsx
'use client';

import { useActionState } from 'react';
import { register } from '@/app/actions/auth';

export function RegisterForm() {
	const [state, formAction, isPending] = useActionState(register, null);

	return (
		<form action={formAction}>
			<Input name="username" label="Username" error={state?.errors?.username?.[0]} />
			<Input name="email" type="email" label="Email" error={state?.errors?.email?.[0]} />
			<Input name="password" type="password" label="Password" error={state?.errors?.password?.[0]} />
			{state?.error && <p className="text-danger">{state.error}</p>}
			<Button type="submit" loading={isPending}>
				Register
			</Button>
		</form>
	);
}
```

### Transition-based Action Call

```tsx
'use client';

import { useTransition } from 'react';
import { deleteWork } from '@/app/actions/dashboard/works';
import { toast } from 'sonner';

export function DeleteWorkButton({ workId }) {
	const [isPending, startTransition] = useTransition();

	const handleDelete = () => {
		startTransition(async () => {
			const result = await deleteWork(workId);
			if (result.success) {
				toast.success('Work deleted');
			} else {
				toast.error(result.error || 'Failed to delete');
			}
		});
	};

	return (
		<Button variant="danger" onClick={handleDelete} loading={isPending}>
			Delete Work
		</Button>
	);
}
```

## Related Components

- [Auth Components](./auth-components.md) - Consumes auth actions (login, register, connectProvider)
- [Settings Components](./settings-components.md) - Consumes settings, plugin, API key, and OAuth actions
- [Work Detail Components](./work-detail-components.md) - Consumes work and generator actions
- [Import Flow Components](./import-flow-components.md) - Consumes analyzeRepository, importWork actions
- [Web API Routes](./web-api-routes.md) - API routes that complement server actions for streaming and OAuth callbacks
