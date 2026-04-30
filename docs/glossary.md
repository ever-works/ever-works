---
id: glossary
title: Glossary of Terms
sidebar_label: Glossary
sidebar_position: 11
---

# Glossary of Terms

This glossary defines key terms and concepts used throughout the Ever Works ecosystem. Understanding these terms will help you navigate the documentation and codebase more effectively.

## Core Domain Concepts

### Directory

A collection of organized listings (items) around a specific topic or niche. A directory is the top-level entity in Ever Works. Examples include a "SaaS Tools Directory," a "Developer Resources Directory," or a "Local Business Directory." Each directory has its own configuration, categories, tags, and items.

### Item

A single entry or listing within a directory. An item represents one entity being cataloged, such as a software tool, a business, a resource, or a service. Items have structured fields (name, description, URL, logo, etc.), belong to categories, and can be tagged.

### Category

A hierarchical classification used to organize items within a directory. Categories form a tree structure (parent/child relationships) and provide the primary navigation and filtering mechanism. For example, a SaaS directory might have categories like "Project Management," "Marketing," and "Developer Tools."

### Tag

A flat, non-hierarchical label attached to items for cross-cutting classification. Unlike categories, tags do not have parent/child relationships. They are used for secondary filtering and discovery. An item can have multiple tags such as "open-source," "freemium," or "API-available."

### Collection

A curated grouping of items, independent of categories or tags. Collections are user-defined or editorially curated sets, such as "Top 10 Picks," "New This Month," or "Staff Favorites." They provide an additional organizational layer on top of the taxonomy.

### Taxonomy

The overall classification system for a directory, encompassing categories, tags, and any other organizational structures. The taxonomy defines how items are grouped, discovered, and navigated.

### Slug

A URL-friendly, human-readable identifier derived from an entity's name. Slugs are used in URLs instead of numeric IDs. For example, an item named "Visual Studio Code" might have the slug `visual-studio-code`. Slugs are unique within their scope (e.g., item slugs are unique per directory).

## AI and Automation

### Pipeline

An automated workflow that processes directory data through a series of sequential steps. Pipelines orchestrate tasks like content generation, data enrichment, screenshot capture, and deployment. The Platform includes both a standard pipeline and an AI-powered agent pipeline.

### Agent

An AI-powered component built on LangChain that performs intelligent tasks within a pipeline. Agents can generate item descriptions, extract structured data from websites, classify items into categories, and make decisions about content quality. The Platform supports multiple LLM providers (OpenAI, Anthropic, Google, Groq, OpenRouter, Ollama).

### Plugin

A modular, self-contained package that extends the Platform's capabilities. Plugins follow a standardized interface defined by the `@ever-works/plugin` SDK and are categorized by function (AI provider, search, content extraction, screenshot, Git, infrastructure). Each plugin is an independent ESM package with its own build and test setup.

### Capability

A specific function or skill that a plugin provides. Capabilities are declared in the plugin's metadata and describe what the plugin can do. For example, an AI provider plugin might declare capabilities like `text-generation` and `structured-output`. The Platform uses capabilities to match plugins to pipeline tasks.

### Provider

An external service integration wrapped by a plugin. Providers supply specific functionality to the Platform:

- **AI Provider** — LLM services for text generation (OpenAI, Anthropic, Google, Groq, OpenRouter, Ollama)
- **Search Provider** — Web search APIs for discovering items (Exa, Tavily, SerpAPI, Brave Search)
- **Content Extraction Provider** — Services that extract structured data from web pages
- **Screenshot Provider** — Services that capture website screenshots (ScreenshotOne, Urlbox)
- **Deploy Provider** — Deployment platforms for publishing websites (Vercel)

## Content Generation

### Data Generator

A component within the agent pipeline that generates or enriches structured data for directory items. Data generators use AI to produce item descriptions, extract features, determine pricing information, and populate other structured fields from source URLs or existing content.

### Markdown Generator

A component that produces markdown-formatted content for directory items. The markdown generator creates long-form content such as detailed reviews, comparisons, or overview pages. This content is stored in the Git-based CMS and rendered by the Template.

### Website Generator

A component that triggers the build and deployment of the directory website. After content generation is complete, the website generator commits changes to the Git-based CMS repository and triggers a rebuild of the Template deployment (typically on Vercel).

## Update Mechanisms

### Community PR

A pull request submitted by a community member to add or update items in a directory's Git-based CMS repository. Community PRs go through a review process before being merged. They allow public contributions to directory content without direct database access.

### Scheduled Update

An automated process that periodically runs pipeline tasks to refresh directory data. Scheduled updates can re-check item URLs for availability, update screenshots, regenerate descriptions, and sync new items from configured data sources. These are managed via background jobs (Trigger.dev or BullMQ).

## Architecture Patterns

### Facade

A design pattern used in the Platform to provide a simplified interface to a complex subsystem. The `AiFacadeService` is the primary example: it wraps multiple AI provider plugins behind a single interface, handling provider selection, fallback logic, and configuration. Facades live in the `packages/agent/src/facades/` directory.

### Repository

A data access layer class that encapsulates database queries and mutations for a specific entity. Repositories abstract away the ORM (TypeORM in the Platform, Drizzle in the Template) and provide a clean interface for services to interact with the database. In the Template, repositories are located in `lib/repositories/`.

### Service

A business logic layer class that orchestrates operations across repositories, external APIs, and other services. Services contain the core application logic and are called by API route handlers or CLI commands. In the Template, services are located in `lib/services/`.

## Webhook

An HTTP callback triggered by an event in the system. Ever Works uses webhooks for payment provider notifications (Stripe, LemonSqueezy, Polar), Git repository events, and deployment status updates. Webhook endpoints validate incoming requests using signatures or shared secrets.

## Infrastructure

### Monorepo

A single Git repository containing multiple related projects, packages, and applications. The Ever Works Platform uses a monorepo structure to share code between the API, Web Dashboard, CLI, agent package, and plugins while maintaining independent build and test pipelines.

### Workspace

A package within a monorepo that is managed by the package manager's workspace feature. In the Platform, pnpm workspaces are configured in `pnpm-workspace.yaml` and include `apps/*`, `packages/*`, and `packages/plugins/*`. Each workspace has its own `package.json`, dependencies, and scripts.

### Turborepo

The build orchestration tool used by the Platform monorepo. Turborepo manages task execution order (respecting dependency graphs between workspaces), caching of build artifacts, and parallel execution. It is configured in `turbo.json` at the repository root.

## Database and ORM

### TypeORM

The Object-Relational Mapping library used by the Platform API. TypeORM supports multiple database engines (SQLite, PostgreSQL, MySQL) and uses decorators to define entity schemas. Migrations are generated from entity changes and applied sequentially.

### Drizzle ORM

The lightweight, TypeScript-first ORM used by the Template. Drizzle provides a SQL-like query builder with full type safety. Schema definitions are written as TypeScript code, and migrations are generated as plain SQL files via Drizzle Kit.

## Deployment

### Git-based CMS

The content management approach used by Ever Works. Directory data (items, categories, metadata) is stored as structured files (YAML, Markdown) in a Git repository. The Template clones this repository at build time and reads content from the local filesystem. Changes are made via commits and pull requests.

### Docker

The containerization platform used to deploy the Platform. The Platform provides a `compose.yaml` file for running the API, Web Dashboard, and supporting services (database, Redis) as containers. Docker deployments are typically hosted on DigitalOcean or similar cloud providers.

### Vercel

The deployment platform used for the Template. Vercel provides zero-configuration deployment for Next.js applications, including automatic preview deployments for pull requests, edge functions, and CDN distribution. The Template includes a `vercel.json` configuration file for deployment settings.
