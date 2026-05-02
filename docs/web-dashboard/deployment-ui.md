---
id: deployment-ui
title: Deployment Interface
sidebar_label: Deployment UI
sidebar_position: 16
---

# Deployment Interface

The deployment interface allows users to deploy their generated work websites to hosting providers (e.g., Vercel, Netlify) directly from the Ever Works dashboard. It handles provider selection, authentication token management, website configuration, team selection, and deployment progress tracking.

## Component Hierarchy

```
DeployPage (server component)
  |
  +-- DeployProviderSelector
  |     +-- PluginIcon
  |     +-- Provider list / dropdown
  |
  +-- DeployTokenAlert (shown when no token configured)
  |     +-- Configure button -> Plugin settings
  |     +-- Get Token button -> Provider homepage
  |     +-- How-to steps
  |
  +-- SharedWorkNoTokenAlert (shown for shared works without token)
  |
  +-- DeployForm
        +-- DeployConfigDialog
        |     +-- WebsiteSettingsFormContent
        |     +-- Save & Deploy / Skip & Deploy buttons
        |
        +-- TeamSelectionDialog
        |     +-- Team dropdown (Select)
        |
        +-- Deploy Section (trigger button + status)
        +-- UpdateWebsiteRepository
        +-- WebsiteTemplateSettings
              +-- Auto-update toggle (Switch)
              +-- Use beta toggle (Switch)
              +-- Last updated / Last checked timestamps
              +-- Error display
```

## Key Components

### DeployProviderSelector

**File**: `apps/web/src/components/works/detail/deploy/DeployProviderSelector.tsx`

Displays available deployment providers and lets the user select or switch between them.

```typescript
interface DeployProviderSelectorProps {
	workId: string;
	providers: DeployProvider[]; // from plugin capabilities API
	currentProviderId: string;
}
```

**Behavior**:

- If no provider is selected: shows a full card list with radio-style selection
- If one provider is selected and it is the only one: hides completely
- If multiple providers exist with one selected: shows a compact dropdown switcher
- If no enabled providers: shows a warning message with a plug icon
- On provider change, calls `updateDeployProvider` server action and refreshes the page

### DeployTokenAlert

**File**: `apps/web/src/components/works/detail/deploy/DeployTokenAlert.tsx`

Shown when the selected deployment provider has no API token configured.

```typescript
interface DeployTokenAlertProps {
	providerId?: string;
	providerName?: string;
	providerHomepage?: string; // e.g., Vercel token management URL
}
```

Renders:

- Warning icon with title and description
- "Configure Plugin" button linking to `ROUTES.DASHBOARD_PLUGIN_DETAIL(providerId)`
- "Get Token" button linking to the provider's homepage URL
- Step-by-step instructions (4 steps) for obtaining and configuring a token

### DeployForm

**File**: `apps/web/src/components/works/detail/deploy/DeployForm.tsx`

The main deployment form with three sections: deploy trigger, repository update, and template settings.

```typescript
interface DeployFormProps {
	work: Work;
	isDeploying?: boolean;
	providerName?: string;
}
```

**Deployment Flow**:

1. User clicks the deploy button
2. `DeployConfigDialog` opens for website settings configuration
3. User chooses "Save & Deploy" (saves settings first) or "Skip & Deploy"
4. If the user has multiple teams, `TeamSelectionDialog` opens for team/scope selection
5. `deploy(workId, teamScope?)` server action is called
6. Page auto-refreshes on interval while `isDeploying` is true via `pageIntervalRefresh`
7. Success/failure toast notifications are displayed

**Deployment States**: `INITIALIZING`, `READY`, `pending`, `success`

### DeployConfigDialog

**File**: `apps/web/src/components/works/detail/deploy/DeployConfigDialog.tsx`

A modal dialog that loads current website settings and allows editing before deployment.

```typescript
interface DeployConfigDialogProps {
	open: boolean;
	workId: string;
	isSubmitting?: boolean;
	onConfirm: (settings: DeployConfigData | null) => void;
	onCancel: () => void;
}
```

Uses `useWebsiteSettingsForm` hook to load/manage settings with subsections for header, homepage, and footer configuration.

### TeamSelectionDialog

**File**: `apps/web/src/components/works/detail/deploy/TeamSelectionDialog.tsx`

Shown when the deployment provider account has multiple teams (e.g., Vercel teams).

```typescript
interface DeployTeam {
	id: string;
	slug: string;
	name: string | null;
}

interface TeamSelectionDialogProps {
	open: boolean;
	teams: DeployTeam[];
	isSubmitting?: boolean;
	providerName?: string;
	onConfirm: (teamScope: string) => void;
	onCancel: () => void;
}
```

## State Management

| State                | Scope            | Source                                   |
| -------------------- | ---------------- | ---------------------------------------- |
| `isDeploying`        | Page-level       | Derived from `work.deploymentState` |
| `deployTeams`        | DeployForm       | Fetched via `getDeploymentTeams` action  |
| `isConfigDialogOpen` | DeployForm       | Local `useState`                         |
| `isTeamDialogOpen`   | DeployForm       | Local `useState`                         |
| `selectedProvider`   | ProviderSelector | Local `useState`, persisted via action   |
| `autoUpdate`         | TemplateSettings | Local `useState`, synced via action      |
| `useBeta`            | TemplateSettings | Local `useState`, synced via action      |
| `formData`           | ConfigDialog     | `useWebsiteSettingsForm` hook            |

All server mutations use React `useTransition` for non-blocking updates with `isPending` states.

## Related API Endpoints

| Action                      | Server Action Function                                 | HTTP Method |
| --------------------------- | ------------------------------------------------------ | ----------- |
| Deploy work            | `deploy(workId, teamScope?)`                      | POST        |
| Get deployment teams        | `getDeploymentTeams(workId)`                      | GET         |
| Look up existing deployment | `lookupExistingDeployment(workId)`                | GET         |
| Update website repository   | `updateWebsiteRepository(workId)`                 | POST        |
| Update template settings    | `updateWebsiteTemplateSettings(workId, settings)` | PATCH       |
| Update deploy provider      | `updateDeployProvider(workId, providerId)`        | PATCH       |
| Update website settings     | `updateWebsiteSettings(workId, settings)`         | PATCH       |

## Internationalization

All user-facing strings use `next-intl` with the namespace `dashboard.workDetail.deploy`. Key translation groups:

- `form.deployment.*` -- Deploy button labels and status messages
- `form.updateRepository.*` -- Repository update section
- `form.websiteTemplate.*` -- Template auto-update settings
- `form.configDialog.*` -- Website configuration dialog
- `noTokenAlert.*` -- Token missing alert and how-to steps
- `sharedNoTokenAlert.*` -- Alert for shared work members
- `noProviderAlert.*` -- No provider selected alert

## Cross-References

- [Performance Monitoring](../devops/performance-monitoring.md) -- tracking deployment success rates
- [Items Management UI](./items-ui.md) -- managing content before deployment
- [Schedule UI](./schedule-ui.md) -- automated generation before deployment
