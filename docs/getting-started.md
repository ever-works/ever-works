---
id: getting-started
title: Getting Started
sidebar_label: Getting Started
sidebar_position: 3
description: Two ways to start with Ever Works — the hosted platform, where nothing is installed, or a local clone of the monorepo — plus the plugin keys you need and how to create your first Work.
---

# Getting Started

There are two ways to start with Ever Works, and they end up in the same product: the **hosted platform**, where you install nothing, and a **local clone** of the open-source monorepo, which you run yourself. This page covers both, then walks you from a fresh clone to a running local instance with a generated Work.

## Hosted or local?

| Path                    | What you do                                                                                        | Pick it when                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Hosted platform**     | Open `https://app.ever.works/register`, walk the setup wizard, describe what you want. No install. | You want to build Works, not operate infrastructure. Keeping the Ever Works defaults means you supply no API keys. |
| **Local / self-hosted** | Clone `ever-works/ever-works`, configure a git provider and an AI provider, run the apps yourself. | You are developing on the platform, or you want everything on machines you control, under AGPLv3.                  |

### The hosted path

Nothing below the **Quick Start** heading applies if you use the hosted platform. The whole first run is three steps:

1. **Start before you sign up (optional).** `/onboarding` is public: it mints a guest session in the browser, so you can type a prompt and get a Work generated before you have an account. The prompt travels in the URL fragment (`/onboarding#prompt=…`), so an idea typed on the marketing site survives the hop.
2. **Create the account.** `/register` — on the hosted platform, `https://app.ever.works/register` — asks for a full name, an email, a password of at least 8 characters, and the Terms checkbox. See [Creating an Account](./features/creating-an-account.md).
3. **Walk the setup wizard.** Ten steps: Welcome, AI, Git storage, DB storage, deployment, where Ever Works runs, what you do, communication, plugins, and **Create your first Work**. Every step can be skipped, every answer is saved as you go, and nothing is permanent — each choice maps to a page under Settings. See [Onboarding & Setup Wizard](./features/onboarding.md).

:::tip Keep the defaults and you need no keys
The wizard defaults to **Ever Works AI**, **Ever Works Git**, **Ever Works DB** and the **Ever Works** deploy target. Each managed default skips its own configuration step, so the fastest hosted run has no credential to paste anywhere. Picking a bring-your-own option (your GitHub, your Vercel team, your own Kubernetes cluster, your own AI key) adds a configuration step right after the choice it belongs to. Managed deployment is capped per account — the card states the cap — and is described in [Managed Hosting](./features/managed-hosting.md).
:::

## Quick Start

The rest of this page is the **local** path.

### 1. Prerequisites

- **Node.js** 22 or newer — [nodejs.org](https://nodejs.org). The root `package.json` declares `engines.node: ">=22"`, and the container images build on `node:22-alpine`.
- **pnpm** 10.33.3 — the repo pins it with `"packageManager": "pnpm@10.33.3"`, so let Corepack activate exactly that: `corepack enable && corepack prepare pnpm@10.33.3 --activate`. Never use npm or yarn in this monorepo.
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

### 5. Start the Dev Servers

There is no bare `pnpm dev` at the repo root — every target has its own script:

| Command            | What it starts                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:apps`    | Every app except docs, desktop and node — in practice the API on **3100**, the web dashboard on **3000**, and the MCP server, all in watch mode.                      |
| `pnpm dev:api`     | The NestJS API only, on port 3100 (`nest start -b swc --watch`).                                                                                                      |
| `pnpm dev:web`     | The Next.js dashboard only, on port 3000 (`next dev --turbopack`).                                                                                                    |
| `pnpm dev:docs`    | This documentation site — Docusaurus in `apps/docs`, rendering the `docs/` folder. It wants port 3000 too, so run it on its own or let Docusaurus pick the next port. |
| `pnpm dev:trigger` | The Trigger.dev dev server for background jobs (`@ever-works/trigger-tasks`).                                                                                         |

```bash
# API (port 3100) + Web (port 3000) + MCP, all in watch mode
pnpm dev:apps
```

Open `http://localhost:3000` in your browser. You should see the web dashboard.

:::tip
You rarely need all of them. `pnpm dev:api` plus `pnpm dev:web` in two terminals is the usual pair while working on a single app.
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

| Provider          | Environment Variable               | Notes                                                                                  |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| OpenRouter        | `PLUGIN_OPENROUTER_API_KEY`        | Recommended — one key, multiple models                                                 |
| Vercel AI Gateway | `PLUGIN_VERCEL_AI_GATEWAY_API_KEY` | The second gateway — one key, routed models                                            |
| OpenAI            | —                                  | Configure via dashboard: Settings > Plugins > OpenAI                                   |
| Anthropic         | —                                  | Configure via dashboard: Settings > Plugins > Anthropic                                |
| Google Gemini     | —                                  | Configure via dashboard: Settings > Plugins > Google AI                                |
| Groq              | —                                  | Configure via dashboard: Settings > Plugins > Groq                                     |
| Grok (xAI)        | `XAI_API_KEY`                      | Note: no `PLUGIN_` prefix. Defaults to `https://api.x.ai/v1`                           |
| Mistral           | `PLUGIN_MISTRAL_API_KEY`           | Defaults to `https://api.mistral.ai/v1`                                                |
| Ollama            | —                                  | No API key needed — runs locally on `http://localhost:11434/v1`                        |
| LM Studio         | —                                  | Local. Start the **Local Server** in LM Studio; defaults to `http://localhost:1234/v1` |
| vLLM              | —                                  | Local. `vllm serve <model>`; defaults to `http://localhost:8000/v1`                    |

After setting the env var, restart the API. The plugin is auto-discovered and enabled. Users can then add their own API keys in the dashboard under **Settings > Plugins > [Provider]**, or from the **AI Providers** category in the Settings sidebar.

:::note Local providers need a model name, not a key
Ollama, LM Studio and vLLM all expose an OpenAI-compatible endpoint, so they take a **Base URL** and a **Default model** instead of an API key — and both of those fields are required. Set them in **Settings > Plugins > [Provider]** after the server is up. See [Bring Your Own AI Provider](./guides/bring-your-own-ai-provider.md) for the full walkthrough, including per-Work overrides.
:::

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

3. **Start from `/new`** — the sidebar's **+ New** button opens `/new`, which has exactly two controls: a prompt box (_"What do you want to build?"_) and a row of chips saying what the prompt should become — **Mission · Idea · Agent · Task · Website · Landing Page · Blog · Directory · Awesome Repo · Company**, followed by an inert **Store** chip marked **Soon**. Picking a chip writes that chip's first example prompt into the box, so you always have real text to edit rather than a hint. The description must be at least 10 characters.

    Press the arrow (**Create**), or **Enter**, and two things happen at once: your prompt is sent to the AI chat panel prefixed with the chip's intent, and you are routed to the canvas for that kind. The five Work chips land on `/works/new?mode=ai&kind=<kind>`; **Mission** and **Idea** are created by the chat itself and drop you on `/missions` or `/ideas`. See [The + New page](./features/new-page.md).

4. **Or go straight to `/works/new`** — this is where the older three-way choice still lives, under the same kind chips:
    - **AI** (`?mode=ai`, the default when you arrive with a prompt) — the **New Work — with AI** form: Work name, slug, and the brief.
    - **Create Work Manually** — the same form reached without a prompt, for full control over every field.
    - **Import Existing Work** — point at a GitHub repository and import its items into a new Work.
    - **Start a campaign** — a separate brief at `/works/new/campaign` that provisions a Work, a goal, go-to-market agents and the first pipeline tasks in one go. See [Campaigns](./features/campaigns.md).

5. **Pick a blueprint** — the **Work template** picker on the create form lists the blueprint catalog for the selected kind, fetched from `GET /api/work-templates`. If the catalog is cold or unreachable it falls back to the built-in `classic` and `minimal` directory templates, so the picker is never empty. The blueprint you choose becomes the starting code and content of the Work's repository. See [Work Blueprints](./features/work-blueprints.md).

6. **Select providers** — the right-hand column of `/works/new` carries a **Git Provider** selector and, when deploy plugins are installed, a **Deploy Provider** selector. With nothing connected the deploy default is **Kubernetes** (the shared customer cluster, which needs no external account); **Vercel** takes over as the default the moment its token is connected. Inside the AI form, expand **Advanced Settings** to choose the pipeline, AI, search, screenshot and content-extractor providers. The defaults work out of the box if you configured OpenRouter.

7. **Watch generation** — after submission you're redirected to the Work. Generation runs in the background; follow the run on the **Generator** tab at `/works/:id/generator`, and publish from the **Deploy** tab at `/works/:id/deploy`.

For a detailed explanation of each creation method, provider selection, and pipeline plugins, see [Creating a Work](./features/creating-a-work.md).

## Development Commands

```bash
# Start apps in watch mode
pnpm dev:apps           # API (3100) + Web (3000) + MCP
pnpm dev:api            # API on port 3100
pnpm dev:web            # Web on port 3000
pnpm dev:docs           # This documentation site (Docusaurus)
pnpm dev:trigger        # Trigger.dev (background jobs)

# Build, lint, type-check
pnpm build              # Build everything except docs/desktop/node
pnpm build:packages     # Shared workspace packages only
pnpm build:plugins      # Plugin system + all plugins
pnpm lint               # ESLint all packages
pnpm type-check         # TypeScript check all packages
pnpm format             # Prettier format
pnpm format:check       # Prettier check — this is what CI runs

# Testing
pnpm test               # All tests
pnpm test:e2e           # Playwright end-to-end suite (web)
cd packages/agent && pnpm test    # Agent tests (Jest)
cd packages/plugins/openai && pnpm test  # Plugin tests (Vitest)
```

:::note Build before you test
The `test` task has no build dependency in `turbo.json`, but several packages resolve their workspace dependencies from `dist`. If tests fail with module-resolution errors, run `pnpm build` from the root first.
:::

## API Documentation (Interactive)

Once the API is running:

| URL                                      | Format               |
| ---------------------------------------- | -------------------- |
| `http://localhost:3100/api/swagger`      | Swagger UI           |
| `http://localhost:3100/api/docs`         | Scalar API Reference |
| `http://localhost:3100/api/openapi.json` | OpenAPI JSON spec    |

:::warning Development only
All three surfaces are mounted only when `NODE_ENV !== 'production'`. A production API serves no Swagger UI, no Scalar reference and no `openapi.json`, deliberately — the document is a full inventory of every endpoint and DTO shape. Use the published [API Reference](./api/) instead.
:::

## Next Steps

Pick the quickstart for the kind of Work you want, then take the tour:

- [Quickstart: A Marketing Website](./guides/quickstart-website.md) — a multi-page site with generated content and code
- [Quickstart: Ship a Landing Page](./guides/quickstart-landing-page.md) — a focused one-pager for a waitlist or launch
- [Quickstart: Launch a Blog](./guides/quickstart-blog.md) — categories, RSS, SEO-ready posts
- [Quickstart: Build a Directory](./guides/quickstart-directory.md) — search, filters, structured items
- [Quickstart: Build an Awesome List](./guides/quickstart-awesome-repo.md) — a markdown index repo that refreshes itself
- [Platform Tour (Screen by Screen)](./guides/platform-tour.md) — every dashboard screen, its route, and what you do there
- [The Founder Journey](./guides/founder-journey.md) — the concepts end to end, before the screens

Then go deeper:

- [Onboarding & Setup Wizard](./features/onboarding.md) — the ten-step wizard and the zero-friction first run
- [Installation](./installation.md) — Detailed setup: database options, Docker Compose, troubleshooting
- [Environment Variables](./environment-variables.md) — Complete variable reference (80+ vars)
- [Creating a Work](./features/creating-a-work.md) — The creation methods, providers, and pipeline plugins
- [Architecture](./architecture.md) — Monorepo structure, modules, and data flow
- [Plugin System](./plugin-system/) — Plugin architecture and creating custom plugins
- [API Reference](./api/) — REST API endpoints

## Related

- [The + New page](./features/new-page.md) · [Creating a Work](./features/creating-a-work.md) · [Work Blueprints](./features/work-blueprints.md)
- [Creating an Account](./features/creating-an-account.md) · [Onboarding & Setup Wizard](./features/onboarding.md) · [The Settings Map](./features/settings-map.md)
- [Bring Your Own AI Provider](./guides/bring-your-own-ai-provider.md) · [Self-host with Docker Compose and Kubernetes](./guides/self-host-docker-kubernetes.md) · [Desktop App](./guides/desktop-app.md)
- [CLI Quickstart](./guides/cli-quickstart.md) · [Use Ever Works from an MCP Client](./guides/mcp-server-setup.md)
- [Managed Hosting](./features/managed-hosting.md) · [Plugins](./features/plugins.md)
