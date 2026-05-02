---
id: work-detail-components
title: Work Detail Components
sidebar_label: Work Detail
sidebar_position: 26
---

# Work Detail Components

## Overview

The work detail components form the most complex view in the Ever Works dashboard. They display and manage all aspects of a single work: metadata, items, AI generation, scheduling, deployment, history, comparisons, plugins, members, and settings. The components live in `apps/web/src/components/works/detail/` and are organized into sub-folders by tab. A React Context (`WorkDetailContext`) provides shared work state to all child components.

## Architecture

```
WorkDetailContext (React Context Provider)
├── work: WorkDto
├── oauthConnection: OAuthConnectionDto | null
├── config: WorkConfigDto
├── repoLinks: { main, dataRepo, websiteRepo }
├── permissions: PermissionsMap
│
├── WorkHeader
│   ├── Work name + shared role badge
│   ├── Generation status badge (with step progress)
│   ├── Slug, owner, git provider link
│   ├── Creation date, website link
│   └── Action buttons
│
├── WorkTabs
│   ├── overview/     → Work overview stats and info
│   ├── items/        → Item listing, CRUD, filtering
│   ├── generator/    → AI generation configuration and execution
│   ├── schedule/     → Automated generation scheduling
│   ├── history/      → Generation history and logs
│   ├── comparisons/  → Item comparison management
│   ├── plugins/      → Work-level plugin configuration
│   ├── deploy/       → Website deployment settings
│   ├── members/      → Team member management (permission-gated)
│   └── settings/     → Work settings, prompts, website config
│
└── shared/           → Shared sub-components (status badges, selectors)
```

The work detail page can contain around 70 files across all sub-folders. This document covers the three foundational components: the context provider, header, and tab navigation.

## Components

### WorkDetailContext

**File:** `apps/web/src/components/works/detail/WorkDetailContext.tsx`

This component is a React Context provider that wraps the entire work detail page. It accepts the work's core data as props and makes it available to all descendant components via two hooks:

| Hook                   | Returns            | Purpose                                         |
| ---------------------- | ------------------ | ----------------------------------------------- |
| `useWorkDetail()`      | Full context value | Access work, config, OAuth, repo links          |
| `useWorkPermissions()` | `PermissionsMap`   | Check specific permissions for the current user |

**Context value shape:**

```typescript
interface WorkDetailContextValue {
	work: WorkDto;
	oauthConnection: OAuthConnectionDto | null;
	config: WorkConfigDto;
	repoLinks: {
		main: string | null;
		dataRepo: string | null;
		websiteRepo: string | null;
	};
	permissions: PermissionsMap;
}
```

**Repo links** are computed from the work's git provider and repository data. Each link is a fully qualified URL to the repository on GitHub, GitLab, or Bitbucket. The three repo types are:

- `main` - The primary code/data repository.
- `dataRepo` - The repository containing generated work data.
- `websiteRepo` - The repository for the deployed website.

**Permissions** are resolved via a `getPermissions` utility that maps the current user's role (owner, admin, editor, viewer) to specific boolean flags.

```tsx
import { WorkDetailProvider, useWorkDetail } from './WorkDetailContext';

// Provider wraps the entire detail page
<WorkDetailProvider work={workData} oauthConnection={oauthConn} config={dirConfig}>
	<WorkHeader />
	<WorkTabs />
</WorkDetailProvider>;

// Consumer hook in any child component
function SomeChildComponent() {
	const { work, repoLinks } = useWorkDetail();
	const permissions = useWorkPermissions();

	if (!permissions.canEdit) return <p>Read-only access</p>;
	return <p>{work.name}</p>;
}
```

### WorkHeader

**File:** `apps/web/src/components/works/detail/WorkHeader.tsx`

| Prop     | Type     | Description          |
| -------- | -------- | -------------------- |
| `workId` | `string` | The work's unique ID |

This component consumes `useWorkDetail()` and renders the work's header section with:

1. **Title row:**
    - Work name as an `h1`.
    - Shared role badge (if the work is shared with the current user, shows their role: admin, editor, viewer).
    - Generation status badge showing the current generation state. If generation is in progress, it shows a step indicator (e.g., "Step 2/5: Generating items") with a progress animation.

2. **Metadata row:**
    - Slug displayed as a code-formatted span.
    - Owner name.
    - Git provider link (opens the repository in a new tab) with the provider icon.
    - Creation date formatted with `toLocaleDateString`.
    - Website link (if deployed) opening in a new tab.

3. **Action buttons:** Context-dependent actions like sync, edit, or generate, shown based on the user's permissions from `useWorkPermissions()`.

```tsx
<WorkHeader workId="dir_abc123" />
```

### WorkTabs

**File:** `apps/web/src/components/works/detail/WorkTabs.tsx`

| Prop        | Type     | Description                     |
| ----------- | -------- | ------------------------------- |
| `workId`    | `string` | The work's unique ID            |
| `activeTab` | `string` | Currently active tab identifier |

Renders a horizontal tab navigation bar. Each tab is a link that navigates to a different section of the work detail page. The available tabs are:

| Tab ID        | Label       | Visibility                            |
| ------------- | ----------- | ------------------------------------- |
| `overview`    | Overview    | Always                                |
| `items`       | Items       | Always                                |
| `generator`   | Generator   | Always                                |
| `schedule`    | Schedule    | Always                                |
| `history`     | History     | Always                                |
| `comparisons` | Comparisons | Always                                |
| `plugins`     | Plugins     | Always                                |
| `deploy`      | Deploy      | Always                                |
| `members`     | Members     | Permission-gated (hidden for viewers) |
| `settings`    | Settings    | Always                                |

The active tab is visually indicated with a primary-colored bottom border and text. Inactive tabs use muted text with a hover effect. The tab bar scrolls horizontally on small screens.

Permission gating is handled by checking `useWorkPermissions()` - the members tab is only rendered if the user has the `canManageMembers` permission.

```tsx
<WorkTabs workId="dir_abc123" activeTab="items" />
```

## Implementation Details

### Context Provider Pattern

The work detail context uses the standard React Context pattern with a provider component and consumer hooks. The context is created once at the page level (typically in a server component that fetches the data, then renders the client provider):

```tsx
// Server component (page.tsx)
export default async function WorkPage({ params }) {
	const work = await getWork(params.id);
	const config = await getWorkConfig(params.id);
	const oauth = await getOAuthConnection(params.id);

	return (
		<WorkDetailProvider work={work} oauthConnection={oauth} config={config}>
			<WorkHeader workId={params.id} />
			<WorkTabs workId={params.id} activeTab="overview" />
			{/* Tab content */}
		</WorkDetailProvider>
	);
}
```

### Generation Status Badge

The generation status badge in `WorkHeader` is a dynamic indicator that reflects the work's current generation state:

- **Idle** - No badge or a muted "Ready" indicator.
- **Queued** - Yellow badge with a clock icon.
- **In Progress** - Animated blue badge showing the current step (e.g., "Analyzing repository", "Generating items", "Building markdown"). The step count is shown as "Step N/M".
- **Completed** - Green badge with a check icon.
- **Failed** - Red badge with an error icon.

The badge polls or receives real-time updates to reflect generation progress.

### Repository Link Resolution

Repository links are computed based on the git provider type:

| Provider  | URL Pattern                            |
| --------- | -------------------------------------- |
| GitHub    | `https://github.com/{owner}/{repo}`    |
| GitLab    | `https://gitlab.com/{owner}/{repo}`    |
| Bitbucket | `https://bitbucket.org/{owner}/{repo}` |

Each of the three repo types (main, data, website) can be null if the repository has not been created or linked yet.

### Tab Routing

Tabs use Next.js App Router for navigation. Each tab corresponds to a nested route segment:

```
/dashboard/works/[id]/overview
/dashboard/works/[id]/items
/dashboard/works/[id]/generator
...
```

The `activeTab` prop is derived from the current URL segment and used to highlight the active tab.

## Styling & Theming

The work detail components follow the standard design token patterns:

| Element           | Classes                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Header background | `bg-surface dark:bg-surface-dark`                                                                        |
| Tab bar           | `border-b border-border dark:border-border-dark`                                                         |
| Active tab        | `text-primary border-b-2 border-primary`                                                                 |
| Inactive tab      | `text-text-muted dark:text-text-muted-dark hover:text-text`                                              |
| Status badges     | Variant-specific: `bg-primary/10 text-primary`, `bg-success/10 text-success`, `bg-danger/10 text-danger` |
| Role badges       | `bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted`                                    |

The generation status badge uses Tailwind's `animate-pulse` for the in-progress state.

## Usage Examples

### Full Work Detail Page Assembly

```tsx
import { WorkDetailProvider } from '@/components/works/detail/WorkDetailContext';
import { WorkHeader } from '@/components/works/detail/WorkHeader';
import { WorkTabs } from '@/components/works/detail/WorkTabs';

export default async function WorkDetailPage({ params, searchParams }) {
	const { id } = params;
	const activeTab = searchParams.tab || 'overview';

	const [work, config, oauth] = await Promise.all([getWork(id), getWorkConfig(id), getOAuthConnection(id)]);

	return (
		<WorkDetailProvider work={work} oauthConnection={oauth} config={config}>
			<div className="space-y-6">
				<WorkHeader workId={id} />
				<WorkTabs workId={id} activeTab={activeTab} />
				{/* Render active tab content */}
			</div>
		</WorkDetailProvider>
	);
}
```

### Consuming Context in a Tab Component

```tsx
'use client';

import { useWorkDetail, useWorkPermissions } from '../WorkDetailContext';

export function OverviewTab() {
	const { work, config, repoLinks } = useWorkDetail();
	const permissions = useWorkPermissions();

	return (
		<div>
			<h2>{work.name}</h2>
			{repoLinks.main && (
				<a href={repoLinks.main} target="_blank" rel="noopener">
					View Repository
				</a>
			)}
			{permissions.canEdit && <Button>Edit Work</Button>}
		</div>
	);
}
```

## Related Components

- [Import Flow Components](./import-flow-components.md) - Import/link flow creates works that feed into this detail view
- [Settings Components](./settings-components.md) - Plugin settings shared pattern with work-level plugin config
- [UI Component Library](./ui-component-library.md) - Button, Dialog, Input, CollapsibleCard used throughout tabs
- [Server Actions Deep Dive](./server-actions-deep-dive.md) - Work CRUD, generation, and sync actions
