---
id: directory-pages
title: Directory Management Pages
sidebar_label: Directory Pages
sidebar_position: 9
---

# Directory Management Pages

Directories are the core domain object in Ever Works. The web dashboard provides a comprehensive set of pages for creating, viewing, editing, and managing directories. All directory pages live under the `(dashboard)/directories/` route group and require authentication.

## Route Structure

```
/[locale]/(dashboard)/directories/
  page.tsx                          # Directory list page
  directories-client.tsx            # Client component for the list
  new/
    page.tsx                        # New directory creation page
  [id]/
    layout.tsx                      # Directory detail layout (shared across sub-pages)
    page.tsx                        # Directory overview/detail page
    comparisons/
      page.tsx                      # Comparisons list
      [slug]/page.tsx               # Single comparison detail
    deploy/page.tsx                 # Deployment management
    generator/page.tsx              # Item generation interface
    history/page.tsx                # Generation history log
    items/page.tsx                  # Item list management
    members/page.tsx                # Team member management
    plugins/page.tsx                # Directory plugin configuration
    schedule/page.tsx               # Auto-generation schedule
    settings/page.tsx               # Directory settings
```

## Directory List Page

**Route**: `/directories`

The list page displays all directories owned by or shared with the current user.

**Server Component** (`page.tsx`):
- Fetches directories via the `getDirectories` server action
- Passes data to `DirectoriesClient` component

**Client Component** (`directories-client.tsx`):
- Search input with debounced filtering
- Grid/list view toggle
- Directory cards showing name, description, item count, status
- "Create New" button linking to `/directories/new`
- Keyboard shortcut: `Ctrl/Cmd+K` focuses the search input (via `useKeyboardShortcuts`)

## New Directory Page

**Route**: `/directories/new`

The creation page supports three flows:

| Flow | Description |
|------|-------------|
| **Create with AI** | User provides a name and prompt; AI generates directory details and starts item generation |
| **Manual Create** | User fills in slug, name, description, and provider selections manually |
| **Import** | User provides a repository URL or selects from existing repos to import |

All flows require a connected git provider. If none is connected, the page shows a prompt to connect one via the OAuth flow.

**AI Creation Flow**:
1. User enters a directory name and natural language prompt
2. Selects AI provider and optional providers (search, screenshot, content extractor, pipeline)
3. Calls `createDirectoryWithAI` server action
4. Returns immediately with `isGenerating: true` -- generation continues in background
5. Redirects to the new directory's generator page to track progress

**Import Flow**:
1. User pastes a repository URL or browses their repositories via `getUserRepositories`
2. System analyzes the repository via `analyzeRepository` or `analyzeForLinking`
3. Supports three import source types: `data_repo`, `awesome_readme`, `link_existing`
4. Calls `importDirectory` server action with provider and organization settings

## Directory Detail Layout

**Route**: `/directories/[id]`
**File**: `[id]/layout.tsx`

The detail layout wraps all sub-pages with shared navigation:

- Fetches directory data server-side
- Provides sub-navigation tabs for all directory sections
- Passes the directory context to child pages

**Sub-Navigation Tabs**:

| Tab | Route | Description |
|-----|-------|-------------|
| Overview | `/directories/[id]` | Directory stats and quick actions |
| Items | `/directories/[id]/items` | Manage directory items |
| Generator | `/directories/[id]/generator` | Run item generation |
| Comparisons | `/directories/[id]/comparisons` | Item comparison pages |
| History | `/directories/[id]/history` | Generation run history |
| Members | `/directories/[id]/members` | Team access management |
| Plugins | `/directories/[id]/plugins` | Directory-level plugin config |
| Schedule | `/directories/[id]/schedule` | Auto-generation scheduling |
| Deploy | `/directories/[id]/deploy` | Website deployment |
| Settings | `/directories/[id]/settings` | Directory configuration |

## Directory Overview Page

**Route**: `/directories/[id]`

Displays a summary dashboard for the directory:

- Directory name, description, and creation date
- Item count and category breakdown
- Recent generation activity
- Quick action buttons (generate, deploy, add item)
- Git provider connection status

## Items Page

**Route**: `/directories/[id]/items`

Manages the directory's item collection:

- Paginated item table with search and category filtering
- Add Item modal with AI-powered extraction from URL (`extractItemDetails`)
- Edit item metadata inline
- Delete items with optional PR creation
- Screenshot capture for items via `captureScreenshot`

**Server Actions Used**: `addItem`, `removeItem`, `updateItem`, `extractItemDetails`, `captureScreenshot`, `checkScreenshotAvailability`

## Generator Page

**Route**: `/directories/[id]/generator`

The generation interface for creating or updating directory items. See the [Generation Workflow UI](./generation-ui.md) page for detailed documentation.

## Comparisons Page

**Route**: `/directories/[id]/comparisons`

Manages AI-generated comparison articles between directory items:

- List view of existing comparisons
- Generate next comparison automatically (`generateNextComparison`)
- Generate manual comparison by selecting two items (`generateManualComparison`)
- AI configuration panel for comparison provider and model selection
- Custom prompt editor for comparison generation
- Delete comparisons

**Server Actions Used**: `listComparisons`, `getRemainingComparisonCount`, `generateNextComparison`, `generateManualComparison`, `deleteComparison`, `getComparisonAiConfig`, `saveComparisonAiConfig`, `saveComparisonCustomPrompt`

## History Page

**Route**: `/directories/[id]/history`

Displays generation run history with:

- Timeline of generation runs with status indicators
- Run details: method, item count, duration, errors
- Pagination via `fetchDirectoryGenerationHistory`

## Members Page

**Route**: `/directories/[id]/members`

Team management interface:

| Action | Server Action | Role Required |
|--------|--------------|---------------|
| Invite member by email | `inviteMember` | OWNER, MANAGER |
| Change member role | `updateMemberRole` | OWNER, MANAGER |
| Remove member | `removeMember` | OWNER, MANAGER |
| Leave directory | `leaveDirectory` | Any member (not OWNER) |

**Assignable Roles**: MANAGER, EDITOR, VIEWER (OWNER is implicit and cannot be assigned).

## Plugins Page

**Route**: `/directories/[id]/plugins`

Directory-level plugin configuration:

- Lists plugins enabled for the directory
- Enable/disable plugins for this directory
- Configure directory-specific plugin settings
- Set active capabilities for multi-capability plugins

**Server Actions Used**: `enableDirectoryPlugin`, `disableDirectoryPlugin`, `updateDirectoryPluginSettings`, `setActiveCapability`

## Schedule Page

**Route**: `/directories/[id]/schedule`

Auto-generation scheduling interface:

- Enable/disable scheduled generation
- Configure cadence (daily, weekly, monthly)
- Set billing mode and failure thresholds
- Provider overrides for scheduled runs
- Manual trigger and cancel buttons

**Server Actions Used**: `updateDirectorySchedule`, `runDirectorySchedule`, `cancelDirectorySchedule`

## Deploy Page

**Route**: `/directories/[id]/deploy`

Website deployment management:

- Deploy to connected hosting provider (e.g., Vercel)
- Team/scope selection for deployment
- Deployment status and URL display
- Website repository update trigger
- Template auto-update and beta channel settings
- Lookup existing deployments

**Server Actions Used**: `deploy`, `updateWebsiteRepository`, `getDeploymentTeams`, `lookupExistingDeployment`, `updateWebsiteTemplateSettings`

## Settings Page

**Route**: `/directories/[id]/settings`

Directory configuration:

- Edit name and description (`updateDirectory`)
- Organization and owner settings
- README header/footer configuration
- Website settings (header, homepage, footer, custom menus)
- Advanced prompts for 7 generation stages
- Repository visibility toggles (public/private)
- Community PR settings
- Taxonomy management (categories, tags, collections)
- Delete directory (with confirmation)

**Server Actions Used**: `updateDirectory`, `deleteDirectory`, `getAdvancedPrompts`, `updateAdvancedPrompts`, `getWebsiteSettings`, `updateWebsiteSettings`, `updateCommunityPrSettings`, `getRepositoryVisibility`, `toggleRepositoryVisibility`, taxonomy CRUD actions
