---
id: index
title: Plugin System
sidebar_label: Overview
sidebar_position: 1
---

# Plugin System

The Ever Works Platform uses a **capability-driven plugin architecture** where all external integrations — AI providers, search engines, deployment targets, screenshot services, and more — are implemented as self-contained plugins.

Instead of hardcoding providers, the platform asks "give me a plugin that can do X" and the system resolves which plugin to use based on admin, user, and directory-level configuration.

## How It Works

1. **Plugins declare capabilities** — Each plugin implements one or more capability interfaces (e.g., `ai-provider`, `search`, `deployment`).
2. **Facades route requests** — When the platform needs to perform an AI completion or a web search, a facade service resolves the active plugin for the current scope.
3. **Settings cascade** — Plugin configuration follows a three-tier hierarchy: directory settings override user settings, which override admin defaults.
4. **Discovery is automatic** — Plugins in `packages/plugins/` are discovered at startup. No manual registration is needed.

## Built-in Plugins

The platform ships with **30 plugins** across multiple categories:

| Category | Plugins | Capability |
|----------|---------|------------|
| AI Providers | OpenAI, Anthropic, Google Gemini, Groq, Mistral, Ollama | `ai-provider` |
| AI Gateways | OpenRouter, Vercel AI Gateway | `ai-provider` |
| Search | Brave, Tavily, SerpAPI, Exa, Perplexity, Bright Data, Firecrawl, Valyu | `search` |
| Git Provider | GitHub | `git-provider` |
| Deployment | Vercel | `deployment` |
| Screenshot | ScreenshotOne, URLBox, Scrapfly | `screenshot` |
| Content Extractor | Local HTML, Notion, Jina, PDF Extractor | `content-extractor` |
| Data Source | Apify | `data-source` |
| Pipeline | Standard Pipeline, Agent Pipeline, Claude Code | `pipeline` |
| Utility | Comparison Generator | `form-schema-provider` |

See [Built-in Plugins](./built-in-plugins) for details on each plugin and its configuration.

## Plugin SDK

The Plugin SDK (`@ever-works/plugin`) is a **standalone TypeScript package** with no NestJS dependencies. It provides:

- **`IPlugin` interface** — The contract every plugin implements
- **Base classes** — `BasePlugin`, `BaseAiProvider`, `BaseGitProvider`, `BasePipelineStep`
- **15 capability interfaces** — Typed contracts for each plugin category
- **Settings types** — JSON Schema with extensions for secrets, environment variables, and scoping
- **Plugin context** — Logger, cache, HTTP client, events, and settings access

See [Architecture](./architecture) for the full technical breakdown.

## Key Concepts

### Capabilities

A capability is a specific function a plugin can perform. One plugin can provide multiple capabilities — for example, the Tavily plugin provides both `search` and `content-extractor`.

Available capabilities:

| Capability | Description |
|------------|-------------|
| `ai-provider` | Chat completions, embeddings, structured output |
| `search` | Web search queries |
| `git-provider` | Repository management, cloning, pushing |
| `deployment` | Site deployment and status |
| `screenshot` | Website screenshot capture |
| `content-extractor` | URL content extraction |
| `data-source` | External data querying |
| `oauth` | OAuth authentication flows |
| `pipeline` | Generation pipeline (Standard, Agent, or Claude Code) |
| `form-schema-provider` | Dynamic form schema generation for plugin UIs |

### Configuration Modes

Each plugin declares how it should be configured:

- **`admin-only`** — Only admins can configure (system infrastructure plugins)
- **`user-required`** — Users must provide their own credentials (e.g., API keys)
- **`hybrid`** — Admin provides defaults, users can override

### Scoped Resolution

Each directory can use a different plugin per capability. For example:
- Directory A uses **OpenAI** for AI and **Brave** for search
- Directory B uses **Anthropic** for AI and **Tavily** for search

This is managed through the [Settings System](./settings) and the directory-level plugin management UI.

## Documentation

| Page | Description |
|------|-------------|
| [Architecture](./architecture) | Plugin SDK, interfaces, lifecycle, bootstrap, facades |
| [Settings](./settings) | Three-tier settings, JSON Schema extensions, resolution |
| [Creating a Plugin](./creating-a-plugin) | Step-by-step guide for building a new plugin |
| [Built-in Plugins](./built-in-plugins) | All 30 plugins with configuration details |
| [API Reference](./api-reference) | REST endpoints for plugin management |
