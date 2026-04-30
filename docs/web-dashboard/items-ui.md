---
id: items-ui
title: Items Management
sidebar_label: Items UI
sidebar_position: 19
---

# Items Management

The Items UI is the primary content management interface for directory entries. It provides a tabbed layout with four views -- Browse Items, Categories, Tags, and Collections -- along with search, filtering, virtualized rendering for large lists, and full CRUD operations.

## Component Hierarchy

```
ItemsPageClient
  |
  +-- ItemsProvider (context)
  |
  +-- Page header (title + "Add Item" button)
  |
  +-- Tab navigation (items | categories | tags | collections)
  |
  +-- Tab: Items
  |     +-- ItemsList
  |           +-- Search input + Category filter + View toggle (grid/list)
  |           +-- Items count display
  |           +-- VirtualizedItemsList
  |           |     +-- ItemCard (memoized, per item)
  |           +-- ItemsEmptyState (if no matches)
  |
  +-- Tab: Categories
  |     +-- CategoriesTab
  |           +-- Search + "Add Category" button
  |           +-- Categories table (name, description, items count, priority, actions)
  |           +-- CategoryModal (create/edit form)
  |
  +-- Tab: Tags
  |     +-- TagsTab
  |           +-- Search + "Add Tag" button
  |           +-- Tags table (name, items count, actions)
  |           +-- TagModal (create/edit form)
  |
  +-- Tab: Collections
  |     +-- CollectionsTab
  |           +-- Search + "Add Collection" button
  |           +-- Collections table (name, description, items count, priority, actions)
  |           +-- CollectionModal (create/edit form)
  |
  +-- AddItemModal
        +-- AddItemForm
              +-- Source URL + Extract button
              +-- Name, Description fields
              +-- CategoriesField
              +-- TagsField
              +-- Slug, Brand, Brand Logo URL fields
              +-- ImagesField + Screenshot capture
              +-- Featured checkbox, Update with PR checkbox
```

## ItemsContext

**File**: `apps/web/src/components/directories/detail/items/ItemsContext.tsx`

A React context that shares common state across all items components:

```typescript
interface ItemsContextType {
	directoryId: string;
	canEdit: boolean;
	directoryWebsite?: string;
	screenshotAvailable: boolean;
}
```

`screenshotAvailable` is determined by calling `checkScreenshotAvailability()` on mount -- this checks whether a screenshot plugin (e.g., ScreenshotOne) is configured.

## Key Components

### ItemsPageClient

**File**: `apps/web/src/components/directories/detail/items/ItemsPageClient.tsx`

The top-level client component managing tab state and coordinating all sub-views.

```typescript
interface ItemsPageClientProps {
	items: ItemData[];
	directoryId: string;
	categories?: Category[];
	tags?: Tag[];
	collections?: Collection[];
}
```

**Tab Types**: `'items' | 'categories' | 'tags' | 'collections'`

Each tab is rendered with an icon from `lucide-react`:

- Items: `Package`
- Categories: `FolderTree`
- Tags: `Tags`
- Collections: `Bookmark`

### ItemsList (Virtualized)

**File**: `apps/web/src/components/directories/detail/items/ItemsList.tsx`

The main items browsing view with search, filtering, and virtualized rendering using `@tanstack/react-virtual`.

```typescript
interface ItemsListProps {
	items: ItemData[];
	addItemRef?: React.RefObject<((item: ItemData) => void) | null>;
}
```

**Features**:

- **Search**: Filters by item name and description
- **Category filter**: Dropdown populated from unique item categories
- **View modes**: Grid (responsive 1-3 columns) or List view
- **Virtualization**: Uses `useVirtualizer` with scroll-margin awareness for the main content area
- **Sorting**: Items sorted by featured status (first), then by `order` field, then alphabetically

**Virtualization Config**:

| Parameter  | Grid Mode                  | List Mode        |
| ---------- | -------------------------- | ---------------- |
| Row height | ~200px + 16px gap          | ~80px + 16px gap |
| Overscan   | 5 rows                     | 5 rows           |
| Columns    | 1 (mobile), 2 (sm), 3 (lg) | 1                |

**Responsive column detection** uses a `useColumnCount` hook that listens to window resize events.

### AddItemForm

**File**: `apps/web/src/components/directories/detail/items/AddItemForm.tsx`

A comprehensive form for creating new directory items with AI-powered extraction.

```typescript
interface ItemFormData {
	name: string;
	description: string;
	source_url: string;
	categories: string[];
	tags: string[];
	featured: boolean;
	pay_and_publish_now: boolean;
	slug: string;
	brand: string;
	brand_logo_url: string;
	images: string[];
}
```

**AI Extraction**: Entering a URL and clicking "Extract" calls `extractItemDetails(url, categories)` which uses AI to populate name, description, tags, categories, brand, and images from the web page.

**Screenshot Capture**: If a screenshot plugin is configured, the "Capture Screenshot" button calls `captureScreenshot(url)` to generate an image of the source URL and add it to the images list.

### CategoriesTab

**File**: `apps/web/src/components/directories/detail/items/CategoriesTab.tsx`

Manages directory categories with a searchable table and CRUD modal.

```typescript
interface CategoriesTabProps {
	directoryId: string;
	initialCategories: Category[];
	items: ItemData[]; // used to compute item counts per category
	canEdit: boolean;
}
```

**Table Columns**: Name (with icon), Description, Items Count, Priority, Actions (edit/delete)

**Constraints**: Categories with assigned items cannot be deleted -- an error toast is shown.

### TagsTab

**File**: `apps/web/src/components/directories/detail/items/TagsTab.tsx`

Manages directory tags with a searchable table and CRUD modal.

```typescript
interface TagsTabProps {
	directoryId: string;
	initialTags: Tag[];
	items: ItemData[];
	canEdit: boolean;
}
```

**Table Columns**: Name (pill badge), Items Count, Actions (edit/delete)

### CollectionsTab

**File**: `apps/web/src/components/directories/detail/items/CollectionsTab.tsx`

Manages directory collections with a searchable table and CRUD modal.

```typescript
interface CollectionsTabProps {
	directoryId: string;
	initialCollections: Collection[];
	items: ItemData[];
	canEdit: boolean;
}
```

**Table Columns**: Name (with icon), Description, Items Count, Priority, Actions (edit/delete)

## State Management Patterns

```
ItemsPageClient
  |-- activeTab: TabType                    // which tab is shown
  |-- isAddModalOpen: boolean               // add item modal
  |-- screenshotAvailable: boolean          // from plugin check
  |
  +-- ItemsList
  |     |-- items: ItemData[]               // local, supports add/delete/update
  |     |-- searchQuery: string
  |     |-- selectedCategory: string | null
  |     |-- viewMode: 'grid' | 'list'
  |
  +-- CategoriesTab
  |     |-- categories: Category[]          // local CRUD state
  |     |-- searchQuery: string
  |     |-- isModalOpen: boolean
  |     |-- editingCategory: Category | null
  |
  +-- TagsTab / CollectionsTab              // same pattern as CategoriesTab
```

All taxonomy operations (create, update, delete) are performed via server actions and the local state is updated optimistically.

## Related API Endpoints

| Action                        | Server Action Function                              | HTTP Method |
| ----------------------------- | --------------------------------------------------- | ----------- |
| Extract item details          | `extractItemDetails(url, categories)`               | POST        |
| Capture screenshot            | `captureScreenshot(url)`                            | POST        |
| Check screenshot availability | `checkScreenshotAvailability()`                     | GET         |
| Create category               | `createCategory(directoryId, data)`                 | POST        |
| Update category               | `updateCategory(directoryId, categoryId, data)`     | PATCH       |
| Delete category               | `deleteCategory(directoryId, categoryId)`           | DELETE      |
| Create tag                    | `createTag(directoryId, data)`                      | POST        |
| Update tag                    | `updateTag(directoryId, tagId, data)`               | PATCH       |
| Delete tag                    | `deleteTag(directoryId, tagId)`                     | DELETE      |
| Create collection             | `createCollection(directoryId, data)`               | POST        |
| Update collection             | `updateCollection(directoryId, collectionId, data)` | PATCH       |
| Delete collection             | `deleteCollection(directoryId, collectionId)`       | DELETE      |

## Internationalization

All strings use `next-intl` under these namespaces:

- `dashboard.directoryDetail.items` -- page-level labels, tab names, search, counts
- `dashboard.directoryDetail.items.addModal` -- add item form labels and messages
- `dashboard.directoryDetail.items.taxonomy` -- categories, tags, collections CRUD

## Cross-References

- [Deployment UI](./deployment-ui.md) -- deploy after managing items
- [Generation History](./history-ui.md) -- items created/updated counts per generation
- [Members UI](./members-ui.md) -- editor role required to manage items
- [Schedule UI](./schedule-ui.md) -- automated generation creates/updates items
