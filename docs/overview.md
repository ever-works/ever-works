---
id: overview
title: Platform Overview
sidebar_label: Overview
sidebar_position: 2
---

# Platform Overview

The Ever Works Platform provides the backend infrastructure for building, generating, and deploying AI-powered directory websites.

## How It Works

1. **Create a Directory** — A user creates a directory project through the web dashboard or API, providing a topic and description.
2. **AI Generation Pipeline** — The platform's AI agents generate directory items by researching the web, extracting relevant listings, validating sources, and organizing content into categories.
3. **Repository Management** — Generated content is committed to GitHub repositories (a data repo and a website repo) that the user owns.
4. **Website Deployment** — The website repository is deployed to Vercel, producing a live directory website.
5. **Ongoing Updates** — Directories can be regenerated, updated on a schedule, or enriched through AI conversations.

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js, TypeScript | 20+ |
| API Framework | NestJS | 11 |
| Web Dashboard | Next.js (App Router), React, Tailwind CSS | 16 |
| Database ORM | TypeORM | 0.3.28 |
| AI / LLM | LangChain (@langchain/openai, @langchain/core) | 0.3.80 |
| Monorepo | Turborepo | 2.x |
| Package Manager | pnpm | 10.x (requires 9.9.0+) |
| Background Jobs | Trigger.dev | — |
| Monitoring | Sentry, PostHog | — |
| Git Operations | isomorphic-git, Octokit | — |
| Search | Tavily | — |

## Key Repositories

| Repository | Description |
|-----------|-------------|
| `ever-works` | Platform monorepo — API, web dashboard, CLI, AI agents, shared packages |
| `ever-works-website-template` | Next.js template used by generated directory websites |
| `ever-works-docs` | This documentation site |

## AI Providers

The platform supports 8 LLM providers, all accessed through an OpenAI-compatible interface:

- **OpenAI** — GPT-5.1, GPT-5-nano, GPT-4o-mini
- **Google** — Gemini 2.5 Flash, Gemini 2.5 Pro
- **Anthropic** — Claude Sonnet 4.5, Claude Haiku 4.5
- **Groq** — Fast inference with open models (Llama 4)
- **Mistral** — Mistral Small, Medium, Large
- **OpenRouter** — Multi-provider gateway (400+ models)
- **Ollama** — Local model inference
- **Vercel AI Gateway** — Multi-provider routing via Vercel

See [AI & Generation](/ai-agents) for details.

## Plugin System

The platform uses a **capability-driven plugin architecture**. All external integrations — AI providers, search engines, deployment, screenshots, and more — are implemented as plugins. The platform ships with **30 plugins** across multiple categories, and new plugins can be added without modifying core code. See [Plugin System](/plugin-system) for details.
