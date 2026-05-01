---
id: overview
title: Web Dashboard Overview
sidebar_label: Overview
sidebar_position: 1
---

# Web Dashboard Overview

The Ever Works web dashboard is a Next.js 16 application that serves as the primary user interface for managing directories, plugins, and account settings. It uses the App Router with React 19, Tailwind CSS 4, and `next-intl` for internationalization.

## Application Structure

The dashboard source lives in `apps/web/src/` with the following top-level layout:

```
apps/web/src/
  app/            # Next.js App Router pages
  components/     # React components organized by feature area
  i18n/           # Internationalization configuration (next-intl)
  lib/            # API utilities, hooks, constants, auth helpers
  proxy.ts        # Middleware: locale detection, auth gating, routing
  global.ts       # Global type augmentations
```

## Page Routes

Pages are located under `app/[locale]/` and are organized into two route groups:

### Authentication Pages (`(auth)`)

| Route              | Purpose                      |
| ------------------ | ---------------------------- |
| `/login`           | User login                   |
| `/register`        | User registration            |
| `/forgot-password` | Password reset request       |
| `/reset-password`  | Password reset form          |
| `/auth/error`      | Authentication error display |

### Dashboard Pages (`(dashboard)`)

| Route                           | Purpose                               |
| ------------------------------- | ------------------------------------- |
| `/`                             | Home dashboard with stats overview    |
| `/directories`                  | List of user directories              |
| `/directories/new`              | Create a new directory (manual or AI) |
| `/directories/[id]`             | Directory overview                    |
| `/directories/[id]/items`       | Browse and manage items               |
| `/directories/[id]/generator`   | Run AI generation                     |
| `/directories/[id]/schedule`    | Configure automated schedules         |
| `/directories/[id]/deploy`      | Deploy the directory website          |
| `/directories/[id]/members`     | Manage team members                   |
| `/directories/[id]/settings`    | Directory settings                    |
| `/directories/[id]/plugins`     | Per-directory plugin configuration    |
| `/directories/[id]/comparisons` | Item comparison pages                 |
| `/directories/[id]/history`     | Generation run history                |
| `/plugins`                      | Global plugin marketplace             |
| `/plugins/[pluginId]`           | Plugin detail and configuration       |
| `/settings`                     | Profile settings                      |
| `/settings/security`            | Security and password                 |
| `/settings/danger`              | Danger zone (account deletion)        |
| `/settings/plugins/[category]`  | Plugin settings by category           |

## Middleware and Proxy

The file `proxy.ts` (exported as the default middleware) handles three responsibilities:

1. **Locale detection** -- delegates to `next-intl/middleware` for locale prefix routing.
2. **Public route allowlisting** -- authentication pages and static assets pass through without auth checks.
3. **Authentication gating** -- all dashboard routes check for a valid auth cookie. Unauthenticated users are redirected to `/login` with a `redirect_uri` search parameter.

The middleware matcher excludes API routes, static files, and Next.js internals:

```
matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)'
```

## Connecting to the API

The dashboard communicates with the NestJS backend via server-side API calls. The API URL is resolved from the `API_URL` environment variable (defaults to `http://localhost:3100`) and automatically appends `/api` if not already present.

API client utilities live in `lib/api/` and use cookies-based authentication. The auth cookie is encrypted using `COOKIE_SECRET` and carries the JWT token issued by the backend.

## Internationalization

The dashboard supports 21 locales out of the box: English, Arabic, Bulgarian, German, Spanish, French, Hebrew, Hindi, Indonesian, Italian, Japanese, Korean, Dutch, Polish, Portuguese, Russian, Thai, Turkish, Ukrainian, Vietnamese, and Chinese.

Locale routing is configured in `i18n/routing.ts` using `next-intl`'s `defineRouting` helper. The default locale is controlled by `NEXT_PUBLIC_DEFAULT_LOCALE` (defaults to `en`). Translation files are stored in the `messages/` directory.

## Key Technologies

| Technology     | Purpose                                         |
| -------------- | ----------------------------------------------- |
| Next.js 16     | Framework (App Router, React Server Components) |
| React 19       | UI library                                      |
| Tailwind CSS 4 | Utility-first styling                           |
| next-intl      | Internationalization and locale routing         |
| path-to-regexp | Route matching in middleware                    |
| shadcn/ui      | Base component primitives                       |

## Development

Start the web dashboard in development mode:

```bash
pnpm dev:web    # Runs on http://localhost:3000
```

The dashboard expects the API to be running on port 3100. Start both simultaneously with:

```bash
pnpm dev        # Starts all apps in parallel
```

## Build Output

The Next.js build output mode is configurable via `NEXT_BUILD_OUTPUT`:

- **Default** -- standard Next.js output with server-side rendering
- **`standalone`** -- self-contained Node.js server for Docker deployments
- **`export`** -- static HTML export (no SSR)
