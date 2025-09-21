# Directory Detail Page Implementation Plan

## Overview
Implement a comprehensive directory detail page using Next.js nested routing with sub-pages. The page will display directory information, items, generation status, and provide an interface for generating/regenerating items.

## Business Requirements Analysis

### Current System Understanding
1. **Directory Creation Flow**: Two modes - AI-based and Manual creation
2. **APIs Available**:
   - `directoryAPI`: CRUD operations for directories
   - `itemsGeneratorAPI`: Generate/update items, submit/remove items, extract details
3. **Generation Status**:
   - Directories can have status: `generating`, `generated`, or `error`
   - `null` or `undefined` means no generation started or newly created
   - Status should be prominently displayed with real-time updates
4. **Key Components Pattern**:
   - Using modular UI components from `/components/ui/`
   - Following light/dark theme patterns
   - Component separation for maintainability

## Architecture Design

### Routing Structure (Next.js App Router)
```
/directories/[id]/
├── layout.tsx (Shared layout with header and tab navigation)
├── page.tsx (Redirects to /overview)
├── overview/
│   └── page.tsx (Directory details and statistics)
├── items/
│   └── page.tsx (Display and manage items)
├── generator/
│   └── page.tsx (Generate/regenerate items form)
└── settings/
    └── page.tsx (Directory configuration and README settings)
```

### Components Structure
```
/components/directories/detail/
├── DirectoryHeader.tsx (Shared header with status)
├── DirectoryTabs.tsx (Navigation tabs - link based)
├── DirectoryStatusCard.tsx (Generation status display)
├── overview/
│   ├── DirectoryInfo.tsx (Basic info display)
│   ├── DirectoryStats.tsx (Statistics cards)
│   └── DirectoryActivity.tsx (Recent activity)
├── items/
│   ├── ItemsList.tsx (Items display with search)
│   ├── ItemCard.tsx (Individual item card)
│   └── ItemsEmptyState.tsx (No items state)
├── generator/
│   ├── GeneratorForm.tsx (Main form container)
│   ├── RequiredFields.tsx (Essential fields)
│   ├── CompanyFields.tsx (Company info)
│   ├── CategoriesFields.tsx (Categories config)
│   ├── SourceFields.tsx (URLs and sources)
│   ├── ConfigFields.tsx (Advanced configuration)
│   └── GenerationProgress.tsx (Live progress display)
└── settings/
    ├── ReadmeConfig.tsx (README settings)
    ├── RepositorySettings.tsx (Repo configuration)
    └── DangerZone.tsx (Delete directory)
```

## Component Details

### 1. **Layout Component** (`layout.tsx`)
- Server component that fetches directory data once
- Provides directory data to all sub-pages
- Contains shared DirectoryHeader and DirectoryTabs
- Handles loading and error states

### 2. **Directory Header** (`DirectoryHeader.tsx`)
- Display directory name, slug, description
- **Prominent status display**:
  - Badge with status (Not Started, Generating, Generated, Error)
  - Progress indicator for generating status
  - Last updated timestamp
- Repository provider info (GitHub/GitLab/etc.)
- Organization/owner details if applicable
- Quick actions dropdown (Edit, Delete, Export)

### 3. **Directory Status Card** (`DirectoryStatusCard.tsx`)
- Dedicated card for generation status
- Shows current step if generating
- Error details if failed
- Success metrics if completed
- "Start Generation" button if not started

### 4. **Tab Navigation** (`DirectoryTabs.tsx`)
- Four tabs: Overview, Items, Generator, Settings
- Uses Next.js Link components for navigation
- Active tab based on current route
- Badge with item count on Items tab
- Warning indicator on Generator tab if action needed
- Responsive: horizontal on desktop, dropdown on mobile

### 5. **Overview Page** (`overview/page.tsx`)
- **DirectoryStatusCard** - Prominent status display
- **DirectoryInfo** - Basic metadata
- **DirectoryStats** - Statistics cards:
  - Total items count
  - Categories count
  - Last generation date
  - Success rate
- **DirectoryActivity** - Recent changes/updates
- Quick actions buttons

### 6. **Items Page** (`items/page.tsx`)
- Fetch and display items using `directoryAPI.getItems(id)`
- **Search bar** with real-time filtering
- **View toggle**: List/Grid/Compact
- **Sorting options**: Name, Date, Category
- **Filter by category** sidebar
- **Bulk actions**: Select multiple items
- **Item actions**: View, Edit, Remove
- **Empty state** with CTA to generate items
- **Pagination** or infinite scroll

### 7. **Generator Page** (`generator/page.tsx`)
- **Status check first**: Disable if generating
- **GenerationProgress** component if generating
- Main form container with sections
- **Auto-save** draft functionality
- **Validation** before submission
- **Preview** of what will be generated

### 8. **Settings Page** (`settings/page.tsx`)
- **README Configuration**
- **Repository Settings**
- **Webhook Configuration**
- **Access Control**
- **Danger Zone** with delete option

### 9. **Generator Form Components**:

#### RequiredFields.tsx
- Name (required)
- Prompt (required)
- Repository description

#### CompanyFields.tsx
- Company name
- Company website
- Collapsible section

#### CategoriesFields.tsx
- Initial categories (array input)
- Priority categories (array input)
- Target keywords (array input)
- Collapsible section

#### SourceFields.tsx
- Source URLs (dynamic list)
- Add/remove URL functionality
- Collapsible section

#### ConfigFields.tsx (Advanced)
- Generation method (CREATE_UPDATE/RECREATE)
- Update with pull request (checkbox)
- Badge evaluation enabled (checkbox)
- Website repository creation method
- AI configuration settings
- Collapsible section with "Advanced Settings" label

#### GenerationStatus.tsx
- Display current generation status
- Show progress steps
- Error handling and display
- Success state

## Form Field Grouping Strategy

### Required Section (Always Visible)
1. Name
2. Prompt
3. Repository Description

### Optional Sections (Collapsible)
1. **Company Information**
   - Company name
   - Company website

2. **Categories & Keywords**
   - Initial categories
   - Priority categories
   - Target keywords

3. **Source Configuration**
   - Source URLs list

4. **Advanced Configuration**
   - Generation method
   - Pull request settings
   - Badge evaluation
   - Website repository settings
   - AI processing settings

## State Management
- Use React hooks for local state
- Form state management with controlled components
- Loading states for async operations
- Error handling with user-friendly messages
- Toast notifications for actions

## API Integration Points
1. **Page Load**: `directoryAPI.get(id)`
2. **Items Tab**: `directoryAPI.getItems(id)`
3. **Generate Items**: `itemsGeneratorAPI.generate(id, data)`
4. **Update Generator**: `itemsGeneratorAPI.update(id, data)`
5. **Regenerate Markdown**: `itemsGeneratorAPI.regenerateMarkdown(id)`

## Styling Guidelines
- Follow existing theme patterns (light/dark mode)
- Use existing UI components from `/components/ui/`
- Consistent spacing and layout with other pages
- Responsive design for mobile/tablet/desktop
- Use `cn()` utility for conditional classes

## Error Handling
- Not found page for invalid directory IDs
- Form validation with clear error messages
- API error handling with toast notifications
- Generation failure recovery options

## Performance Considerations
- Server-side data fetching for initial load
- Client-side caching for tab switching
- Lazy loading for items list
- Optimistic updates where appropriate

## Professional Features to Add

### 1. **Real-time Updates**
- WebSocket connection for live generation status
- Auto-refresh items when generation completes
- Live progress bar with percentage

### 2. **Analytics Dashboard**
- Generation success/failure chart
- Items growth over time
- Most popular categories
- Performance metrics

### 3. **Collaboration Features**
- Activity feed showing team actions
- Comments on items
- Version history
- Audit log

### 4. **Export/Import**
- Export items to CSV/JSON
- Import items from file
- Backup/restore functionality
- API documentation generation

### 5. **Smart Features**
- AI suggestions for prompts
- Duplicate detection
- Quality scoring for items
- Auto-categorization

## Implementation Steps
1. Create layout.tsx with shared components
2. Implement DirectoryHeader with status display
3. Create DirectoryTabs navigation component
4. Build Overview page with status card and stats
5. Create Items page with filtering and search
6. Develop Generator page with grouped form fields
7. Add Settings page with configuration options
8. Implement generation status handling
9. Add loading states and error boundaries
10. Test all functionality and responsive design

## Success Criteria
- ✅ Directory status is prominently displayed
- ✅ Tab navigation reflects active route
- ✅ All sub-pages load correctly
- ✅ Generator form has logical field grouping
- ✅ Form is disabled during generation
- ✅ Status updates in real-time (polling)
- ✅ Professional UI with smooth transitions
- ✅ Light/dark theme consistency
- ✅ Responsive on all devices
- ✅ Error states handled gracefully
- ✅ Component separation maintained
- ✅ Loading states for async operations
- ✅ Accessibility standards met