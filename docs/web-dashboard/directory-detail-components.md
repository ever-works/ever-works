---
id: directory-detail-components
title: Directory Detail Components
sidebar_label: Directory Detail
sidebar_position: 26
---

# Directory Detail Components

## Overview

The directory detail components form the most complex view in the Ever Works dashboard. They display and manage all aspects of a single directory: metadata, items, AI generation, scheduling, deployment, history, comparisons, plugins, members, and settings. The components live in `apps/web/src/components/directories/detail/` and are organized into sub-folders by tab. A React Context (`DirectoryDetailContext`) provides shared directory state to all child components.

## Architecture

```
DirectoryDetailContext (React Context Provider)
├── directory: DirectoryDto
├── oauthConnection: OAuthConnectionDto | null
├── config: DirectoryConfigDto
├── repoLinks: { main, dataRepo, websiteRepo }
├── permissions: PermissionsMap
│
├── DirectoryHeader
│   ├── Directory name + shared role badge
│   ├── Generation status badge (with step progress)
│   ├── Slug, owner, git provider link
│   ├── Creation date, website link
│   └── Action buttons
│
├── DirectoryTabs
│   ├── overview/     → Directory overview stats and info
│   ├── items/        → Item listing, CRUD, filtering
│   ├── generator/    → AI generation configuration and execution
│   ├── schedule/     → Automated generation scheduling
│   ├── history/      → Generation history and logs
│   ├── comparisons/  → Item comparison management
│   ├── plugins/      → Directory-level plugin configuration
│   ├── deploy/       → Website deployment settings
│   ├── members/      → Team member management (permission-gated)
│   └── settings/     → Directory settings, prompts, website config
│
└── shared/           → Shared sub-components (status badges, selectors)
```

The directory detail page can contain around 70 files across all sub-folders. This document covers the three foundational components: the context provider, header, and tab navigation.

## Components

### DirectoryDetailContext

**File:** `apps/web/src/components/directories/detail/DirectoryDetailContext.tsx`

This component is a React Context provider that wraps the entire directory detail page. It accepts the directory's core data as props and makes it available to all descendant components via two hooks:

| Hook | Returns | Purpose |
|------|---------|---------|
| `useDirectoryDetail()` | Full context value | Access directory, config, OAuth, repo links |
| `useDirectoryPermissions()` | `PermissionsMap` | Check specific permissions for the current user |

**Context value shape:**

```typescript
interface DirectoryDetailContextValue {
    directory: DirectoryDto;
    oauthConnection: OAuthConnectionDto | null;
    config: DirectoryConfigDto;
    repoLinks: {
        main: string | null;
        dataRepo: string | null;
        websiteRepo: string | null;
    };
    permissions: PermissionsMap;
}
```

**Repo links** are computed from the directory's git provider and repository data. Each link is a fully qualified URL to the repository on GitHub, GitLab, or Bitbucket. The three repo types are:

- `main` - The primary code/data repository.
- `dataRepo` - The repository containing generated directory data.
- `websiteRepo` - The repository for the deployed website.

**Permissions** are resolved via a `getPermissions` utility that maps the current user's role (owner, admin, editor, viewer) to specific boolean flags.

```tsx
import { DirectoryDetailProvider, useDirectoryDetail } from './DirectoryDetailContext';

// Provider wraps the entire detail page
<DirectoryDetailProvider
    directory={directoryData}
    oauthConnection={oauthConn}
    config={dirConfig}
>
    <DirectoryHeader />
    <DirectoryTabs />
</DirectoryDetailProvider>

// Consumer hook in any child component
function SomeChildComponent() {
    const { directory, repoLinks } = useDirectoryDetail();
    const permissions = useDirectoryPermissions();

    if (!permissions.canEdit) return <p>Read-only access</p>;
    return <p>{directory.name}</p>;
}
```

### DirectoryHeader

**File:** `apps/web/src/components/directories/detail/DirectoryHeader.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `directoryId` | `string` | The directory's unique ID |

This component consumes `useDirectoryDetail()` and renders the directory's header section with:

1. **Title row:**
   - Directory name as an `h1`.
   - Shared role badge (if the directory is shared with the current user, shows their role: admin, editor, viewer).
   - Generation status badge showing the current generation state. If generation is in progress, it shows a step indicator (e.g., "Step 2/5: Generating items") with a progress animation.

2. **Metadata row:**
   - Slug displayed as a code-formatted span.
   - Owner name.
   - Git provider link (opens the repository in a new tab) with the provider icon.
   - Creation date formatted with `toLocaleDateString`.
   - Website link (if deployed) opening in a new tab.

3. **Action buttons:** Context-dependent actions like sync, edit, or generate, shown based on the user's permissions from `useDirectoryPermissions()`.

```tsx
<DirectoryHeader directoryId="dir_abc123" />
```

### DirectoryTabs

**File:** `apps/web/src/components/directories/detail/DirectoryTabs.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `directoryId` | `string` | The directory's unique ID |
| `activeTab` | `string` | Currently active tab identifier |

Renders a horizontal tab navigation bar. Each tab is a link that navigates to a different section of the directory detail page. The available tabs are:

| Tab ID | Label | Visibility |
|--------|-------|------------|
| `overview` | Overview | Always |
| `items` | Items | Always |
| `generator` | Generator | Always |
| `schedule` | Schedule | Always |
| `history` | History | Always |
| `comparisons` | Comparisons | Always |
| `plugins` | Plugins | Always |
| `deploy` | Deploy | Always |
| `members` | Members | Permission-gated (hidden for viewers) |
| `settings` | Settings | Always |

The active tab is visually indicated with a primary-colored bottom border and text. Inactive tabs use muted text with a hover effect. The tab bar scrolls horizontally on small screens.

Permission gating is handled by checking `useDirectoryPermissions()` - the members tab is only rendered if the user has the `canManageMembers` permission.

```tsx
<DirectoryTabs directoryId="dir_abc123" activeTab="items" />
```

## Implementation Details

### Context Provider Pattern

The directory detail context uses the standard React Context pattern with a provider component and consumer hooks. The context is created once at the page level (typically in a server component that fetches the data, then renders the client provider):

```tsx
// Server component (page.tsx)
export default async function DirectoryPage({ params }) {
    const directory = await getDirectory(params.id);
    const config = await getDirectoryConfig(params.id);
    const oauth = await getOAuthConnection(params.id);

    return (
        <DirectoryDetailProvider
            directory={directory}
            oauthConnection={oauth}
            config={config}
        >
            <DirectoryHeader directoryId={params.id} />
            <DirectoryTabs directoryId={params.id} activeTab="overview" />
            {/* Tab content */}
        </DirectoryDetailProvider>
    );
}
```

### Generation Status Badge

The generation status badge in `DirectoryHeader` is a dynamic indicator that reflects the directory's current generation state:

- **Idle** - No badge or a muted "Ready" indicator.
- **Queued** - Yellow badge with a clock icon.
- **In Progress** - Animated blue badge showing the current step (e.g., "Analyzing repository", "Generating items", "Building markdown"). The step count is shown as "Step N/M".
- **Completed** - Green badge with a check icon.
- **Failed** - Red badge with an error icon.

The badge polls or receives real-time updates to reflect generation progress.

### Repository Link Resolution

Repository links are computed based on the git provider type:

| Provider | URL Pattern |
|----------|-------------|
| GitHub | `https://github.com/{owner}/{repo}` |
| GitLab | `https://gitlab.com/{owner}/{repo}` |
| Bitbucket | `https://bitbucket.org/{owner}/{repo}` |

Each of the three repo types (main, data, website) can be null if the repository has not been created or linked yet.

### Tab Routing

Tabs use Next.js App Router for navigation. Each tab corresponds to a nested route segment:

```
/dashboard/directories/[id]/overview
/dashboard/directories/[id]/items
/dashboard/directories/[id]/generator
...
```

The `activeTab` prop is derived from the current URL segment and used to highlight the active tab.

## Styling & Theming

The directory detail components follow the standard design token patterns:

| Element | Classes |
|---------|---------|
| Header background | `bg-surface dark:bg-surface-dark` |
| Tab bar | `border-b border-border dark:border-border-dark` |
| Active tab | `text-primary border-b-2 border-primary` |
| Inactive tab | `text-text-muted dark:text-text-muted-dark hover:text-text` |
| Status badges | Variant-specific: `bg-primary/10 text-primary`, `bg-success/10 text-success`, `bg-danger/10 text-danger` |
| Role badges | `bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted` |

The generation status badge uses Tailwind's `animate-pulse` for the in-progress state.

## Usage Examples

### Full Directory Detail Page Assembly

```tsx
import { DirectoryDetailProvider } from '@/components/directories/detail/DirectoryDetailContext';
import { DirectoryHeader } from '@/components/directories/detail/DirectoryHeader';
import { DirectoryTabs } from '@/components/directories/detail/DirectoryTabs';

export default async function DirectoryDetailPage({ params, searchParams }) {
    const { id } = params;
    const activeTab = searchParams.tab || 'overview';

    const [directory, config, oauth] = await Promise.all([
        getDirectory(id),
        getDirectoryConfig(id),
        getOAuthConnection(id),
    ]);

    return (
        <DirectoryDetailProvider
            directory={directory}
            oauthConnection={oauth}
            config={config}
        >
            <div className="space-y-6">
                <DirectoryHeader directoryId={id} />
                <DirectoryTabs directoryId={id} activeTab={activeTab} />
                {/* Render active tab content */}
            </div>
        </DirectoryDetailProvider>
    );
}
```

### Consuming Context in a Tab Component

```tsx
'use client';

import { useDirectoryDetail, useDirectoryPermissions } from '../DirectoryDetailContext';

export function OverviewTab() {
    const { directory, config, repoLinks } = useDirectoryDetail();
    const permissions = useDirectoryPermissions();

    return (
        <div>
            <h2>{directory.name}</h2>
            {repoLinks.main && (
                <a href={repoLinks.main} target="_blank" rel="noopener">
                    View Repository
                </a>
            )}
            {permissions.canEdit && <Button>Edit Directory</Button>}
        </div>
    );
}
```

## Related Components

- [Import Flow Components](./import-flow-components.md) - Import/link flow creates directories that feed into this detail view
- [Settings Components](./settings-components.md) - Plugin settings shared pattern with directory-level plugin config
- [UI Component Library](./ui-component-library.md) - Button, Dialog, Input, CollapsibleCard used throughout tabs
- [Server Actions Deep Dive](./server-actions-deep-dive.md) - Directory CRUD, generation, and sync actions
