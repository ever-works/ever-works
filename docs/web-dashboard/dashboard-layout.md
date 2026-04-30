---
id: dashboard-layout
title: Dashboard Layout
sidebar_label: Dashboard Layout
sidebar_position: 21
---

# Dashboard Layout

## Overview

The dashboard layout is the primary shell for the authenticated user experience in Ever Works. It consists of a top header bar, a collapsible and resizable sidebar with integrated AI chat, and a main content area. All layout components live in `apps/web/src/components/dashboard/` and are built as client components (`'use client'`) since they manage interactive state such as sidebar toggling, notifications polling, and theme switching.

## Architecture

```
DashboardLayout
├── DashboardHeader
│   ├── Menu toggle button (mobile)
│   ├── NotificationDropdown
│   ├── ThemeToggle
│   └── HelpCircle button → triggers HelpDrawer
├── DashboardSidebar
│   ├── Mode toggle (menu / AI chat)
│   ├── Navigation links (Dashboard, Directories, Plugins, Settings)
│   ├── ChatInterface (inline, when chat mode active)
│   ├── Drag-to-resize handle
│   └── Floating AI chat panel (when sidebar collapsed)
├── HelpDrawer (slide-over)
├── StatsOverview (on dashboard home)
└── RecentActivity (on dashboard home)
```

Sidebar width and collapsed state are persisted in `localStorage` via the `useSidebarPersistence` hook, so the layout is restored on subsequent visits.

## Components

### DashboardHeader

**File:** `apps/web/src/components/dashboard/DashboardHeader.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `user` | `AuthUser` | Authenticated user object passed to child components |
| `onMenuClick` | `() => void` | Callback to toggle the mobile sidebar |
| `isSidebarOpen` | `boolean` (optional) | Whether the sidebar is currently open |
| `onHelpClick` | `() => void` (optional) | Callback to open the help drawer |

The header renders a fixed top bar containing:

- A hamburger menu button (visible on mobile via `lg:hidden`) that calls `onMenuClick`.
- `NotificationDropdown` for real-time notification access.
- A theme toggle button that cycles between light and dark mode using the `useTheme` hook.
- A help button (HelpCircle icon) that triggers `onHelpClick` to open the `HelpDrawer`.

```tsx
<DashboardHeader
    user={currentUser}
    onMenuClick={() => setMobileOpen(!mobileOpen)}
    onHelpClick={() => setHelpOpen(true)}
/>
```

### DashboardSidebar

**File:** `apps/web/src/components/dashboard/DashboardSidebar.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `user` | `AuthUser` | Authenticated user object |
| `isOpen` | `boolean` | Whether the sidebar is visible |
| `onToggle` | `() => void` | Callback to toggle sidebar visibility |
| `width` | `number` (optional) | Current sidebar width in pixels (default 320) |
| `onWidthChange` | `(width: number) => void` (optional) | Callback when sidebar is resized by dragging |
| `isCollapsed` | `boolean` (optional) | Whether the sidebar is in collapsed mode |
| `onCollapsedChange` | `(collapsed: boolean) => void` (optional) | Callback when collapse state changes |

The sidebar is the most complex layout component. It supports two modes toggled by a button at the top:

- **Menu mode:** Displays navigation links (Dashboard, Directories, Plugins, Settings) with icons from `lucide-react`.
- **Chat mode:** Displays an inline `ChatInterface` for AI conversations.

**Resize behavior:** A drag handle on the right edge of the sidebar allows users to resize it. The width is clamped between `SIDEBAR_WIDTH_MIN` (320px) and `SIDEBAR_WIDTH_MAX` (440px) and persisted via `useSidebarPersistence`.

**Collapse behavior:** A collapse button shrinks the sidebar to an icon-only rail. When collapsed, navigation shows only icons wrapped in a `ConditionalTooltip` helper that renders a `Tooltip` only in collapsed mode. If the user was in chat mode, a floating AI chat panel appears beside the collapsed rail.

**Mobile behavior:** On small screens the sidebar renders as a full-width overlay with a backdrop. The `onToggle` callback controls this.

```tsx
<DashboardSidebar
    user={currentUser}
    isOpen={sidebarOpen}
    onToggle={() => setSidebarOpen(!sidebarOpen)}
    width={sidebarWidth}
    onWidthChange={handleSidebarWidthChange}
    isCollapsed={sidebarCollapsed}
    onCollapsedChange={handleSidebarCollapsedChange}
/>
```

### HelpDrawer

**File:** `apps/web/src/components/dashboard/HelpDrawer.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Whether the drawer is visible |
| `onClose` | `() => void` | Callback to close the drawer |

A slide-over panel built on HeadlessUI `Dialog` and `Transition`. It slides in from the right edge and contains three sections:

1. **Quick Tips** - Contextual guidance for using the platform.
2. **Keyboard Shortcuts** - Displays shortcuts in `<kbd>` elements (Ctrl+K for search, C for new directory, ? for help).
3. **Documentation Links** - External links to the docs site and GitHub repository.

```tsx
<HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
```

### NotificationDropdown

**File:** `apps/web/src/components/dashboard/NotificationDropdown.tsx`

This component takes no props. It manages its own state internally and provides:

- A bell icon button with an unread count badge.
- A dropdown panel listing recent notifications.
- **Polling:** Fetches unread count every 30 seconds via `setInterval`.
- **Actions:** Mark individual notifications as read, mark all as read, dismiss individual notifications.
- Server actions used: `getNotifications`, `getUnreadNotificationCount`, `markNotificationAsRead`, `markAllNotificationsAsRead`, `dismissNotification`.

Each notification displays an icon based on its type, a title, a message body, and a relative time string.

### StatsOverview

**File:** `apps/web/src/components/dashboard/StatsOverview.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `totalDirectories` | `number` (optional) | Number of directories to display |

Renders a grid of three stat cards: Total Directories, Total Items, and Active Websites. Each card has a custom SVG icon, a decorative gradient background circle, and displays its count with a muted subtitle. The `totalItems` and `activeWebsites` values are currently computed as multiples of `totalDirectories`.

```tsx
<StatsOverview totalDirectories={12} />
```

### RecentActivity

**File:** `apps/web/src/components/dashboard/RecentActivity.tsx`

This component takes no props. It renders a feed of recent activity events with:

- Color-coded icons per event type (`directory_created`, `item_added`, `website_deployed`, `api_key_created`).
- Event title and description text.
- Relative time formatting (e.g., "2 hours ago").

The activity data is currently static/mock. Each event type maps to a specific icon and color from `lucide-react`.

## Implementation Details

### Sidebar Persistence

Sidebar width and collapsed state are managed by the `useSidebarPersistence` hook (see [Web Hooks Reference](./web-hooks-reference.md)). This hook wraps `useLocalStorage` with custom serializers:

- Width is stored as a string, parsed as an integer, and validated against min/max bounds.
- Collapsed state is stored as `'1'` or `'0'`.

### Drag-to-Resize

The sidebar implements drag-to-resize via pointer events:

1. `onPointerDown` on the resize handle captures the pointer and records the starting X position and width.
2. `onPointerMove` calculates the delta and clamps the new width to `[SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX]`.
3. `onPointerUp` releases the capture and commits the final width via `onWidthChange`.

### Notification Polling

`NotificationDropdown` sets up a 30-second polling interval on mount:

```tsx
useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
}, []);
```

Notifications are loaded lazily when the dropdown is first opened.

### Internationalization

All user-facing strings use `useTranslations` from `next-intl`. Translation keys are namespaced under `dashboard.*` (e.g., `dashboard.sidebar.menu`, `dashboard.header.notifications`).

## Styling & Theming

All components use Tailwind CSS 4 with the project's custom design tokens:

| Token Pattern | Purpose |
|---------------|---------|
| `bg-surface` / `bg-surface-dark` | Primary background surfaces |
| `bg-surface-secondary` / `bg-surface-secondary-dark` | Secondary/muted backgrounds |
| `text-text` / `text-text-dark` | Primary text color |
| `text-text-muted` / `text-text-muted-dark` | Secondary/muted text |
| `border-border` / `border-border-dark` | Border colors |
| `text-primary` / `bg-primary` | Brand/accent color |

Dark mode is handled via the `dark:` variant prefix. The `cn()` utility from `@/lib/utils` (wrapping `clsx` + `tailwind-merge`) is used throughout for conditional class composition.

The sidebar uses `transition-all duration-300` for smooth width changes and collapse animations. The help drawer uses HeadlessUI `Transition` with translate-x transforms for its slide-in effect.

## Usage Examples

### Full Dashboard Layout Assembly

```tsx
'use client';

import { useState } from 'react';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { HelpDrawer } from '@/components/dashboard/HelpDrawer';
import { useSidebarPersistence } from '@/lib/hooks/use-sidebar-persistence';

export function DashboardLayout({ user, children }) {
    const [mobileOpen, setMobileOpen] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const {
        sidebarWidth,
        sidebarCollapsed,
        handleSidebarWidthChange,
        handleSidebarCollapsedChange,
    } = useSidebarPersistence();

    return (
        <div className="min-h-screen bg-surface dark:bg-surface-dark">
            <DashboardHeader
                user={user}
                onMenuClick={() => setMobileOpen(!mobileOpen)}
                onHelpClick={() => setHelpOpen(true)}
            />
            <DashboardSidebar
                user={user}
                isOpen={mobileOpen}
                onToggle={() => setMobileOpen(false)}
                width={sidebarWidth}
                onWidthChange={handleSidebarWidthChange}
                isCollapsed={sidebarCollapsed}
                onCollapsedChange={handleSidebarCollapsedChange}
            />
            <main className="transition-all duration-300">
                {children}
            </main>
            <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
        </div>
    );
}
```

## Related Components

- [AI Components Deep Dive](./ai-components-deep-dive.md) - ChatInterface and ChatProvider used within the sidebar
- [Web Hooks Reference](./web-hooks-reference.md) - useSidebarPersistence, useTheme, useKeyboardShortcuts
- [UI Component Library](./ui-component-library.md) - Button, Tooltip, and other shared UI primitives
- [Settings Components](./settings-components.md) - Settings pages accessible from sidebar navigation
