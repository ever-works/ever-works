---
id: environment-variables
title: Environment Variables Reference
sidebar_label: Environment Variables
sidebar_position: 6
---

# Environment Variables Reference

Complete reference for all environment variables used by the Ever Works Platform. Variables are sourced from two files:

| File                  | App                        | Committed                      |
| --------------------- | -------------------------- | ------------------------------ |
| `apps/api/.env`       | API (NestJS)               | No -- copy from `.env.example` |
| `apps/web/.env.local` | Web (Next.js)              | No -- copy from `.env.example` |
| `.env.compose`        | Docker Compose (both apps) | Template only                  |

:::tip
Variables prefixed with `NEXT_PUBLIC_` are exposed to the browser. All other variables are server-side only.
:::

---

## Core Configuration (API)

| Variable          | Description                            | Type      | Default                                       | Required |
| ----------------- | -------------------------------------- | --------- | --------------------------------------------- | -------- |
| `APP_TYPE`        | Application type identifier            | `string`  | `api`                                         | Yes      |
| `PORT`            | HTTP port for the API server           | `number`  | `3100`                                        | Yes      |
| `HTTP_DEBUG`      | Enable verbose HTTP request logging    | `boolean` | `false`                                       | No       |
| `WEB_URL`         | Full URL of the web application        | `string`  | `http://localhost:3000`                       | Yes      |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) | `string`  | `http://localhost:3000,http://localhost:3001` | Yes      |

## Core Configuration (Web)

| Variable               | Description                               | Type     | Default                 | Required |
| ---------------------- | ----------------------------------------- | -------- | ----------------------- | -------- |
| `APP_NAME`             | Application name (fallback for site name) | `string` | `Ever Works`            | No       |
| `NEXT_PUBLIC_APP_NAME` | Public application name                   | `string` | `Ever Works`            | No       |
| `NEXT_PUBLIC_WEB_URL`  | Public web application URL                | `string` | `http://localhost:3000` | Yes      |
| `API_URL`              | Backend API URL (server-side)             | `string` | `http://localhost:3100` | Yes      |

---

## Authentication -- JWT

| Variable                            | Description                                       | Type      | Default | Required |
| ----------------------------------- | ------------------------------------------------- | --------- | ------- | -------- |
| `JWT_SECRET`                        | Secret key for signing JWT tokens                 | `string`  | --      | **Yes**  |
| `JWT_ACCESS_TOKEN_EXPIRATION`       | Access token TTL (`15m`, `1h`, `7d`, or `never`)  | `string`  | `7d`    | No       |
| `JWT_REFRESH_TOKEN_EXPIRATION_DAYS` | Refresh token TTL in days (`7`, `30`, or `never`) | `string`  | `14`    | No       |
| `JWT_DISABLE_EXPIRATION`            | Disable all token expiration (dev only)           | `boolean` | `false` | No       |

## Authentication -- OAuth Providers

### GitHub OAuth

| Variable           | Description                            | Type     | Default                                | Required |
| ------------------ | -------------------------------------- | -------- | -------------------------------------- | -------- |
| `GH_CLIENT_ID`     | GitHub OAuth application Client ID     | `string` | --                                     | No       |
| `GH_CLIENT_SECRET` | GitHub OAuth application Client Secret | `string` | --                                     | No       |
| `GH_CALLBACK_URL`  | GitHub OAuth callback URL              | `string` | `${WEB_URL}/api/oauth/github/callback` | No       |

### Google OAuth

| Variable               | Description                | Type     | Default                                | Required |
| ---------------------- | -------------------------- | -------- | -------------------------------------- | -------- |
| `GOOGLE_CLIENT_ID`     | Google OAuth Client ID     | `string` | --                                     | No       |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | `string` | --                                     | No       |
| `GOOGLE_CALLBACK_URL`  | Google OAuth callback URL  | `string` | `${WEB_URL}/api/oauth/google/callback` | No       |

## Authentication -- Web (Cookies/Session)

| Variable                | Description                              | Type     | Default               | Required |
| ----------------------- | ---------------------------------------- | -------- | --------------------- | -------- |
| `COOKIE_SECRET`         | Secret for encrypting session cookies    | `string` | --                    | **Yes**  |
| `AUTH_SECRET`           | Alternative name for cookie secret       | `string` | --                    | **Yes**  |
| `REDIRECT_SEARCH_PARAM` | Query parameter key for redirects        | `string` | `redirect_uri`        | No       |
| `ALLOWED_REDIRECT_URLS` | Allowed redirect hosts (comma-separated) | `string` | `localhost,127.0.0.1` | No       |

---

## Database

### Database Type Selection

| Variable        | Description     | Type                              | Default  | Required |
| --------------- | --------------- | --------------------------------- | -------- | -------- |
| `DATABASE_TYPE` | Database engine | `sqlite` \| `postgres` \| `mysql` | `sqlite` | Yes      |

### SQLite Configuration

Used when `DATABASE_TYPE=sqlite`:

| Variable             | Description                   | Type      | Default                                             | Required |
| -------------------- | ----------------------------- | --------- | --------------------------------------------------- | -------- |
| `DATABASE_PATH`      | File path for SQLite database | `string`  | `:memory:` (dev) or `/tmp/ever-works-api.db` (prod) | No       |
| `DATABASE_IN_MEMORY` | Force in-memory database      | `boolean` | `true`                                              | No       |

### PostgreSQL Configuration

Used when `DATABASE_TYPE=postgres`:

| Variable            | Description                                       | Type     | Default      | Required |
| ------------------- | ------------------------------------------------- | -------- | ------------ | -------- |
| `DATABASE_HOST`     | PostgreSQL server hostname                        | `string` | `localhost`  | Yes      |
| `DATABASE_PORT`     | PostgreSQL server port                            | `number` | `5432`       | No       |
| `DATABASE_USERNAME` | PostgreSQL username                               | `string` | `postgres`   | Yes      |
| `DATABASE_PASSWORD` | PostgreSQL password                               | `string` | --           | Yes      |
| `DATABASE_NAME`     | Database name                                     | `string` | `ever_works` | Yes      |
| `DATABASE_URL`      | Full connection URL (overrides individual fields) | `string` | --           | No       |

### MySQL / MariaDB Configuration

Used when `DATABASE_TYPE=mysql`:

| Variable            | Description                                       | Type     | Default      | Required |
| ------------------- | ------------------------------------------------- | -------- | ------------ | -------- |
| `DATABASE_HOST`     | MySQL server hostname                             | `string` | `localhost`  | Yes      |
| `DATABASE_PORT`     | MySQL server port                                 | `number` | `3306`       | No       |
| `DATABASE_USERNAME` | MySQL username                                    | `string` | `root`       | Yes      |
| `DATABASE_PASSWORD` | MySQL password                                    | `string` | --           | Yes      |
| `DATABASE_NAME`     | Database name                                     | `string` | `ever_works` | Yes      |
| `DATABASE_URL`      | Full connection URL (overrides individual fields) | `string` | --           | No       |

### Common Database Options

| Variable            | Description                             | Type      | Default | Required |
| ------------------- | --------------------------------------- | --------- | ------- | -------- |
| `DATABASE_LOGGING`  | Enable SQL query logging                | `boolean` | `false` | No       |
| `DATABASE_SSL_MODE` | Enable SSL/TLS for database connections | `boolean` | `false` | No       |
| `DATABASE_CA_CERT`  | CA certificate for SSL connections      | `string`  | --      | No       |

---

## Email / Mailer

| Variable          | Description            | Type                         | Default                        | Required |
| ----------------- | ---------------------- | ---------------------------- | ------------------------------ | -------- |
| `MAILER_PROVIDER` | Mail provider          | `smtp` \| `none` \| `resend` | `none`                         | No       |
| `EMAIL_FROM`      | Default sender address | `string`                     | `Ever Works <ever@ever.works>` | No       |

### SMTP Configuration

Used when `MAILER_PROVIDER=smtp`:

| Variable          | Description                     | Type      | Default          | Required |
| ----------------- | ------------------------------- | --------- | ---------------- | -------- |
| `SMTP_HOST`       | SMTP server hostname            | `string`  | `smtp.gmail.com` | Yes      |
| `SMTP_PORT`       | SMTP server port                | `number`  | `587`            | Yes      |
| `SMTP_USER`       | SMTP username / email           | `string`  | --               | Yes      |
| `SMTP_PASSWORD`   | SMTP password                   | `string`  | --               | Yes      |
| `SMTP_SECURE`     | Use TLS for SMTP connection     | `boolean` | `false`          | No       |
| `SMTP_IGNORE_TLS` | Ignore TLS (insecure, dev only) | `boolean` | `false`          | No       |

### Resend Configuration

Used when `MAILER_PROVIDER=resend`:

| Variable            | Description               | Type     | Default | Required |
| ------------------- | ------------------------- | -------- | ------- | -------- |
| `RESEND_APIKEY`     | Resend API key            | `string` | --      | Yes      |
| `RESEND_EMAIL_FROM` | Sender address for Resend | `string` | --      | No       |

---

## Subscriptions & Billing

| Variable                     | Description                    | Type      | Default | Required                   |
| ---------------------------- | ------------------------------ | --------- | ------- | -------------------------- |
| `SUBSCRIPTIONS_ENABLED`      | Enable the subscription system | `boolean` | `false` | No                         |
| `BILLING_DEFAULT_CURRENCY`   | Default billing currency       | `string`  | `usd`   | No                         |
| `SUBSCRIPTIONS_DEFAULT_PLAN` | Default plan for new users     | `string`  | `free`  | No                         |
| `STRIPE_SECRET_KEY`          | Stripe API secret key          | `string`  | --      | When subscriptions enabled |
| `STRIPE_WEBHOOK_SECRET`      | Stripe webhook signing secret  | `string`  | --      | When subscriptions enabled |

---

## Work Generation

| Variable                   | Description                                     | Type     | Default | Required |
| -------------------------- | ----------------------------------------------- | -------- | ------- | -------- |
| `WORK_STALE_TIMEOUT_HOURS` | Timeout before a stale generation is cleaned up | `number` | `2`     | No       |

## Scheduled Work Updates

| Variable                                      | Description                                | Type      | Default | Required |
| --------------------------------------------- | ------------------------------------------ | --------- | ------- | -------- |
| `SCHEDULED_UPDATES_ENABLED`                   | Enable automatic work updates              | `boolean` | `true`  | No       |
| `SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES` | Interval between update dispatch cycles    | `number`  | `5`     | No       |
| `SCHEDULED_UPDATES_MAX_BATCH`                 | Maximum works per update batch             | `number`  | `25`    | No       |
| `SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE`  | Failures before pausing updates for a work | `number`  | `3`     | No       |
| `PAY_PER_USE_PRICE_USD`                       | Price per on-demand work update            | `number`  | `5`     | No       |

## Website Template

| Variable                               | Description                          | Type      | Default | Required |
| -------------------------------------- | ------------------------------------ | --------- | ------- | -------- |
| `WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED` | Enable automatic template updates    | `boolean` | `true`  | No       |
| `WEBSITE_TEMPLATE_BETA_BRANCH`         | Git branch for beta template updates | `string`  | `stage` | No       |

---

## Trigger.dev (Background Jobs)

| Variable                   | Description                                   | Type                                                                                          | Default                                  | Required     |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------ |
| `TRIGGER_ENABLED`          | Enable Trigger.dev integration                | `boolean`                                                                                     | `false`                                  | No           |
| `TRIGGER_SECRET_KEY`       | Trigger.dev API secret key                    | `string`                                                                                      | --                                       | When enabled |
| `TRIGGER_API_URL`          | Trigger.dev API endpoint                      | `string`                                                                                      | `https://api.trigger.dev`                | No           |
| `TRIGGER_INTERNAL_SECRET`  | Shared secret for internal trigger callbacks  | `string`                                                                                      | --                                       | When enabled |
| `TRIGGER_MACHINE`          | Worker machine size                           | `micro` \| `small-1x` \| `small-2x` \| `medium-1x` \| `medium-2x` \| `large-1x` \| `large-2x` | --                                       | No           |
| `TRIGGER_INTERNAL_API_URL` | Internal callback URL for Trigger.dev workers | `string`                                                                                      | `http://localhost:3100/internal/trigger` | No           |

---

## CRM Integration (Twenty CRM)

| Variable                        | Description                                  | Type      | Default                  | Required       |
| ------------------------------- | -------------------------------------------- | --------- | ------------------------ | -------------- |
| `TWENTY_CRM_BASE_URL`           | Twenty CRM API base URL                      | `string`  | `https://api.twenty.com` | No             |
| `TWENTY_CRM_API_KEY`            | Twenty CRM API key                           | `string`  | --                       | When using CRM |
| `TWENTY_CRM_WORKSPACE_ID`       | Twenty CRM workspace identifier              | `string`  | --                       | When using CRM |
| `TWENTY_CRM_MAX_RETRIES`        | Maximum retry attempts for failed requests   | `number`  | `3`                      | No             |
| `TWENTY_CRM_RETRY_DELAY_MS`     | Initial delay between retries (milliseconds) | `number`  | `1000`                   | No             |
| `TWENTY_CRM_BACKOFF_MULTIPLIER` | Exponential backoff multiplier               | `number`  | `2`                      | No             |
| `TWENTY_CRM_TIMEOUT_MS`         | Request timeout (milliseconds)               | `number`  | `30000`                  | No             |
| `TWENTY_CRM_ENABLE_LOGGING`     | Enable CRM request/response logging          | `boolean` | `true`                   | No             |

---

## Plugins

### GitHub Plugin

Separate from the GitHub OAuth configuration above -- used for work Git operations:

| Variable                      | Description                                   | Type     | Default | Required |
| ----------------------------- | --------------------------------------------- | -------- | ------- | -------- |
| `PLUGIN_GITHUB_CLIENT_ID`     | GitHub OAuth App ID for plugin operations     | `string` | --      | No       |
| `PLUGIN_GITHUB_CLIENT_SECRET` | GitHub OAuth App Secret for plugin operations | `string` | --      | No       |

Callback URL: `{WEB_URL}/api/oauth/github/callback/plugins`

### Tavily Plugin (Search)

| Variable                | Description           | Type     | Default | Required |
| ----------------------- | --------------------- | -------- | ------- | -------- |
| `PLUGIN_TAVILY_API_KEY` | Tavily search API key | `string` | --      | No       |

### ScreenshotOne Plugin

| Variable                          | Description                  | Type     | Default | Required |
| --------------------------------- | ---------------------------- | -------- | ------- | -------- |
| `PLUGIN_SCREENSHOTONE_ACCESS_KEY` | ScreenshotOne API access key | `string` | --      | No       |
| `PLUGIN_SCREENSHOTONE_SECRET_KEY` | ScreenshotOne API secret key | `string` | --      | No       |

### OpenRouter Plugin (AI Provider)

| Variable                          | Description                        | Type     | Default                | Required |
| --------------------------------- | ---------------------------------- | -------- | ---------------------- | -------- |
| `PLUGIN_OPENROUTER_API_KEY`       | OpenRouter API key                 | `string` | --                     | No       |
| `PLUGIN_OPENROUTER_DEFAULT_MODEL` | Default model for general use      | `string` | `openai/gpt-5-nano`    | No       |
| `PLUGIN_OPENROUTER_SIMPLE_MODEL`  | Model for simple/fast tasks        | `string` | `openai/gpt-5-nano`    | No       |
| `PLUGIN_OPENROUTER_MEDIUM_MODEL`  | Model for medium complexity tasks  | `string` | `moonshotai/kimi-k2.5` | No       |
| `PLUGIN_OPENROUTER_COMPLEX_MODEL` | Model for complex generation tasks | `string` | `moonshotai/kimi-k2.5` | No       |

---

## Web -- Site & SEO Configuration

These variables control branding and metadata for the web dashboard. All are optional with sensible defaults.

| Variable                       | Description                     | Type     | Default                   |
| ------------------------------ | ------------------------------- | -------- | ------------------------- |
| `NEXT_PUBLIC_SITE_NAME`        | Site display name               | `string` | Uses `APP_NAME`           |
| `NEXT_PUBLIC_SITE_TITLE`       | HTML title / SEO title          | `string` | Uses `APP_NAME`           |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | Meta description                | `string` | `Build Works with AI`     |
| `NEXT_PUBLIC_SITE_KEYWORDS`    | Meta keywords (comma-separated) | `string` | `Ever Works,Works,AI,...` |
| `NEXT_PUBLIC_SITE_AUTHOR`      | Site author metadata            | `string` | Uses `APP_NAME`           |
| `NEXT_PUBLIC_SITE_IMAGE`       | Default Open Graph image path   | `string` | `/logo-light.png`         |

## Web -- Logo & Favicon

| Variable                    | Description            | Type     | Default               |
| --------------------------- | ---------------------- | -------- | --------------------- |
| `NEXT_PUBLIC_LOGO_LIGHT`    | Logo for light mode    | `string` | `/logo-light.png`     |
| `NEXT_PUBLIC_LOGO_DARK`     | Logo for dark mode     | `string` | `/logo-ever-work.png` |
| `NEXT_PUBLIC_FAVICON_LIGHT` | Favicon for light mode | `string` | `/favicon-light.png`  |
| `NEXT_PUBLIC_FAVICON_DARK`  | Favicon for dark mode  | `string` | `/favicon-dark.png`   |

## Web -- Social Media / Twitter Cards

| Variable                          | Description              | Type                               | Default               |
| --------------------------------- | ------------------------ | ---------------------------------- | --------------------- |
| `NEXT_PUBLIC_TWITTER_CARD`        | Twitter card type        | `summary` \| `summary_large_image` | `summary_large_image` |
| `NEXT_PUBLIC_TWITTER_TITLE`       | Twitter card title       | `string`                           | Uses `APP_NAME`       |
| `NEXT_PUBLIC_TWITTER_DESCRIPTION` | Twitter card description | `string`                           | Uses site description |

## Web -- Internationalization (i18n)

| Variable                     | Description                         | Type     | Default             |
| ---------------------------- | ----------------------------------- | -------- | ------------------- |
| `NEXT_PUBLIC_LOCALES`        | Supported locales (comma-separated) | `string` | `en,ar,de,es,fr,zh` |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | Default locale                      | `string` | `en`                |

## Web -- Application Settings

| Variable                      | Description                 | Type                     | Default                       |
| ----------------------------- | --------------------------- | ------------------------ | ----------------------------- |
| `NEXT_PUBLIC_WORK_LIST_LIMIT` | Works per page (pagination) | `number`                 | `6`                           |
| `NEXT_BUILD_OUTPUT`           | Next.js build output mode   | `standalone` \| `export` | -- (default Next.js behavior) |

---

## Environment-Specific Values

### Development (Recommended Defaults)

```bash
# API
DATABASE_TYPE=sqlite
DATABASE_IN_MEMORY=true
HTTP_DEBUG=false
MAILER_PROVIDER=none
SUBSCRIPTIONS_ENABLED=false
TRIGGER_ENABLED=false

# Web
API_URL=http://localhost:3100
NEXT_PUBLIC_WEB_URL=http://localhost:3000
```

### Production

```bash
# API
DATABASE_TYPE=postgres
DATABASE_SSL_MODE=true
JWT_SECRET=<strong-random-secret>
MAILER_PROVIDER=smtp
SUBSCRIPTIONS_ENABLED=true

# Web
API_URL=https://api.yoursite.com
NEXT_PUBLIC_WEB_URL=https://yoursite.com
COOKIE_SECRET=<strong-random-secret>
NEXT_BUILD_OUTPUT=standalone
```

Generate secrets with:

```bash
openssl rand -base64 32
```
