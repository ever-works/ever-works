---
id: index
title: Ever Works Platform
sidebar_label: Home
sidebar_position: 1
slug: /
---

# Ever Works Platform

**Ever Works is the Workshop for AI** — an open agentic runtime that autonomously researches, ships and maintains content-rich websites and Git repositories. The Ever Works Platform is the system behind it. It provides REST APIs, an AI generation pipeline, database management, and deployment tooling — all organized as a **Turborepo + pnpm workspaces** monorepo.

You describe a goal; a standing team of AI [Agents](./features/agents) turns it into [Ideas](./features/ideas), Ideas into [Works](./features/creating-a-work) — a website, landing page, blog, directory, or awesome repo — and then keeps those Works researched, written, improved, and deployed. Code and content both live in Git repositories you own. The platform is open source under **AGPLv3** and can be self-hosted.

## Start here

1. **Get an account and walk the setup wizard** — the `/onboarding` wizard picks your AI provider, storage, database, deployment target, and plugins. See [Onboarding & Setup Wizard](./features/onboarding).
2. **Create your first Work** — the sidebar's **+ New** button opens `/new`, where a prompt plus a kind chip (Mission, Idea, Website, Landing Page, Blog, Directory, Awesome Repo, Company) starts the build. See [Creating a Work](./features/creating-a-work).
3. **Watch it build, then ship it** — follow the run on the Work's **Generator** tab (`/works/:id/generator`) and publish from the **Deploy** tab (`/works/:id/deploy`). See the [Quickstart for a directory](./guides/quickstart-directory).
4. **Give it a team** — create Agents under **Teams → Agents**, set a heartbeat cadence and a budget, and they keep working on a schedule. See [Autonomous Operation](./features/autonomous-operation).

Prefer to run everything yourself? [Getting Started](./getting-started) and [Installation](./installation) cover local development, Docker Compose, and Kubernetes.

## Components

| Component                | Technology                      | Description                                                                                                       |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **API**                  | NestJS 11                       | REST API with JWT auth, work management, AI conversations, deployment                                             |
| **Web Dashboard**        | Next.js 16                      | Admin interface for managing works and content                                                                    |
| **MCP Server**           | NestJS + MCP SDK                | Exposes the API to AI clients as MCP tools, over `stdio` or streamable HTTP (`apps/mcp`)                          |
| **CLI**                  | Commander.js + esbuild          | Standalone command-line tool for work operations                                                                  |
| **Internal CLI**         | nest-commander                  | Internal tooling for maintenance tasks                                                                            |
| **Desktop App**          | Electron + Vite                 | All-in-one shell: install wizard, local API + web supervisor, embedded dashboard (`apps/desktop`)                 |
| **Desktop Node**         | Electron + Vite                 | Thin shell that enrolls a machine as an execution node — setup wizard, status window, tray (`apps/desktop-node`)  |
| **Node**                 | TypeScript CLI + service        | Headless execution node: fleet enrollment, heartbeat, capability reporting (`apps/node`)                          |
| **Admin**                | Reserved workspace              | Placeholder for a standalone operator console; operator surfaces ship inside the dashboard today (`/admin/usage`) |
| **@packages/agent**      | Vercel AI SDK (`ai` 6), TypeORM | AI agents, data generation, database, git operations, deployment                                                  |
| **@packages/monitoring** | Sentry, PostHog                 | Error tracking and product analytics                                                                              |
| **@packages/tasks**      | Trigger.dev                     | Background job processing — Trigger.dev is one of six pluggable [job runtimes](./features/job-runtimes)           |

## Documentation

- [Platform Overview](./overview) — How the platform works and its tech stack
- [Getting Started](./getting-started) — Prerequisites, installation, and development setup
- [Architecture](./architecture) — Monorepo structure, modules, and data flow
- [Features](./features/) — Missions, Ideas, Works, Agents, Knowledge Base & Memory, Teams, Tasks, quality gates, budgets, deployment, and the rest of the platform
- [Guides](./guides/platform-tour) — Screen-by-screen platform tour, per-kind quickstarts, and the founder journey
- [API Reference](./api/) — REST API endpoints and usage
- [CLI Reference](./cli/) — Command-line interface usage and commands
- [AI & Generation](./ai-agents/) — AI providers, generation pipeline, and model routing
- [Database](./database) — Supported databases, entities, and configuration
- [Plugin System](./plugin-system/) — 102 plugins across 19 categories, bundled by default and installable at runtime when dynamic distribution is enabled

## Community & Resources

- **[GitHub](https://github.com/ever-works)** — Source code and issues
- **[Discord](https://discord.gg/ever)** — Join the community
- **[FAQ](./faq)** — Frequently asked questions
- **[Support](./support)** — Get help and support
