---
id: work-pages
title: Work Management Pages
sidebar_label: Work Pages
sidebar_position: 9
---

# Work Management Pages

Works are the core domain object in Ever Works. The web dashboard provides a comprehensive set of pages for creating, viewing, editing, and managing works. All work pages live under the `(dashboard)/works/` route group and require authentication.

## Route Structure

```
/[locale]/(dashboard)/works/
  page.tsx                          # Work list page
  works-client.tsx            # Client component for the list
  new/
    page.tsx                        # New work creation page
  [id]/
    layout.tsx                      # Work detail layout (shared across sub-pages)
    page.tsx                        # Work overview/detail page
    comparisons/
      page.tsx                      # Comparisons list
      [slug]/page.tsx               # Single comparison detail
    deploy/page.tsx                 # Deployment management
    generator/page.tsx              # Item generation interface
    history/page.tsx                # Generation history log
    items/page.tsx                  # Item list management
    members/page.tsx                # Team member management
    plugins/page.tsx                # Work plugin configuration
    schedule/page.tsx               # Auto-generation schedule
    settings/page.tsx               # Work settings
```

## Work List Page

**Route**: `/works`

The list page displays all works owned by or shared with the current user.

**Server Component** (`page.tsx`):

- Fetches works via the `getWorks` server action
- Passes data to `WorksClient` component

**Client Component** (`works-client.tsx`):

- Search input with debounced filtering
- Grid/list view toggle
- Work cards showing name, description, item count, status
- "Create New" button linking to `/works/new`
- Keyboard shortcut: `Ctrl/Cmd+K` focuses the search input (via `useKeyboardShortcuts`)

## New Work Page

**Route**: `/works/new`

The creation page supports three flows:

| Flow               | Description                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------ |
| **Create with AI** | User provides a name and prompt; AI generates work details and starts item generation |
| **Manual Create**  | User fills in slug, name, description, and provider selections manually                    |
| **Import**         | User provides a repository URL or selects from existing repos to import                    |

All flows require a connected git provider. If none is connected, the page shows a prompt to connect one via the OAuth flow.

**AI Creation Flow**:

1. User enters a work name and natural language prompt
2. Selects AI provider and optional providers (search, screenshot, content extractor, pipeline)
3. Calls `createWorkWithAI` server action
4. Returns immediately with `isGenerating: true` -- generation continues in background
5. Redirects to the new work's generator page to track progress

**Import Flow**:

1. User pastes a repository URL or browses their repositories via `getUserRepositories`
2. System analyzes the repository via `analyzeRepository` or `analyzeForLinking`
3. Supports three import source types: `data_repo`, `awesome_readme`, `link_existing`
4. Calls `importWork` server action with provider and organization settings

## Work Detail Layout

**Route**: `/works/[id]`
**File**: `[id]/layout.tsx`

The detail layout wraps all sub-pages with shared navigation:

- Fetches work data server-side
- Provides sub-navigation tabs for all work sections
- Passes the work context to child pages

**Sub-Navigation Tabs**:

| Tab         | Route                           | Description                       |
| ----------- | ------------------------------- | --------------------------------- |
| Overview    | `/works/[id]`             | Work stats and quick actions |
| Items       | `/works/[id]/items`       | Manage work items            |
| Generator   | `/works/[id]/generator`   | Run item generation               |
| Comparisons | `/works/[id]/comparisons` | Item comparison pages             |
| History     | `/works/[id]/history`     | Generation run history            |
| Members     | `/works/[id]/members`     | Team access management            |
| Plugins     | `/works/[id]/plugins`     | Work-level plugin config     |
| Schedule    | `/works/[id]/schedule`    | Auto-generation scheduling        |
| Deploy      | `/works/[id]/deploy`      | Website deployment                |
| Settings    | `/works/[id]/settings`    | Work configuration           |

## Work Overview Page

**Route**: `/works/[id]`

Displays a summary dashboard for the work:

- Work name, description, and creation date
- Item count and category breakdown
- Recent generation activity
- Quick action buttons (generate, deploy, add item)
- Git provider connection status

## Items Page

**Route**: `/works/[id]/items`

Manages the work's item collection:

- Paginated item table with search and category filtering
- Add Item modal with AI-powered extraction from URL (`extractItemDetails`)
- Edit item metadata inline
- Delete items with optional PR creation
- Screenshot capture for items via `captureScreenshot`

**Server Actions Used**: `addItem`, `removeItem`, `updateItem`, `extractItemDetails`, `captureScreenshot`, `checkScreenshotAvailability`

## Generator Page

**Route**: `/works/[id]/generator`

The generation interface for creating or updating work items. See the [Generation Workflow UI](./generation-ui.md) page for detailed documentation.

## Comparisons Page

**Route**: `/works/[id]/comparisons`

Manages AI-generated comparison articles between work items:

- List view of existing comparisons
- Generate next comparison automatically (`generateNextComparison`)
- Generate manual comparison by selecting two items (`generateManualComparison`)
- AI configuration panel for comparison provider and model selection
- Custom prompt editor for comparison generation
- Delete comparisons

**Server Actions Used**: `listComparisons`, `getRemainingComparisonCount`, `generateNextComparison`, `generateManualComparison`, `deleteComparison`, `getComparisonAiConfig`, `saveComparisonAiConfig`, `saveComparisonCustomPrompt`

## History Page

**Route**: `/works/[id]/history`

Displays generation run history with:

- Timeline of generation runs with status indicators
- Run details: method, item count, duration, errors
- Pagination via `fetchWorkGenerationHistory`

## Members Page

**Route**: `/works/[id]/members`

Team management interface:

| Action                 | Server Action      | Role Required          |
| ---------------------- | ------------------ | ---------------------- |
| Invite member by email | `inviteMember`     | OWNER, MANAGER         |
| Change member role     | `updateMemberRole` | OWNER, MANAGER         |
| Remove member          | `removeMember`     | OWNER, MANAGER         |
| Leave work        | `leaveWork`   | Any member (not OWNER) |

**Assignable Roles**: MANAGER, EDITOR, VIEWER (OWNER is implicit and cannot be assigned).

## Plugins Page

**Route**: `/works/[id]/plugins`

Work-level plugin configuration:

- Lists plugins enabled for the work
- Enable/disable plugins for this work
- Configure work-specific plugin settings
- Set active capabilities for multi-capability plugins

**Server Actions Used**: `enableWorkPlugin`, `disableWorkPlugin`, `updateWorkPluginSettings`, `setActiveCapability`

## Schedule Page

**Route**: `/works/[id]/schedule`

Auto-generation scheduling interface:

- Enable/disable scheduled generation
- Configure cadence (daily, weekly, monthly)
- Set billing mode and failure thresholds
- Provider overrides for scheduled runs
- Manual trigger and cancel buttons

**Server Actions Used**: `updateWorkSchedule`, `runWorkSchedule`, `cancelWorkSchedule`

## Deploy Page

**Route**: `/works/[id]/deploy`

Website deployment management:

- Deploy to connected hosting provider (e.g., Vercel)
- Team/scope selection for deployment
- Deployment status and URL display
- Website repository update trigger
- Template auto-update and beta channel settings
- Lookup existing deployments

**Server Actions Used**: `deploy`, `updateWebsiteRepository`, `getDeploymentTeams`, `lookupExistingDeployment`, `updateWebsiteTemplateSettings`

## Settings Page

**Route**: `/works/[id]/settings`

Work configuration:

- Edit name and description (`updateWork`)
- Organization and owner settings
- README header/footer configuration
- Website settings (header, homepage, footer, custom menus)
- Advanced prompts for 7 generation stages
- Repository visibility toggles (public/private)
- Community PR settings
- Taxonomy management (categories, tags, collections)
- Delete work (with confirmation)

**Server Actions Used**: `updateWork`, `deleteWork`, `getAdvancedPrompts`, `updateAdvancedPrompts`, `getWebsiteSettings`, `updateWebsiteSettings`, `updateCommunityPrSettings`, `getRepositoryVisibility`, `toggleRepositoryVisibility`, taxonomy CRUD actions
