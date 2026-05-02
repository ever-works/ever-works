---
id: getting-started
title: Getting Started
sidebar_label: Getting Started
sidebar_position: 3
---

# Getting Started

This guide takes you from a fresh clone to a running local instance with a working work. For detailed installation steps, database options, Docker setup, and troubleshooting, see [Installation](./installation).

## Quick Start

### 1. Prerequisites

- **Node.js** 20+ — [nodejs.org](https://nodejs.org)
- **pnpm** 10.30+ — `corepack enable && corepack prepare pnpm@latest --activate`
- **Git** 2.x+ — [git-scm.com](https://git-scm.com)

### 2. Clone and Install

```bash
git clone https://github.com/ever-works/ever-works.git
cd ever-works
pnpm install
```

### 3. Build Workspace Packages

Shared packages must be built before the apps can run in dev mode:

```bash
pnpm build:packages
```

### 4. Configure Environment

```bash
# API environment
cp apps/api/.env.example apps/api/.env

# Web environment
cp apps/web/.env.example apps/web/.env.local
```

Open `apps/api/.env` and set at minimum:

```bash
JWT_SECRET=generate-a-strong-random-string-here
DATABASE_TYPE=sqlite
DATABASE_IN_MEMORY=true
WEB_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

Open `apps/web/.env.local` and set:

```bash
API_URL=http://localhost:3100
NEXT_PUBLIC_WEB_URL=http://localhost:3000
COOKIE_SECRET=your-secret-key-here
AUTH_SECRET=your-secret-key-here
```

### 5. Start the Dev Server

```bash
# Start both API (port 3100) and Web (port 3000) in watch mode
pnpm dev
```

Open `http://localhost:3000` in your browser. You should see the web dashboard.

:::tip
You can also start apps individually: `pnpm dev:api` for the API only, or `pnpm dev:web` for the web dashboard only.
:::

## Configuring Plugins

The platform uses a **plugin system** for all external integrations. Out of the box, most plugins are disabled or unconfigured. To create and generate works, you need to configure at least a **git provider** and an **AI provider**.

### GitHub Plugin (Git Provider) — Required

The GitHub plugin handles repository creation, cloning, and deployment. It requires a GitHub OAuth App:

1. Go to [GitHub Developer Settings > OAuth Apps > New OAuth App](https://github.com/settings/developers).
2. Set the **Authorization callback URL** to `http://localhost:3000/api/oauth/github/callback/plugins`.
3. Copy the Client ID and Client Secret into `apps/api/.env`:

```bash
PLUGIN_GITHUB_CLIENT_ID=your_client_id
PLUGIN_GITHUB_CLIENT_SECRET=your_client_secret
```

4. Restart the API (`pnpm dev:api`).
5. In the web dashboard, go to **Settings > Plugins > GitHub** and connect your GitHub account via OAuth.

:::info
The GitHub plugin uses separate OAuth credentials from the login GitHub OAuth (`GH_CLIENT_ID`/`GH_CLIENT_SECRET`). Login OAuth is optional — you can register with email/password instead. The plugin OAuth is what enables git operations.
:::

### AI Provider — Required for Generation

You need at least one AI provider to generate work content. The simplest option is **OpenRouter** (one API key gives access to 400+ models):

```bash
PLUGIN_OPENROUTER_API_KEY=your_openrouter_api_key
```

Alternatively, configure a direct provider. Each provider reads its API key from the user's plugin settings in the dashboard, but you can set defaults via environment variables:

| Provider      | Environment Variable        | Notes                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------ |
| OpenRouter    | `PLUGIN_OPENROUTER_API_KEY` | Recommended — one key, multiple models                       |
| OpenAI        | —                           | Configure via dashboard: Settings > Plugins > OpenAI         |
| Anthropic     | —                           | Configure via dashboard: Settings > Plugins > Anthropic      |
| Google Gemini | —                           | Configure via dashboard: Settings > Plugins > Google AI      |
| Groq          | —                           | Configure via dashboard: Settings > Plugins > Groq           |
| Ollama        | —                           | No API key needed — runs locally on `http://localhost:11434` |

After setting the env var, restart the API. The plugin is auto-discovered and enabled. Users can then add their own API keys in the dashboard under **Settings > Plugins > [Provider]**.

### Search Provider — Recommended

Search plugins power the web discovery phase of generation. **Tavily** is the default:

```bash
PLUGIN_TAVILY_API_KEY=your_tavily_api_key
```

Without a search provider, the pipeline can still generate items using the AI's training data, but it won't discover current, real-world items from the web.

### Screenshot Provider — Optional

Screenshot plugins capture website previews for work items:

```bash
PLUGIN_SCREENSHOTONE_ACCESS_KEY=your_access_key
```

Without a screenshot provider, works are fully functional but items won't have visual previews.

### Minimum Viable Configuration

For the fastest path to a working instance, you need these three env vars in `apps/api/.env` (beyond the defaults):

```bash
PLUGIN_GITHUB_CLIENT_ID=...        # From your GitHub OAuth App
PLUGIN_GITHUB_CLIENT_SECRET=...    # From your GitHub OAuth App
PLUGIN_OPENROUTER_API_KEY=...      # From openrouter.ai
```

Then connect your GitHub account via the dashboard, and you can create works.

## Your First Work

Once the dev server is running and plugins are configured:

1. **Register an account** — Open `http://localhost:3000` and sign up with email/password (or GitHub OAuth if configured).

2. **Connect GitHub** — Go to **Settings > Plugins > GitHub** and click **Connect**. This authorizes the platform to create repositories on your behalf.

3. **Create a work** — Navigate to **Works > New Work**. You'll see three options:
    - **AI Creation** — enter a name (e.g., "Best React Libraries") and a prompt describing what to include. The AI pipeline handles everything.
    - **Manual** — enter name, slug, and description. Creates an empty work you populate later.
    - **Import** — provide a GitHub repository URL to import from.

4. **Select providers** — In AI Creation mode, expand **Advanced Settings** to choose which pipeline, AI provider, and search provider to use. The defaults work out of the box if you configured OpenRouter.

5. **Watch generation** — After submission, you're redirected to the work detail page. Generation runs in the background — you can watch progress in real time.

For a detailed explanation of each creation method, provider selection, and pipeline plugins, see [Creating a Work](./features/creating-a-work).

## Development Commands

```bash
# Start all apps in watch mode
pnpm dev

# Start individually
pnpm dev:api            # API on port 3100
pnpm dev:web            # Web on port 3000
pnpm dev:trigger        # Trigger.dev (background jobs)

# Build, lint, type-check
pnpm build              # Build everything
pnpm lint               # ESLint all packages
pnpm type-check         # TypeScript check all packages
pnpm format             # Prettier format

# Testing
pnpm test               # All tests
cd packages/agent && pnpm test    # Agent tests (Jest)
cd packages/plugins/openai && pnpm test  # Plugin tests (Vitest)
```

## API Documentation (Interactive)

Once the API is running:

| URL                                      | Format               |
| ---------------------------------------- | -------------------- |
| `http://localhost:3100/api/swagger`      | Swagger UI           |
| `http://localhost:3100/api/docs`         | Scalar API Reference |
| `http://localhost:3100/api/openapi.json` | OpenAPI JSON spec    |

## Next Steps

- [Installation](./installation) — Detailed setup: database options, Docker Compose, troubleshooting
- [Environment Variables](./environment-variables) — Complete variable reference (80+ vars)
- [Creating a Work](./features/creating-a-work) — The three creation methods, providers, and pipeline plugins
- [Architecture](./architecture) — Monorepo structure, modules, and data flow
- [Plugin System](./plugin-system/) — Plugin architecture and creating custom plugins
- [API Reference](./api/) — REST API endpoints
