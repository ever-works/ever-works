---
id: navigation-routing
title: Navigation & Routing
sidebar_label: Navigation & Routing
sidebar_position: 13
---

# Navigation & Routing

The web dashboard uses the Next.js 16 App Router with `next-intl` for locale-aware routing. All pages are nested under a `[locale]` dynamic segment and organized into two route groups: `(auth)` for public authentication pages and `(dashboard)` for protected pages requiring authentication.

## Route Layout Hierarchy

```
src/app/[locale]/
  layout.tsx                      # Root layout (fonts, theme script, toaster, i18n provider)
  (auth)/                         # Public route group (no auth required)
    login/page.tsx
    register/page.tsx
    forgot-password/page.tsx
    reset-password/page.tsx
    auth/error/page.tsx
  (dashboard)/                    # Protected route group (auth required)
    layout.tsx                    # Dashboard layout (auth check + sidebar/header shell)
    layout-client.tsx             # Client layout (sidebar, header, footer, help drawer)
    page.tsx                      # Dashboard home
    works/...               # Work management pages
    plugins/...                   # Plugin management pages
    settings/...                  # User settings pages
    notifications/page.tsx        # Notifications page
```

## Root Layout

**File**: `src/app/[locale]/layout.tsx`

The root layout wraps every page in the application. It performs locale validation and sets up global providers and UI elements.

**Responsibilities**:

| Concern           | Implementation                                                                 |
| ----------------- | ------------------------------------------------------------------------------ | ----------- |
| Locale validation | `hasLocale(routing.locales, locale)` -- calls `notFound()` for invalid locales |
| Fonts             | Geist Sans and Geist Mono from `next/font/google` as CSS variables             |
| Theme             | Injects `themeInitScript` in `<head>` to prevent flash of wrong theme          |
| i18n              | Wraps children in `NextIntlClientProvider`                                     |
| Toasts            | Global `Toaster` from `sonner` positioned top-right with theme-aware styling   |
| Page loader       | `TopLoader` component for route transition indicators                          |
| Metadata          | Template-based titles: `%s                                                     | {APP_NAME}` |

**Theme Init Script**: The `themeInitScript` runs before React hydrates, reading the theme from `localStorage` and applying the `dark` class to `<html>` immediately to prevent a flash of light theme.

## i18n Configuration

### Routing

**File**: `src/i18n/routing.ts`

```typescript
export const routing = defineRouting({
	locales: LOCALES, // 21 supported locales
	defaultLocale: DEFAULT_LOCALE // 'en' (configurable via env)
});
```

### Navigation Exports

**File**: `src/i18n/navigation.ts`

Creates locale-aware navigation utilities from `next-intl/navigation`:

```typescript
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
```

All internal navigation uses these exports instead of the raw `next/link` or `next/navigation` equivalents. This ensures links and redirects automatically include the current locale prefix (e.g., `/en/works` or `/fr/works`).

### Message Loading

**File**: `src/i18n/request.ts`

Uses `getRequestConfig` to load translation messages with fallback:

1. Loads the requested locale's messages from `messages/{locale}.json`
2. Loads the English messages as a fallback base
3. Deep-merges them so missing translations fall back to English

Custom formats are defined for date/time, numbers, and lists.

## Supported Locales

The application supports 21 locales defined in `src/lib/constants.ts`:

```
en, ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh
```

The default locale is configurable via `NEXT_PUBLIC_DEFAULT_LOCALE` environment variable (defaults to `en`).

## Authentication Flow

### Auth Check

**File**: `src/lib/auth/middleware.ts`

The `getAuthFromRequest()` function reads the JWT access token from cookies and decodes it:

```typescript
export async function getAuthFromRequest(): Promise<{
	isAuthenticated: boolean;
	user?: JwtPayload;
	isExpired: boolean;
	token?: string;
}>;
```

The JWT payload (`JwtPayload`) extends `AuthUser` with token metadata:

| Field           | Type      | Description                           |
| --------------- | --------- | ------------------------------------- | ---------- |
| `sub`           | `string`  | User ID                               |
| `email`         | `string`  | User email                            |
| `provider`      | `string`  | Auth provider                         |
| `username`      | `string`  | Display name                          |
| `emailVerified` | `boolean` | Email verification status             |
| `isActive`      | `boolean` | Account active status                 |
| `avatar`        | `string   | null`                                 | Avatar URL |
| `iat`, `exp`    | `number`  | Token issue and expiration timestamps |

### Dashboard Auth Guard

**File**: `src/app/[locale]/(dashboard)/layout.tsx`

The dashboard layout performs a server-side auth check:

```typescript
const user = await getAuthFromCookie();
if (!user) {
	return null; // Middleware should have already redirected
}
```

`getAuthFromCookie()` (from `src/lib/auth/index.ts`) calls `getAuthFromRequest()` and returns `null` if the user is not authenticated or if the token is expired.

### Login Page Auth Check

The login page's server component checks for existing authentication and redirects to the dashboard if the user is already logged in, preventing authenticated users from seeing the login form.

## Route Constants

**File**: `src/lib/constants.ts`

All routes are centralized in the `ROUTES` constant object.

**Dashboard Routes**:

| Constant                            | Path                          |
| ----------------------------------- | ----------------------------- |
| `DASHBOARD`                         | `/`                           |
| `DASHBOARD_DIRECTORIES`             | `/works`                |
| `DASHBOARD_DIRECTORIES_NEW`         | `/works/new`            |
| `DASHBOARD_DIRECTORY(id)`           | `/works/{id}`           |
| `DASHBOARD_DIRECTORY_ITEMS(id)`     | `/works/{id}/items`     |
| `DASHBOARD_DIRECTORY_GENERATOR(id)` | `/works/{id}/generator` |
| `DASHBOARD_DIRECTORY_SETTINGS(id)`  | `/works/{id}/settings`  |
| `DASHBOARD_PLUGINS`                 | `/plugins`                    |
| `DASHBOARD_PLUGIN_DETAIL(pluginId)` | `/plugins/{pluginId}`         |
| `DASHBOARD_SETTINGS`                | `/settings`                   |

**Auth Routes**:

| Constant               | Path               |
| ---------------------- | ------------------ |
| `AUTH_LOGIN`           | `/login`           |
| `AUTH_REGISTER`        | `/register`        |
| `AUTH_FORGOT_PASSWORD` | `/forgot-password` |
| `AUTH_RESET_PASSWORD`  | `/reset-password`  |
| `AUTH_ERROR`           | `/auth/error`      |

**API Routes**:

| Constant                           | Path                                |
| ---------------------------------- | ----------------------------------- |
| `API_AUTH_VERIFY_EMAIL`            | `/api/auth/verify-email`            |
| `API_AUTH_RESET_PASSWORD`          | `/api/auth/reset-password`          |
| `API_AI_CONVERSATIONS_CHAT_STREAM` | `/api/ai-conversations/chat/stream` |
| `API_OAUTH_CALLBACK`               | `/api/oauth/:providerId/callback`   |

**Public Routes**: The `PUBLIC_ROUTES` array defines paths that do not require authentication: all auth routes plus `/about`, `/contact`, `/privacy`, `/terms`, and `/help`.

## Dashboard Client Layout

**File**: `src/app/[locale]/(dashboard)/layout-client.tsx`

The client-side dashboard shell that wraps all protected pages.

**Components Rendered**:

| Component          | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `DashboardSidebar` | Resizable sidebar with navigation, AI chat, user profile         |
| `DashboardHeader`  | Top header with notification dropdown, theme toggle, help button |
| `Footer`           | Page footer                                                      |
| `HelpDrawer`       | Slide-out help panel                                             |
| `DashboardToasts`  | Toast notification handler (wrapped in `Suspense`)               |

**Sidebar Persistence**: Uses `useSidebarPersistence` hook to remember sidebar width (320-440px range) and collapsed state across sessions via `localStorage`.

**Keyboard Shortcuts**: Registered via `useKeyboardShortcuts` hook:

| Shortcut       | Action                                      |
| -------------- | ------------------------------------------- |
| `Ctrl/Cmd + K` | Navigate to works with search focused |
| `C`            | Navigate to new work page              |
| `?`            | Open help drawer                            |

## Dashboard Sidebar

**File**: `src/components/dashboard/DashboardSidebar.tsx`

The sidebar provides the primary navigation and houses the AI chat interface.

**Navigation Items**:

| Icon       | Label       | Route          |
| ---------- | ----------- | -------------- |
| `Home`     | Dashboard   | `/`            |
| `Folder`   | Works | `/works` |
| `Plug`     | Plugins     | `/plugins`     |
| `Settings` | Settings    | `/settings`    |

**Modes**: The sidebar supports two modes toggled by buttons at the bottom:

- **Menu mode**: Shows navigation links and work list
- **Chat mode**: Shows the AI chat interface (`ChatProvider` + `ChatInterface`)

**Resizable**: The sidebar is draggable between `SIDEBAR_WIDTH_MIN` (320px) and `SIDEBAR_WIDTH_MAX` (440px). A drag handle on the right edge enables mouse-based resizing.

**Collapsible**: Can be collapsed to a 64px icon-only rail. When collapsed, navigation items show tooltips on hover via `ConditionalTooltip`.

## Dashboard Header

**File**: `src/components/dashboard/DashboardHeader.tsx`

The top navigation bar provides quick-access controls.

**Elements**:

| Element               | Description                                    |
| --------------------- | ---------------------------------------------- |
| Menu button           | Shown when sidebar is closed (mobile only)     |
| Notification dropdown | `NotificationDropdown` with unread count badge |
| Theme toggle          | `ThemeToggle` component (inline variant)       |
| Help button           | Opens the help drawer                          |

## Server-Side Navigation Helpers

**File**: `src/app/actions/dashboard/navigation.ts`

Six server action redirect helpers that use locale-aware navigation:

| Function                  | Redirects To       |
| ------------------------- | ------------------ |
| `redirectToWorks`   | `/works`     |
| `redirectToNewWork`  | `/works/new` |
| `redirectToDashboard`     | `/`                |
| `redirectToSettings`      | `/settings`        |
| `redirectToAnalytics`     | `/analytics`       |
| `redirectToNotifications` | `/notifications`   |

Each function calls `getLocale()` to determine the current locale and uses `redirect({ locale, href })` from `@/i18n/navigation`.

## Redirect Handling

**File**: `src/lib/auth/redirect.ts`

After authentication, the system checks for a stored redirect URL:

1. Reads the `redirect_uri` cookie via `getRedirectCookie()`
2. Validates the URL against `ALLOWED_REDIRECT_URLS` using `isValidRedirectUrl()`
3. If valid, appends the session token to the URL for cross-domain auth
4. Clears the redirect cookie after use

The `ALLOWED_REDIRECT_URLS` environment variable defines which hostnames are permitted for redirects (defaults to `localhost,127.0.0.1`).

## URL Utilities

**File**: `src/lib/constants.ts`

| Function                         | Description                                         |
| -------------------------------- | --------------------------------------------------- |
| `routeWithParams(route, params)` | Replaces `:paramName` placeholders in route strings |
| `withAppUrl(route)`              | Prepends the `WEB_URL` base to create a full URL    |
