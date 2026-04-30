---
id: index
title: Ever Works Platform
sidebar_label: Home
sidebar_position: 1
slug: /
---

# Ever Works Platform

The Ever Works Platform is the backend infrastructure that powers AI-generated directory websites. It provides REST APIs, an AI generation pipeline, database management, and deployment tooling — all organized as a **Turborepo + pnpm workspaces** monorepo.

## Components

| Component | Technology | Description |
|-----------|-----------|-------------|
| **API** | NestJS 11 | REST API with JWT auth, directory management, AI conversations, deployment |
| **Web Dashboard** | Next.js 16 | Admin interface for managing directories and content |
| **CLI** | Commander.js + esbuild | Standalone command-line tool for directory operations |
| **Internal CLI** | nest-commander | Internal tooling for maintenance tasks |
| **@packages/agent** | LangChain, TypeORM | AI agents, data generation, database, git operations, deployment |
| **@packages/monitoring** | Sentry, PostHog | Error tracking and product analytics |
| **@packages/tasks** | Trigger.dev | Background job processing |

## Documentation

- [Platform Overview](./overview) — How the platform works and its tech stack
- [Getting Started](./getting-started) — Prerequisites, installation, and development setup
- [Architecture](./architecture) — Monorepo structure, modules, and data flow
- [Features](./features/) — Community PR Processing, Collections, and more
- [API Reference](./api/) — REST API endpoints and usage
- [CLI Reference](./cli/) — Command-line interface usage and commands
- [AI & Generation](./ai-agents/) — AI providers, generation pipeline, and model routing
- [Database](./database) — Supported databases, entities, and configuration
- [Plugin System](./plugin-system/) — Current status and planned extensibility

## Community & Resources

- **[GitHub](https://github.com/ever-works)** — Source code and issues
- **[Discord](https://discord.gg/ever)** — Join the community
- **[FAQ](./faq)** — Frequently asked questions
- **[Support](./support)** — Get help and support
