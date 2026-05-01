---
id: settings-pages
title: Settings Pages
sidebar_label: Settings Pages
sidebar_position: 7
---

# Settings Pages

The settings area of the dashboard is composed of six client components in `src/components/settings/`. These components handle profile management, security, git provider connections, plugin configuration, and account deletion. Each component connects to the corresponding server actions for data mutations.

## Component Overview

```
src/components/settings/
  ProfileSettings.tsx          # Username editing and email verification
  SecuritySettings.tsx         # Password change form
  GitProviderConnections.tsx   # Git provider OAuth connect/disconnect
  PluginOAuthConnection.tsx    # Plugin-specific OAuth connection widget
  PluginSettingsInline.tsx     # Inline plugin settings editor
  DangerZone.tsx               # Account export and deletion
  SettingsNavItem.tsx          # Navigation item for settings tabs
```

## ProfileSettings

**File**: `src/components/settings/ProfileSettings.tsx`

Renders the user profile editing form with email verification status.

**Props**:

```typescript
interface ProfileSettingsProps {
	user: {
		id: string;
		username: string;
		email: string;
		emailVerified?: boolean;
	};
}
```

**Features**:

| Feature                   | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| Username editing          | Editable text input, calls `updateProfile` server action       |
| Email display             | Read-only input showing user's email with helper text          |
| Email verification banner | Warning banner shown when `emailVerified` is false             |
| Verification resend       | Button in banner calls `resendVerificationEmail` server action |

**Server Actions Used**: `updateProfile`, `resendVerificationEmail` from `src/app/actions/settings.ts`

**State Management**: Uses `useTransition` for both the profile save and verification resend operations. The `isPending` state disables buttons and shows loading indicators during server calls.

**Validation**: The component performs a basic empty-check on the username before calling the server action, which does the full Zod validation.

## SecuritySettings

**File**: `src/components/settings/SecuritySettings.tsx`

Provides a password change form with client-side validation.

**Props**:

```typescript
interface SecuritySettingsProps {
	user: {
		id: string;
		username: string;
		email: string;
	};
}
```

**Form Fields**:

| Field            | Type                  | Validation              |
| ---------------- | --------------------- | ----------------------- |
| Current Password | password (toggleable) | Required                |
| New Password     | password (toggleable) | Min 8 characters        |
| Confirm Password | password (toggleable) | Must match new password |

**Client-Side Validations** (before calling server action):

1. All three fields must be filled
2. New password must be at least 8 characters
3. New password and confirm password must match
4. New password must differ from current password

**Show/Hide Toggle**: A checkbox toggles all three password fields between `type="password"` and `type="text"`.

**Server Action**: `updatePassword` from `src/app/actions/settings.ts`. On success, all three fields are cleared.

## GitProviderConnections

**File**: `src/components/settings/GitProviderConnections.tsx`

Displays a list of available git providers with their connection status, user info, and organizations.

**Props**:

```typescript
interface GitProviderConnectionsProps {
	user: { id: string; email: string; username?: string; avatar?: string };
	providers: ProviderWithConnection[];
	returnPath?: string; // defaults to current page via usePathname()
}

interface ProviderWithConnection {
	provider: GitProviderInfo;
	connectionInfo: GitProviderConnectionInfo | null;
	organizations: GitOrganization[];
}
```

**Layout**:

1. **Header Section**: Title and subtitle
2. **Connection Summary**: Shows count of connected providers with success/warning indicator
3. **Provider Cards**: One card per provider with branded header, connection actions, and user details
4. **Empty State**: Shown when no providers are available

**GitProviderCard Sub-Component**:

Each provider card includes:

| Section        | Content                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| Branded Header | Provider icon, name, connection status badge with animated pulse dot                |
| Action Buttons | Connect/Reconnect/Disconnect buttons (connected state shows reconnect + disconnect) |
| User Info      | Avatar, username (links to provider profile), email                                 |
| Organizations  | List of organization badges with avatars, each linking to the org's provider page   |

**Provider Branding**: The `getProviderBrandColors` function returns Tailwind classes for GitHub (`bg-github`), GitLab (`bg-gitlab`), and Bitbucket (`bg-bitbucket`) with dark mode variants.

**Server Actions Used**:

- `connectOAuthProvider(providerId, returnPath)` -- Initiates OAuth flow, redirects to provider
- `connectOAuthProvider(providerId, returnPath, true)` -- Force reconnect with consent
- `disconnectOAuthProvider(providerId)` -- Disconnects with confirmation dialog, reloads page

## PluginOAuthConnection

**File**: `src/components/settings/PluginOAuthConnection.tsx`

A reusable widget for connecting OAuth-capable plugins (not limited to git providers).

**Props**:

```typescript
interface PluginOAuthConnectionProps {
	pluginId: string;
	pluginName: string;
	connection: OAuthConnectionInfo | null;
	returnPath?: string;
}
```

**States**:

| Connection State | Display                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Connected        | Green status icon (avatar if available), username, email, Reconnect + Disconnect buttons |
| Not Connected    | Gray link icon, description text, Connect button                                         |

**Actions**: Same OAuth server actions as `GitProviderConnections` -- `connectOAuthProvider` and `disconnectOAuthProvider` -- with `useTransition` for pending state management.

## PluginSettingsInline

**File**: `src/components/settings/PluginSettingsInline.tsx`

An inline, collapsible settings editor for a single plugin. Used on the global settings page to configure user-level plugin settings.

**Props**:

```typescript
interface PluginSettingsInlineProps {
	plugin: UserPlugin;
	oauthConnection?: OAuthConnectionInfo | null;
	defaultExpanded?: boolean;
}
```

**Layout**: Wrapped in a `CollapsibleCard` component with a header showing:

- Plugin icon and name
- Version number
- Enabled status indicator (green dot)
- Capability badges (filtered to exclude the primary category)
- Plugin description (single line, truncated)

**Body Content**:

1. **OAuth Section** (conditional): Renders `PluginOAuthConnection` if the plugin has the `oauth` capability
2. **Settings Form**: Iterates over `visibleProperties` from `usePluginSettings`, rendering a `PluginSettingsField` for each
3. **Validation Error**: Red alert box with error icon
4. **Save Button**: Disabled when no changes exist; shows success checkmark for 3 seconds after save

**Hook Integration**: Uses `usePluginSettings` with:

- `scopes: ['global', 'user']` -- Shows fields visible at global and user scope
- `scope: 'user'` -- Validation context for required field checking
- `onSave` callback wraps `updatePluginSettings` server action

**Settings Field Rendering**:

```tsx
{
	Object.entries(visibleProperties).map(([key, propSchema]) => (
		<PluginSettingsField
			key={key}
			name={key}
			schema={propSchema}
			value={getFieldValue(key, propSchema)}
			required={plugin.settingsSchema?.required?.includes(key)}
			onChange={(value) => handleFieldChange(key, value, propSchema.secret || false)}
			pluginId={plugin.pluginId}
		/>
	));
}
```

## DangerZone

**File**: `src/components/settings/DangerZone.tsx`

Handles account data export and deletion with a multi-step confirmation flow.

**Props**:

```typescript
interface DangerZoneProps {
	user: { id: string; email: string };
}
```

**Sections**:

| Section        | Status   | Description                                             |
| -------------- | -------- | ------------------------------------------------------- |
| Export Data    | Disabled | Button for exporting account data (not yet implemented) |
| Delete Account | Active   | Two-step deletion with email confirmation               |

**Deletion Flow**:

1. User clicks "Delete Account" button
2. Warning panel appears listing consequences (directories removed, repositories affected, etc.)
3. User must type their email address to confirm
4. "Confirm Delete" button only becomes active when typed email matches `user.email`
5. Calls `deleteAccount` server action (currently returns error by design)
6. On success, redirects to registration page

**Visual Design**: Both sections use danger-themed styling (`border-danger/20`, `bg-danger/5`) to clearly communicate the destructive nature of these actions.

## Toast Notifications

All settings components use `sonner` toast notifications for user feedback:

```typescript
import { toast } from 'sonner';

// Success
toast.success(t('messages.success'));

// Error
toast.error(result.error || t('messages.error'));
```

Toasts appear in the top-right corner as configured in the root layout's `<Toaster>` component.

## Internationalization

Every settings component uses `useTranslations` from `next-intl` for all user-facing text:

```typescript
const t = useTranslations('dashboard.settings.profile');
```

Translation namespaces follow the pattern `dashboard.{section}.{subsection}`, keeping translations organized and scoped to their components.
