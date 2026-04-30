---
id: settings-components
title: Settings Components
sidebar_label: Settings Components
sidebar_position: 24
---

# Settings Components

## Overview

The settings components provide the user account management interface in the Ever Works dashboard. They cover profile editing, security/password management, API key lifecycle, git provider connections, plugin configuration, and account deletion. All components live in `apps/web/src/components/settings/` and are client components that use `useTransition` for optimistic server action calls and `sonner` for toast feedback.

## Architecture

```
Settings Page
├── SettingsNavItem (navigation sidebar)
│   ├── Profile
│   ├── Security
│   ├── API Keys
│   ├── Git Providers
│   ├── Plugins (expandable)
│   │   └── Per-plugin settings
│   └── Danger Zone
│
├── ProfileSettings
│   ├── Username edit
│   ├── Email display (read-only)
│   └── Email verification banner
│
├── SecuritySettings
│   └── Password change form
│
├── ApiKeysSettings
│   ├── Keys table
│   ├── Create dialog
│   └── Revoke confirmation dialog
│
├── GitProviderConnections
│   └── Provider cards (GitHub, GitLab, Bitbucket)
│
├── PluginSettingsInline
│   ├── CollapsibleCard with plugin metadata
│   ├── PluginOAuthConnection
│   └── Dynamic settings form (usePluginSettings)
│
└── DangerZone
    ├── Export data (disabled)
    └── Delete account with confirmation
```

## Components

### ProfileSettings

**File:** `apps/web/src/components/settings/ProfileSettings.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `initialProfile` | `{ username: string; email: string; emailVerified: boolean }` | Current user profile data |

Renders two sections:

1. **Username field** - An editable `Input` with a save button. Calls the `updateProfile` server action on save. Minimum 3 characters enforced client-side.
2. **Email section** - Displays the email as read-only text. If `emailVerified` is `false`, shows a warning banner with a "Resend verification" button that calls `resendVerificationEmail`.

```tsx
<ProfileSettings
    initialProfile={{
        username: 'janedoe',
        email: 'jane@example.com',
        emailVerified: true,
    }}
/>
```

### SecuritySettings

**File:** `apps/web/src/components/settings/SecuritySettings.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `hasPassword` | `boolean` | Whether the user has a password set (OAuth-only users may not) |

Renders a password change form with three fields:

- **Current password** - Required only if `hasPassword` is true.
- **New password** - Minimum 8 characters, validated client-side.
- **Confirm password** - Must match new password.

Each field has a show/hide toggle button (Eye / EyeOff icons). The form calls the `updatePassword` server action. Validation errors are displayed inline below each field.

```tsx
<SecuritySettings hasPassword={true} />
```

### ApiKeysSettings

**File:** `apps/web/src/components/settings/ApiKeysSettings.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `initialKeys` | `ApiKeyListItem[]` | List of existing API keys |

Provides full CRUD for API keys:

**Keys table** displays columns: Name, Key (prefix only, e.g., `ew_abc1...`), Created date, Last Used date, Expires date, and a revoke (trash) action button. Columns are responsively hidden on smaller screens using `hidden sm:table-cell` / `hidden md:table-cell`.

**Create dialog** contains:
- A name input (max 100 characters).
- An expiration dropdown with options: Never, 30 days, 90 days, 1 year.
- On successful creation, transitions to a "key created" view showing the full key with a copy button and a warning that the key will not be shown again.

**Revoke dialog** is a confirmation dialog showing the key name and a danger-styled confirm button.

Server actions used: `createApiKey`, `revokeApiKey`.

The expiration options are defined as a constant:

```typescript
const EXPIRATION_OPTIONS = [
    { value: '', label: 'Never' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
    { value: '365', label: '1 year' },
] as const;
```

```tsx
<ApiKeysSettings initialKeys={existingKeys} />
```

### GitProviderConnections

**File:** `apps/web/src/components/settings/GitProviderConnections.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `connections` | `OAuthConnectionDto[]` | Array of current git provider connections |

Renders a card for each supported git provider (GitHub, GitLab, Bitbucket). Each card shows:

- The provider's brand icon and name with brand-colored accent.
- Connection status: connected (green) with organization name, or disconnected (muted).
- Action button: "Connect" for disconnected, "Disconnect" for connected, or "Reconnect" if the connection has issues.

Brand colors: GitHub `#333`/`#f0f0f0`, GitLab `#FC6D26`, Bitbucket `#0052CC`.

Server actions used: `connectOAuthProvider` (returns an OAuth URL for redirect), `disconnectOAuthProvider`.

```tsx
<GitProviderConnections connections={userConnections} />
```

### PluginSettingsInline

**File:** `apps/web/src/components/settings/PluginSettingsInline.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `plugin` | `PluginRegistryEntry` | Plugin metadata (id, name, version, capabilities, settings schema) |
| `settings` | `Record<string, unknown>` | Current plugin settings values |
| `oauthConnection` | `OAuthConnectionDto \| null` | OAuth connection for this plugin if applicable |

Wraps each plugin in a `CollapsibleCard` showing:

- **Header:** Plugin icon (or fallback), name, version badge, capability badges (e.g., "chat", "embeddings", "image-generation").
- **OAuth section:** If the plugin has OAuth capabilities, renders `PluginOAuthConnection`.
- **Settings form:** Dynamic form fields generated from the plugin's JSON Schema settings definition using the `usePluginSettings` hook. Supports text inputs, number inputs, selects, toggles, and secret fields (shown as password inputs with `x-secret` schema extension).

The `usePluginSettings` hook handles validation, change tracking, and sanitization before calling the `updatePluginSettings` server action.

```tsx
<PluginSettingsInline
    plugin={openaiPlugin}
    settings={{ apiKey: 'sk-...', model: 'gpt-4o' }}
    oauthConnection={null}
/>
```

### PluginOAuthConnection

**File:** `apps/web/src/components/settings/PluginOAuthConnection.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `pluginId` | `string` | The plugin's unique identifier |
| `connection` | `OAuthConnectionDto \| null` | Current connection state |

Displays the OAuth connection status for a plugin with three possible states:

1. **Not connected** - Shows a "Connect" button.
2. **Connected** - Shows a green status indicator with the connection name and "Disconnect" / "Reconnect" buttons.
3. **Error state** - Shows a warning with a "Reconnect" button.

Server actions used: `connectOAuthProvider`, `disconnectOAuthProvider`.

### SettingsNavItem

**File:** `apps/web/src/components/settings/SettingsNavItem.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `label` | `string` | Display text for the nav item |
| `href` | `string` (optional) | Link destination (renders as Next.js Link) |
| `icon` | `ReactNode` (optional) | Icon element to show before the label |
| `isActive` | `boolean` (optional) | Whether this item is currently active |
| `children` | `ReactNode` (optional) | Expandable child nav items |
| `indicator` | `ReactNode` (optional) | Right-side slot (e.g., badge, count) |
| `onClick` | `() => void` (optional) | Click handler for non-link items |

A flexible navigation item component that supports:

- **Simple links** - When `href` is provided, renders as a Next.js `Link`.
- **Expandable sections** - When `children` is provided, renders a button that toggles showing/hiding child items with a chevron rotation animation.
- **Active state** - Highlighted with primary color background when `isActive`.
- **Indicator slot** - Arbitrary content on the right side (useful for count badges).

```tsx
<SettingsNavItem
    label="Plugins"
    icon={<Puzzle className="w-4 h-4" />}
>
    <SettingsNavItem label="OpenAI" href="/settings/plugins/openai" />
    <SettingsNavItem label="Anthropic" href="/settings/plugins/anthropic" />
</SettingsNavItem>
```

### DangerZone

**File:** `apps/web/src/components/settings/DangerZone.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `userEmail` | `string` | The user's email, used for deletion confirmation |

Renders two sections:

1. **Export Data** - A button (currently disabled) for future data export functionality.
2. **Delete Account** - A danger-styled button that opens a confirmation dialog. The user must type their email address to confirm deletion. The typed email is compared case-insensitively to `userEmail`. On confirmation, calls the `deleteAccount` server action which clears cookies and redirects to the home page.

```tsx
<DangerZone userEmail="jane@example.com" />
```

## Implementation Details

### Optimistic Updates Pattern

All settings components follow the same pattern for server action calls:

1. Local state is updated optimistically (e.g., adding a new key to the list before the server confirms).
2. `useTransition` wraps the async server action call so React can show pending UI.
3. On success, a toast notification is shown.
4. On failure, the optimistic update is rolled back and an error toast is shown.

### Plugin Settings Form Generation

The `usePluginSettings` hook dynamically generates form fields from a plugin's JSON Schema:

1. The schema's `properties` object defines each field.
2. `x-widget` extensions determine the widget type (text, password, select, toggle).
3. `x-secret` marks fields that should be masked.
4. `x-envVar` indicates the field can be set via environment variable.
5. Required fields are determined from the schema's `required` array.

On save, settings are sanitized (empty strings removed, whitespace trimmed) before being sent to the server.

### Email Verification Flow

In `ProfileSettings`, if the email is not verified:

1. A warning banner is displayed with the unverified email.
2. Clicking "Resend verification" calls `resendVerificationEmail`.
3. A cooldown timer prevents spamming the resend button.
4. The verification link in the email hits `/api/auth/verify-email` which confirms the email on the backend.

## Styling & Theming

Settings components use consistent patterns:

| Pattern | Classes |
|---------|---------|
| Section heading | `text-xl font-semibold text-text dark:text-text-dark` |
| Section description | `text-text-muted dark:text-text-muted-dark text-sm` |
| Card/section container | `border border-border dark:border-border-dark rounded-lg` |
| Table header | `bg-surface-secondary dark:bg-surface-secondary-dark` |
| Danger elements | `text-danger`, `border-danger/50`, `variant="danger"` |
| Success indicator | `text-success` with green dot |

The `DangerZone` section uses `border-danger/20` for its container border and `bg-danger/5` for its background, making it visually distinct as a destructive action area.

## Usage Examples

### Complete Settings Page

```tsx
import { ProfileSettings } from '@/components/settings/ProfileSettings';
import { SecuritySettings } from '@/components/settings/SecuritySettings';
import { ApiKeysSettings } from '@/components/settings/ApiKeysSettings';
import { GitProviderConnections } from '@/components/settings/GitProviderConnections';
import { DangerZone } from '@/components/settings/DangerZone';

export function SettingsPage({ user, apiKeys, connections }) {
    return (
        <div className="max-w-3xl mx-auto space-y-12">
            <ProfileSettings
                initialProfile={{
                    username: user.username,
                    email: user.email,
                    emailVerified: user.emailVerified,
                }}
            />
            <SecuritySettings hasPassword={user.hasPassword} />
            <ApiKeysSettings initialKeys={apiKeys} />
            <GitProviderConnections connections={connections} />
            <DangerZone userEmail={user.email} />
        </div>
    );
}
```

## Related Components

- [UI Component Library](./ui-component-library.md) - Button, Input, Dialog, CollapsibleCard used throughout
- [Web Hooks Reference](./web-hooks-reference.md) - usePluginSettings, usePluginToggle hooks
- [Server Actions Deep Dive](./server-actions-deep-dive.md) - All settings-related server actions
- [Auth Components](./auth-components.md) - OAuth flow shared with git provider connections
