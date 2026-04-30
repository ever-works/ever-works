---
id: configuration
title: Dashboard Configuration
sidebar_label: Configuration
sidebar_position: 3
---

# Dashboard Configuration

The web dashboard is configured through environment variables, the Next.js config file, and site-level constants. This page covers all configurable aspects of the dashboard.

## Environment Variables

Copy `.env.example` to `.env.local` and adjust values for your deployment. Variables prefixed with `NEXT_PUBLIC_` are exposed to the browser; all others are server-side only.

### Application Settings

| Variable               | Default                 | Description                               |
| ---------------------- | ----------------------- | ----------------------------------------- |
| `APP_NAME`             | `Ever Works`            | Application name (fallback for site name) |
| `NEXT_PUBLIC_APP_NAME` | `Ever Works`            | Public-facing app name                    |
| `NEXT_PUBLIC_WEB_URL`  | `http://localhost:3000` | Web application URL                       |
| `API_URL`              | `http://localhost:3100` | Backend API URL (`/api` auto-appended)    |

### Site Configuration (Multi-tenant)

These variables support multi-tenant deployments where each instance can have its own branding:

| Variable                       | Default                      | Description                  |
| ------------------------------ | ---------------------------- | ---------------------------- |
| `NEXT_PUBLIC_SITE_NAME`        | Uses `APP_NAME`              | Site name                    |
| `NEXT_PUBLIC_SITE_TITLE`       | Uses `APP_NAME`              | SEO title                    |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | `Build Directories with AI`  | Meta description             |
| `NEXT_PUBLIC_SITE_KEYWORDS`    | `Ever Works,Directories,...` | Comma-separated SEO keywords |
| `NEXT_PUBLIC_SITE_AUTHOR`      | Uses `APP_NAME`              | Author meta tag              |
| `NEXT_PUBLIC_SITE_IMAGE`       | `/logo-light.png`            | Open Graph image path        |

### Logo and Favicon

| Variable                    | Default               | Description            |
| --------------------------- | --------------------- | ---------------------- |
| `NEXT_PUBLIC_LOGO_LIGHT`    | `/logo-light.png`     | Logo for light mode    |
| `NEXT_PUBLIC_LOGO_DARK`     | `/logo-ever-work.png` | Logo for dark mode     |
| `NEXT_PUBLIC_FAVICON_LIGHT` | `/favicon-light.png`  | Favicon for light mode |
| `NEXT_PUBLIC_FAVICON_DARK`  | `/favicon-dark.png`   | Favicon for dark mode  |

### Social Media / Twitter Cards

| Variable                          | Default               | Description              |
| --------------------------------- | --------------------- | ------------------------ |
| `NEXT_PUBLIC_TWITTER_CARD`        | `summary_large_image` | Twitter card type        |
| `NEXT_PUBLIC_TWITTER_TITLE`       | Uses `APP_NAME`       | Twitter card title       |
| `NEXT_PUBLIC_TWITTER_DESCRIPTION` | Uses site description | Twitter card description |

### Internationalization

| Variable                     | Default             | Description                         |
| ---------------------------- | ------------------- | ----------------------------------- |
| `NEXT_PUBLIC_LOCALES`        | `en,ar,de,es,fr,zh` | Supported locales (comma-separated) |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | `en`                | Default locale                      |

The dashboard has built-in support for 21 locales: en, ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh.

### Application Behavior

| Variable                           | Default               | Description                              |
| ---------------------------------- | --------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_DIRECTORY_LIST_LIMIT` | `6`                   | Directories per page (pagination)        |
| `REDIRECT_SEARCH_PARAM`            | `redirect_uri`        | URL param for post-login redirect        |
| `ALLOWED_REDIRECT_URLS`            | `localhost,127.0.0.1` | Allowed redirect hosts (comma-separated) |

### Authentication

| Variable        | Default             | Description                            |
| --------------- | ------------------- | -------------------------------------- |
| `COOKIE_SECRET` | (none, required)    | Secret for encrypting auth cookies     |
| `AUTH_SECRET`   | (none, alternative) | Alternative name for the cookie secret |

Generate a strong secret for production:

```bash
openssl rand -base64 32
```

### Build Configuration

| Variable            | Default | Description                                 |
| ------------------- | ------- | ------------------------------------------- |
| `NEXT_BUILD_OUTPUT` | (empty) | Build output mode: `standalone` or `export` |

## Next.js Configuration

The `next.config.ts` file configures Next.js with the following:

### Internationalization Plugin

The config wraps the Next.js config with `next-intl/plugin` to enable locale-aware routing:

```typescript
import createNextIntlPlugin from 'next-intl/plugin';
const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
```

### Image Remote Patterns

The following external image domains are whitelisted:

- `github.com` -- GitHub repository avatars
- `lh3.googleusercontent.com` -- Google profile images
- `avatars.githubusercontent.com` -- GitHub user avatars

### Build Output

The `output` property is dynamically set from `NEXT_BUILD_OUTPUT`. When set to `standalone`, Next.js produces a self-contained deployment directory suitable for Docker containers.

## Site Configuration Object

The `getSiteConfig()` function in `lib/constants.ts` merges environment variables with optional directory-level `config.yml` overrides. This supports multi-tenant scenarios where a deployed directory site can override the base branding:

```typescript
const config = getSiteConfig(directoryConfig);
// config.name, config.logo, config.favicon, config.title, etc.
```

The precedence order is:

1. Directory `config.yml` values (if present)
2. `NEXT_PUBLIC_*` environment variables
3. Hardcoded defaults

## Route Constants

All dashboard routes are defined as constants in `lib/constants.ts`:

```typescript
export const ROUTES = {
	DASHBOARD: '/',
	DASHBOARD_DIRECTORIES: '/directories',
	DASHBOARD_DIRECTORY: (id: string) => `/directories/${id}`
	// ... all other routes
};
```

This ensures route strings are never duplicated across the codebase.

## Public Routes

Routes that do not require authentication are defined in `PUBLIC_ROUTES`:

- All auth pages (login, register, forgot-password, reset-password)
- Static pages (/about, /contact, /privacy, /terms, /help)

All other routes require a valid auth cookie.
