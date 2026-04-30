---
id: plugin-pages
title: Plugin Management Pages
sidebar_label: Plugin Pages
sidebar_position: 10
---

# Plugin Management Pages

The web dashboard provides a dedicated plugin management area under the `/plugins` route group. Users can browse available plugins, enable or disable them, configure settings, and manage OAuth connections. All plugin UI lives in `src/components/plugins/` with server pages in `src/app/[locale]/(dashboard)/plugins/`.

## Route Structure

```
/[locale]/(dashboard)/plugins/
  page.tsx                    # Plugin list page (server component)
  [pluginId]/
    page.tsx                  # Plugin detail/settings page (server component)
```

## Plugin List Page

**Route**: `/plugins`
**File**: `src/app/[locale]/(dashboard)/plugins/page.tsx`

The server component fetches all plugins and passes them to the client-side `PluginsList` component.

```typescript
const pluginsData = await pluginsAPI.list();

<PluginsList
    plugins={pluginsData.plugins}
    categories={pluginsData.categories}
    capabilities={pluginsData.capabilities}
/>
```

**Data Shape**: `pluginsAPI.list()` returns an object containing three arrays: `plugins` (type `UserPlugin[]`), `categories` (type `PluginCategory[]`), and `capabilities` (type `string[]`).

## PluginsList

**File**: `src/components/plugins/PluginsList.tsx`

The top-level client component that orchestrates search, filtering, and display of all plugins.

**Props**:

| Prop | Type | Description |
|------|------|-------------|
| `plugins` | `UserPlugin[]` | Full list of available plugins |
| `categories` | `PluginCategory[]` | Available category metadata |
| `capabilities` | `string[]` | Available capability identifiers |

**State Management**:

| State | Default | Description |
|-------|---------|-------------|
| `selectedCategory` | `null` | Active category filter |
| `showEnabledOnly` | `false` | Toggle to show only enabled plugins |
| `searchQuery` | `''` | Free-text search filter |

**Sorting**: Plugins are sorted once on initial render using a stable sort: enabled plugins first, then installed plugins, then alphabetical by name. The sort order is captured in a `useRef` to prevent card positions from jumping when a plugin is toggled.

**Search**: The `matchesSearch` function builds a haystack from the plugin's name, description, category label, and capability labels, then checks if the lowercase query appears anywhere in the combined string.

**Display Modes**: When no search query or category filter is active, plugins render in a grouped-by-category layout. When searching or filtering, a flat grid is used instead.

## PluginGrid

**File**: `src/components/plugins/PluginGrid.tsx`

Renders the plugin cards in either grouped or flat layout.

**Props**:

| Prop | Type | Description |
|------|------|-------------|
| `plugins` | `UserPlugin[]` | Filtered plugin list |
| `grouped` | `boolean` | Whether to group by category |
| `searchQuery` | `string` | Current search term (for empty state) |
| `onClearSearch` | `() => void` | Clears the search filter |

**Empty State**: When no plugins match, shows a contextual message: either a search-specific empty state with a clear button, or a generic empty message.

**Grid Layout**: Uses a responsive CSS grid: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`.

## PluginCard

**File**: `src/components/plugins/PluginCard.tsx`

Each card displays a single plugin with its metadata, toggle controls, and navigation links.

**Card Sections**:

| Section | Content |
|---------|---------|
| Header Row | Plugin icon (40px), name, version, system/built-in badges, enable/disable button |
| Description | Two-line truncated description (`line-clamp-2`) |
| Capability Badges | Category badge + up to 2 extra capability badges, with overflow count |
| Footer | Settings link (to detail page) and documentation link (external) |

**Visual Indicators**: Enabled and system plugins get a `ring-2 ring-primary/20` border highlight. The enable/disable button uses `usePluginToggle` for optimistic UI updates.

**Hidden Capabilities**: The `HIDDEN_CAPABILITIES` set filters out internal capabilities that should not appear as badges on the card.

## Plugin Detail Page

**Route**: `/plugins/[pluginId]`
**File**: `src/app/[locale]/(dashboard)/plugins/[pluginId]/page.tsx`

The server component fetches the plugin data and conditionally checks for an OAuth connection.

```typescript
const plugin = await pluginsAPI.get(pluginId);

let oauthConnection: OAuthConnectionInfo | null | undefined;
if (plugin.capabilities.includes('oauth')) {
    oauthConnection = await oauthAPI.checkConnection(plugin.pluginId);
}
```

If the plugin fetch throws an error, the page calls `notFound()` to render a 404.

## PluginSettings

**File**: `src/components/plugins/PluginSettings.tsx`

The main detail page component, divided into four sections.

**Sections**:

| Section | Condition | Description |
|---------|-----------|-------------|
| Plugin Header | Always | Icon, name, version, badges, enable/disable button, author, homepage link |
| OAuth Connection | Plugin has `oauth` capability | Renders `PluginOAuthConnection` widget |
| Settings Form | Plugin has configurable settings | Form fields with save button |
| Readme | Plugin has `readme` content | Rendered markdown documentation |

**Hook Integration**:

The component uses two hooks to manage its interactive state:

- `usePluginSettings` -- Manages the settings form with scopes `['global', 'user']`, validation, secret splitting, and the save lifecycle. The `onSave` callback calls `updatePluginSettings` server action.
- `usePluginToggle` -- Manages enable/disable with optimistic UI, confirmation dialogs, and auto-enable-for-directories option.

**Enable/Disable Toggle**: System plugins cannot be toggled (the button is hidden). Non-system plugins show either a "Disable" button (danger-styled) or an "Enable" button (primary-styled).

**Settings Form**: Uses `PluginSettingsFormFields` to render fields based on `visibleProperties` from the hook. The save button is disabled when no changes exist or when saving is in progress. A success checkmark appears for 3 seconds after saving.

## PluginEnablePanel

**File**: `src/components/plugins/PluginEnablePanel.tsx`

A dialog shown when enabling a plugin that supports directory scope.

**Props**:

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Controls dialog visibility |
| `autoEnableForDirs` | `boolean` | Checkbox state for auto-enable |
| `onAutoEnableChange` | `(checked: boolean) => void` | Checkbox handler |
| `onCancel` | `() => void` | Cancel handler |
| `onConfirm` | `() => void` | Confirm handler |
| `isPending` | `boolean` | Loading state |

The panel includes a checkbox that lets users automatically enable the plugin for all their existing directories.

## PluginDisableWarning

**File**: `src/components/plugins/PluginDisableWarning.tsx`

A confirmation dialog shown before disabling a plugin. Displays a warning message about the cascade effect (disabling at user level also disables for all directories). Uses `AlertTriangle` icon and danger-styled confirmation button.

## Server Actions Used

| Action | Source | Description |
|--------|--------|-------------|
| `enablePlugin` | `src/app/actions/plugins.ts` | Enables a plugin for the user |
| `disablePlugin` | `src/app/actions/plugins.ts` | Disables a plugin for the user |
| `updatePluginSettings` | `src/app/actions/plugins.ts` | Updates plugin settings (regular + secret) |
| `enableDirectoryPlugin` | `src/app/actions/plugins.ts` | Enables a plugin for a specific directory |
| `disableDirectoryPlugin` | `src/app/actions/plugins.ts` | Disables a plugin for a specific directory |
| `fetchModels` | `src/app/actions/plugins.ts` | Fetches AI models for a plugin |
| `setActiveCapability` | `src/app/actions/plugins.ts` | Sets active capability for multi-capability plugins |

## Additional Components

| Component | File | Description |
|-----------|------|-------------|
| `PluginSearchBar` | `PluginSearchBar.tsx` | Search input for filtering the plugin list |
| `PluginCategoryFilter` | `PluginCategoryFilter.tsx` | Category pills and enabled-only toggle |
| `PluginIcon` | `PluginIcon.tsx` | Renders plugin icons (SVG, URL, or emoji fallback) |
| `PluginReadme` | `PluginReadme.tsx` | Renders markdown readme content |
| `PluginSettingsFormFields` | `PluginSettingsFormFields.tsx` | Iterates over visible properties and renders form fields |
| `PluginSettingsField` | `form/PluginSettingsField.tsx` | Individual field renderer (text, password, select, etc.) |
| `PluginSettingsArrayField` | `form/PluginSettingsArrayField.tsx` | Array-type settings field |
| `PluginSettingsObjectField` | `form/PluginSettingsObjectField.tsx` | Object-type settings field |
| `PluginModelSelect` | `form/PluginModelSelect.tsx` | AI model selection dropdown with lazy loading |
