---
id: web-app
title: Web App Architecture
sidebar_label: Web App
sidebar_position: 7
---

# Web App Architecture

The Ever Works web dashboard (`apps/web/`) is a Next.js 16 application using the App Router with React 19. This page covers its internal architecture, component model, data flow, and internationalization approach.

## Application Layout

```
apps/web/
  src/
    app/                  # Next.js App Router pages
      [locale]/           # Dynamic locale segment
        (auth)/           # Route group: authentication pages
        (dashboard)/      # Route group: protected dashboard pages
      actions/            # Server Actions
      api/                # API route handlers
    components/           # React components by feature area
    i18n/                 # Internationalization config
    lib/                  # Utilities, hooks, API clients, constants
    proxy.ts              # Middleware (auth + i18n)
    global.ts             # Global type augmentations
  messages/               # Translation JSON files per locale
  public/                 # Static assets (logos, favicons)
  next.config.ts          # Next.js configuration
```

## Server and Client Components

The dashboard follows the React Server Components (RSC) model:

- **Server components (default)** -- pages and layouts fetch data on the server without shipping JavaScript to the client. Most page-level components are server components.
- **Client components (`'use client'`)** -- interactive components that use React hooks, event handlers, or browser APIs are marked with the `'use client'` directive.

### Convention

```typescript
// Server component (default) -- page.tsx
export default async function WorksPage() {
    const works = await fetchWorks(); // Server-side data fetch
    return <WorkList works={works} />;
}

// Client component -- WorkCard.tsx
'use client';
export function WorkCard({ work }) {
    const [expanded, setExpanded] = useState(false);
    // Interactive UI with event handlers
}
```

## Routing

### Locale Routing

All pages are nested under `app/[locale]/`, enabling URL-based locale switching. The `next-intl` middleware detects the locale from the URL prefix, cookie, or Accept-Language header.

Supported locales are defined in `lib/constants.ts` (21 locales) and registered in `i18n/routing.ts`:

```typescript
export const routing = defineRouting({
	locales: LOCALES, // ['en', 'ar', 'bg', 'de', ...]
	defaultLocale: DEFAULT_LOCALE // 'en'
});
```

### Route Groups

Next.js route groups (parenthesized works) organize pages without affecting URL structure:

- **`(auth)/`** -- login, register, forgot-password, reset-password
- **`(dashboard)/`** -- home, works, plugins, settings

Each group has its own `layout.tsx` that provides the appropriate UI shell (auth layout vs. dashboard sidebar layout).

### Dynamic Routes

Work detail pages use the `[id]` dynamic segment:

```
app/[locale]/(dashboard)/works/[id]/
  layout.tsx          # Work detail layout with tabs
  page.tsx            # Overview tab
  items/page.tsx      # Items tab
  generator/page.tsx  # Generator tab
  ...
```

The work layout loads the work entity and provides it to all child pages via `WorkDetailContext`.

## Middleware

The `proxy.ts` file exports the Next.js middleware function, handling three concerns in sequence:

1. **Internationalization** -- `next-intl/middleware` rewrites URLs to include the locale prefix and sets locale cookies.
2. **Public route check** -- routes in `PUBLIC_ROUTES` (auth pages, static pages) bypass authentication.
3. **Authentication gate** -- reads the encrypted auth cookie via `getAuthFromCookie()`. Unauthenticated requests are redirected to `/login`.

The middleware matcher ensures only page routes are processed:

```typescript
export const config = {
	matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)'
};
```

## Data Fetching

### API Client

Server-side API calls go through utilities in `lib/api/`. The API URL is constructed from the `API_URL` environment variable:

```typescript
const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;
```

Authentication tokens are extracted from the encrypted cookie and passed as Bearer tokens in API requests.

### Server Actions

The `app/actions/` work contains Next.js Server Actions for form submissions and mutations that need to run on the server.

## Internationalization with next-intl

### Translation Files

Translations are stored as JSON in the `messages/` work:

```
messages/
  en.json
  ar.json
  de.json
  es.json
  ...
```

### Navigation

The `i18n/navigation.ts` module provides locale-aware navigation helpers (Link, redirect, usePathname) that automatically prefix URLs with the current locale.

### Request Configuration

The `i18n/request.ts` module configures per-request locale resolution for server components.

## Theme Support

The dashboard supports light and dark themes:

- **`theme-toggle.tsx`** -- toggles between light/dark/system themes.
- **`lib/theme-init.ts`** -- initializes the theme from localStorage or system preference.
- Logo and favicon variants are selected based on the active theme via `NEXT_PUBLIC_LOGO_LIGHT`, `NEXT_PUBLIC_LOGO_DARK`, etc.

## Image Configuration

Remote image domains are whitelisted in `next.config.ts`:

- `github.com` -- repository images
- `lh3.googleusercontent.com` -- Google OAuth avatars
- `avatars.githubusercontent.com` -- GitHub user avatars

## Build Modes

The `NEXT_BUILD_OUTPUT` environment variable controls the build output:

| Mode         | Description                      |
| ------------ | -------------------------------- |
| (default)    | Standard Next.js output with SSR |
| `standalone` | Self-contained server for Docker |
| `export`     | Static HTML export (no SSR)      |

## Permissions

The `lib/permissions.ts` module defines client-side permission checks for UI visibility:

- Whether a user can edit a work
- Whether a user can manage members
- Whether settings should be shown

These mirror the backend's ownership/membership checks but are used for conditional rendering in the dashboard UI.
