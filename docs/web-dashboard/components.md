---
id: components
title: Dashboard Components
sidebar_label: Components
sidebar_position: 2
---

# Dashboard Components

The web dashboard organizes React components by feature area under `apps/web/src/components/`. Each subwork groups components that serve a specific part of the application.

## Component Areas

### AI Components (`components/ai/`)

Chat interface components for the AI conversation feature:

| Component           | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `ChatInterface.tsx` | Main chat UI with message list and input              |
| `ChatProvider.tsx`  | Context provider managing AI chat state and streaming |

The chat interface connects to the streaming endpoint at `/api/ai-conversations/chat/stream` and provides real-time AI responses within the dashboard.

### Auth Components (`components/auth/`)

| Component          | Purpose                                     |
| ------------------ | ------------------------------------------- |
| `social-login.tsx` | OAuth social login buttons (GitHub, Google) |

Social login components render provider-specific buttons and handle the OAuth redirect flow through the backend.

### Dashboard Components (`components/dashboard/`)

Top-level dashboard layout and home page components:

| Component                  | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `DashboardHeader.tsx`      | Top navigation bar with user menu               |
| `DashboardSidebar.tsx`     | Left sidebar navigation with route links        |
| `HelpDrawer.tsx`           | Slide-out help panel                            |
| `NotificationDropdown.tsx` | Notification bell and dropdown list             |
| `RecentActivity.tsx`       | Activity feed on the home page                  |
| `StatsOverview.tsx`        | Dashboard statistics cards (works, items, runs) |

### Work Components (`components/works/`)

Components for listing, creating, and managing works:

| Component                  | Purpose                                      |
| -------------------------- | -------------------------------------------- |
| `WorkList.tsx`             | Paginated work grid/list view                |
| `WorkCard.tsx`             | Individual work card with status and actions |
| `WorkAICreator.tsx`        | AI-powered work creation wizard              |
| `WorkManualForm.tsx`       | Manual work creation form                    |
| `WorkImportForm.tsx`       | Import work from external source             |
| `OrganizationSelector.tsx` | GitHub organization picker                   |
| `RepositorySelector.tsx`   | Repository picker for imports                |
| `RepositoryOwnerCard.tsx`  | Display card for repo owner info             |

#### Detail Subworks

The `works/detail/` subwork contains components for the work detail view, organized by tab:

| Subwork               | Purpose                            |
| --------------------- | ---------------------------------- |
| `detail/overview/`    | Work overview tab                  |
| `detail/items/`       | Items browser and editor           |
| `detail/generator/`   | AI generation controls             |
| `detail/schedule/`    | Schedule configuration             |
| `detail/deploy/`      | Deployment settings                |
| `detail/members/`     | Team member management             |
| `detail/settings/`    | Work settings form                 |
| `detail/plugins/`     | Per-work plugin toggles            |
| `detail/comparisons/` | Comparison page list               |
| `detail/history/`     | Generation run history             |
| `detail/shared/`      | Shared components used across tabs |

Key context and layout components:

- **`WorkDetailContext.tsx`** -- React context providing the current work entity and user permissions to all child tabs.
- **`WorkLayoutClient.tsx`** -- Client-side layout wrapper for the work detail view.
- **`WorkHeader.tsx`** -- Header with work name, status badge, and action buttons.
- **`WorkTabs.tsx`** -- Tab navigation for switching between detail views.
- **`WorkStatusCard.tsx`** -- Status indicator card showing generation state.
- **`PrUpdateInfo.tsx`** -- Banner showing pending community PR information.

### Plugin Components (`components/plugins/`)

Marketplace and configuration UI for the plugin system:

| Component                      | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `PluginGrid.tsx`               | Grid layout for plugin cards                       |
| `PluginCard.tsx`               | Individual plugin card with icon and status        |
| `PluginsList.tsx`              | List view alternative for plugins                  |
| `PluginSearchBar.tsx`          | Search and filter input for plugins                |
| `PluginCategoryFilter.tsx`     | Category filter chips (ai-provider, search, etc.)  |
| `PluginEnablePanel.tsx`        | Panel for enabling/disabling a plugin              |
| `PluginSettings.tsx`           | Plugin settings form container                     |
| `PluginSettingsFormFields.tsx` | Dynamic form fields generated from JSON Schema     |
| `PluginDisableWarning.tsx`     | Confirmation dialog for disabling plugins          |
| `PluginReadme.tsx`             | Rendered plugin README content                     |
| `PluginIcon.tsx`               | Plugin icon with fallback                          |
| `form/`                        | Reusable form field components for plugin settings |

### Settings Components (`components/settings/`)

Account and global settings:

| Component                    | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `ProfileSettings.tsx`        | User profile form (name, email, avatar)         |
| `SecuritySettings.tsx`       | Password change and two-factor settings         |
| `DangerZone.tsx`             | Account deletion confirmation                   |
| `GitProviderConnections.tsx` | Manage connected Git providers (GitHub OAuth)   |
| `PluginOAuthConnection.tsx`  | OAuth connection status for plugin providers    |
| `PluginSettingsInline.tsx`   | Inline plugin settings within the settings page |
| `SettingsNavItem.tsx`        | Navigation item for the settings sidebar        |

### UI Components (`components/ui/`)

Shared primitive components based on shadcn/ui:

| Component                  | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `button.tsx`               | Button with variants (default, destructive, outline, ghost) |
| `input.tsx`                | Text input field                                            |
| `textarea.tsx`             | Multi-line text area                                        |
| `auto-resize-textarea.tsx` | Textarea that grows with content                            |
| `select.tsx`               | Dropdown select                                             |
| `checkbox.tsx`             | Checkbox input                                              |
| `switch.tsx`               | Toggle switch                                               |
| `dialog.tsx`               | Modal dialog                                                |
| `dropdown-menu.tsx`        | Dropdown menu with items                                    |
| `tooltip.tsx`              | Hover tooltip                                               |
| `collapsible-card.tsx`     | Expandable/collapsible card section                         |
| `show-datetime.tsx`        | Formatted date/time display                                 |
| `top-loader.tsx`           | Page transition loading bar                                 |

### Other Components

| Work               | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `common/`          | Shared layout helpers and utility components |
| `footer/`          | Page footer                                  |
| `layout/`          | Layout wrappers for different page types     |
| `logos/`           | Logo components with light/dark mode support |
| `theme-toggle.tsx` | Dark/light theme toggle button               |
