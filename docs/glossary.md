---
id: glossary
title: Glossary of Terms
sidebar_label: Glossary
sidebar_position: 11
---

# Glossary of Terms

This glossary defines key terms and concepts used throughout the Ever Works ecosystem. Understanding these terms will help you navigate the documentation and codebase more effectively.

## Core Domain Concepts

### Work

The thing Ever Works builds, ships and keeps maintained — one website, landing page, blog, directory, or awesome-list repository. A Work is the top-level entity in the product: it owns its configuration, its Git repositories, its Knowledge Base, its Agents, its Tasks, and its deployment. Every Work carries a **kind**, and the kind decides what the Work actually has — a directory Work has items, categories, tags and comparisons; a landing-page Work has none of those. See [Creating a Work](./features/creating-a-work.md) and [Work Kinds & Capabilities](./features/work-kinds.md).

### Work Kind

The `kind` stamped on a Work when it is created, from one shared vocabulary the API, the agent runtime and the dashboard all read (`packages/contracts/src/domain/work-kind.ts`):

| Kind           | How it is created                                      | What it is                                                                 |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `website`      | **Website** chip on `/new` or `/works/new`             | A multi-page site for a business, service, or brand.                       |
| `landing-page` | **Landing Page** chip on `/new` or `/works/new`        | A focused one-pager — waitlist, launch, lead capture.                      |
| `blog`         | **Blog** chip on `/new` or `/works/new`                | A blog; its items are called **posts**.                                    |
| `directory`    | **Directory** chip on `/new` or `/works/new`           | A curated directory site with search, filters and structured item data.    |
| `awesome-repo` | **Awesome Repo** chip on `/new` or `/works/new`        | An awesome-list repository — markdown index plus refreshable metadata.     |
| `company`      | The Register-Company flow (**Company** chip on `/new`) | An organizational shell that backs an Organization. Never the create path. |
| `campaign`     | Campaign activation (`/works/new/campaign`)            | The artifact home for a go-to-market run. Never the create path.           |
| `default`      | Any Work created without a `kind`                      | The column default — behaves **exactly like `directory`**.                 |

`landing` is accepted as an alias for `landing-page`, and any value the build does not recognize normalizes to `default`, so a newer server can ship a kind an older dashboard has never heard of without breaking it. Kind is create-only: `PUT /api/works/:id` carrying a `kind` is rejected. See [Work Kinds & Capabilities](./features/work-kinds.md).

### Work Capabilities

The per-kind registry that answers "given this Work's kind, what does it support?" — whether it has items (and whether they are labeled items, posts, or pages), taxonomy, comparisons, community pull requests, item import/export, source validation, deploy and a knowledge base, which metric tiles the Overview shows, and which of the three repositories are provisioned (`packages/contracts/src/domain/work-capabilities.ts`). Every kind-conditional decision routes through it, which is why a Landing Page Work shows no Items tab and a Company Work shows no Deploy tab. See [Work Kinds & Capabilities](./features/work-kinds.md).

### Item

A single entry or listing within a work. An item represents one entity being cataloged, such as a software tool, a business, a resource, or a service. Items have structured fields (name, description, URL, logo, etc.), belong to categories, and can be tagged.

### Category

A hierarchical classification used to organize items within a work. Categories form a tree structure (parent/child relationships) and provide the primary navigation and filtering mechanism. For example, a SaaS work might have categories like "Project Management," "Marketing," and "Developer Tools."

### Tag

A flat, non-hierarchical label attached to items for cross-cutting classification. Unlike categories, tags do not have parent/child relationships. They are used for secondary filtering and discovery. An item can have multiple tags such as "open-source," "freemium," or "API-available."

### Collection

A curated grouping of items, independent of categories or tags. Collections are user-defined or editorially curated sets, such as "Top 10 Picks," "New This Month," or "Staff Favorites." They provide an additional organizational layer on top of the taxonomy.

### Taxonomy

The overall classification system for a work, encompassing categories, tags, and any other organizational structures. The taxonomy defines how items are grouped, discovered, and navigated.

### Slug

A URL-friendly, human-readable identifier derived from an entity's name. Slugs are used in URLs instead of numeric IDs. For example, an item named "Visual Studio Code" might have the slug `visual-studio-code`. Slugs are unique within their scope (e.g., item slugs are unique per work).

## Missions, Ideas, Agents & Autonomy

### Mission

An ambitious, ongoing goal that the platform keeps pursuing for you — bigger than any single website (e.g. "run the best cats business worldwide"). A Mission generates [Ideas](/features/ideas) and, optionally, auto-builds them into Works on a schedule. See [Missions](/features/missions).

### Idea

A one-shot proposal for a single Work — one Idea becomes one Work, then is marked done. Ideas can be suggested by the platform, added by you, or spawned by a Mission. Useful as a lightweight "plan" you can research before committing to a build. See [Ideas](/features/ideas).

### Agent (AI Employee)

A named, persistent, user-defined AI worker scoped to a Tenant, Mission, Idea, or Work — for example a "CEO", "CTO", or "Researcher". Distinct from the pipeline **Agent** below: this is a standing team member with its own identity files, provider, heartbeat schedule, budget, permissions, skills, tasks, and optional mailboxes. See [Agents](/features/agents).

### Work Agent

The built-in, platform-managed engine that turns a Goal into Ideas and Ideas into Works with zero setup. It is the default zero-friction path and stands alongside user-defined Agents.

### Heartbeat

An Agent's scheduled "what should I do next?" tick. On each heartbeat the Agent chooses one action — create a task, advance one, update its own instructions, or observe. The mechanism behind 24/7 [autonomous operation](/features/autonomous-operation).

### Skill

A reusable capability that can be bound to an Agent (or inherited from its scope), delivered through a skills-provider plugin. Skills extend what an Agent can do without changing core code.

### Task

A unit of work assigned to an Agent (or human), with a lifecycle and chat. Tasks are the canonical channel for Agent-to-Agent collaboration, giving every interaction an audit trail and correct cost attribution.

### Knowledge Base (KB)

A per-Work, typed, Git-backed store of institutional context — brand voice, legal copy, SEO conventions, glossary, competitors, personas, research, and agent outputs — that every generation run reads from. The platform's built-in memory and wiki layer. See [Knowledge Base](/features/knowledge-base).

### Email Address / Inbox

A tenant-registered email address (outbound, inbound, or both) backed by an email-provider plugin, assignable to an Agent / Mission / Idea / Work. Inbound mail becomes Tasks or conversations; outbound mail is sent by Agents. See [Agent Email & Inboxes](/features/agent-email).

### Work Template / Mission Template

A **Work Template** is the codebase a Work's website is generated from (the [website templates](/features/website-templates) catalog). A **Mission Template** is a curated playbook (docs, prompts, cadence, pre-declared Agents) for an ambitious goal. See [Mission Templates](/features/mission-templates).

### Store / Company

Two [Work](/features/creating-a-work) shapes at different stages. A **Store** is a self-maintaining eCommerce storefront — still coming soon, telegraphed today by the flag-gated **Store** chip on the create surface. A **Company** is further along: `company` is a real Work kind, minted by the **Register-Company** flow, which lands a backing Company Work and creates the [Organization](./features/organizations.md) linked to it (`registrationProvider: 'manual'`, `registrationStatus: 'registered'`) — and a whole prebuilt company can be imported from the public `ever-works/orgs` catalog. What remains on the roadmap is the "company-as-a-business" layer around it: the incorporation-provider integration is deferred. See [Store Builder](/features/store-builder) and [Company Builder](/features/company-builder).

### Worker

The background-execution layer that runs Agent heartbeats, generation pipelines, scheduled updates, Knowledge Base embedding, webhook delivery and Mission ticks in parallel, with retries. Workers answer _what_ runs in the background; the **job runtime** underneath answers _where_ it executes, and it is a swappable plugin rather than a hard-coded dependency. Six runtimes ship — Trigger.dev, Temporal, BullMQ, pg-boss, Inngest, and your own [Fleet](./features/fleet.md) nodes — with one active per deployment, selected by `EVER_WORKS_JOB_RUNTIME`. See [Workers](/features/workers) and [Job Runtimes](./features/job-runtimes.md).

### Tenant / Organization

The multi-tenancy containers that own addresses, Agents, Works, and inheritable KB policy. The foundation under the [Company Builder](/features/company-builder). See [Multi-Tenancy](/advanced/multi-tenancy).

## Templates & Blueprints

### Work Blueprint

A ready-made definition of a Work, published **outside** the platform in the public [`ever-works/works`](https://github.com/ever-works/works) catalog: a pointer to a fork-ready template repository plus the defaults a Work built from it starts with (its kind, whether it is organization-owned, its preferred Git, storage and deploy providers). Blueprints appear under a **Blueprints** heading in the Template picker on the Create-Work form, filtered by the kind you picked — so the list of things you can build grows without a platform release. See [Work Blueprints](./features/work-blueprints.md).

### Custom Template

A template you own rather than one of the built-ins. Add any GitHub repository by URL from the Templates page, or **fork** a built-in into your own account so you can edit it freely; either can be set as your default, and a fork can later be re-synced against the base it came from. See [Work Templates](./features/work-templates.md) and [Website Templates](./features/website-templates.md).

## Organizations, Teams & People

### Organization

Your workspace, and the boundary everything else lives inside — Missions, Ideas, Works, Agents, Teams and Memory all belong to one. Switch between them from the workspace switcher at the top of the dashboard sidebar (the row labeled **Switch Organization**), and share one by inviting people into it. A brand-new account works without creating an Organization; the platform provisions the underlying container the moment you make your first one. See [Organizations](./features/organizations.md).

An Organization and a **Company** are not the same thing: the Organization is the container you and your teammates log into, and the Company is the `company`-kind Work that represents that organization as something Agents can be pointed at. Registering a Company creates both and links them.

### Team

A named group of Agents and people inside one Organization, plus the Works and Agents that group is responsible for. Teams nest, so you can model Engineering with Frontend and Backend beneath it and see the shape drawn out on the Org Chart at `/teams/org-chart`. Teams are organizational, not permissions — putting an Agent on a Team labels it; it grants and restricts nothing. Teams exist only inside an Organization. See [Teams](./features/teams.md).

## Goals, Metrics & Campaigns

### Goal

A number you want to move, checked on a schedule. A Goal names a metrics provider plugin and a metric id, a direction (_at least_ or _at most_), a target value, a unit, a window and a check frequency, then evaluates itself and records a sample every time. It moves through **draft → active → paused → completed** and builds nothing by itself: where a [Mission](/features/missions) keeps producing work on a theme, a Goal watches one number and tells you which way it is heading. Live at `/goals`. See [Goals](./features/goals.md).

### Metric / Metrics Provider

The source a Goal reads its number from — a plugin in the `metrics` category, addressed as the pair (provider plugin id, metric id) plus optional JSON parameters. Four ship: `stripe-metrics`, `google-analytics-metrics`, `posthog-metrics` and `custom-http-metrics`. The provider must be installed and enabled for your account before a Goal can read anything, and the check frequency is clamped server-side to a 15-minute minimum. See [Goals](./features/goals.md).

### Campaign

A Work of kind `campaign` — the artifact home for a go-to-market run: the lead list, the drafts waiting at the review gate, the prepared actions and the period report. It produces no site (no website repository, no deploy provider, no Deploy tab); what it has is a [Goal](#goal), a board of pipeline Tasks, Work-scoped Agents, and a Knowledge Base holding the brief and the approved messaging. One brief on `/works/new/campaign` provisions all of it, or none of it. The go-to-market pipeline plugin does not auto-enable — you turn it on first. See [Campaigns](./features/campaigns.md).

## Agent Runs & Governance

### Session (Agent Run)

One execution of an Agent — started by a heartbeat, a Task, chat, or an inbound event. Every run is recorded with its status, timing, steps and cost; `GET /api/agents/runs` returns yours across every Agent and every Work, newest first. Browse them under **Teams → Sessions** (`/agents/sessions`) and open one at `/agents/sessions/:runId`. See [Sessions & Steering](./features/sessions-and-steering.md).

### Steering

Talking to a run that is already in flight instead of waiting for it to finish and starting another: **steer** injects a new instruction, **interrupt** stops the run now, and **resume** continues a parked or interrupted one. Available from the session detail page and from Task detail. See [Sessions & Steering](./features/sessions-and-steering.md).

### Environment

A named, reusable runtime recipe published under **Settings → Environments** (`/settings/environments`) and assigned to an [Agent](/features/agents): the Python and Node packages a run starts with, and how much of the internet that run may reach. Every run of that Agent then begins from the same toolchain and the same egress rules. Today it is enforced at run time by managed-agent runs (the `claude-managed-agent` pipeline plugin, which turns it into sandbox networking policy and a package-install bootstrap); other pipeline plugins receive the resolved Environment as advisory metadata. See [Environments](./features/environments.md).

### Tool Grant

A per-tool allow or deny rule for an Agent, edited on the **Capabilities** tab (`/agents/:id/capabilities`). Grants resolve down a four-scope lattice over a platform default — tenant → organization → Work → Agent — and every step may only **narrow** what the step above it granted: an `allow` list is intersected with what the ancestors granted (a pattern they never granted is rejected, not applied), a `deny` is additive and permanent, deny wins whenever both match, and omitting a field means inherit rather than false. That one rule is what makes the matrix a security boundary instead of a preference. See [Agent Capabilities](./features/agent-capabilities.md).

### Quality Gate

The set of commands that decide whether an Agent's work on a [Task](#task) is actually done. Each check declares an `id`, a name, a `kind` (`build` · `test` · `lint` · `typecheck` · `custom`), a `command`, and whether it is `required`; exit code `0` is green and anything else is red, and red work goes back to the Agent instead of to you. Checks run with a scrubbed environment — a variable is visible only if its **name** is listed in `envPassthrough`, and platform-owned credentials are never granted even if you list them. See [Quality Gates](./features/quality-gates.md).

### Merge Policy

Whether an Agent may **land** its own pull request, and under what conditions: `allowAgentMerge`, `requireGreenGate`, `requireHumanApproval`, `allowedMergeMethods` and `protectedBranches`. It resolves field by field down platform default → tenant → organization → Work → Agent. The platform default is conservative — Agents open pull requests, humans merge them. Note the split: _opening_ a pull request is an Agent permission (`canOpenPullRequests`); _merging_ one is this policy. See [Merge Policy](./features/merge-policy.md).

### Approval (Action Proposal)

A side-effectful action an Agent wants to take, held for a human decision. Which proposals ever reach you is set by the Agent's **guardrail mode** — `require_approval` or `autonomous`, with auto-approved and blocked action types — and a risk scorer ranks the ones that do. Proposals surface in the approval queue on the dashboard home and in the [Inbox](#inbox). See [Approvals & Escalations](./features/approvals-and-escalations.md).

### Escalation

What the platform files when a run **gave up** — the quality gate stayed red, a policy refused the action, a budget stopped it. Escalations carry a confidence score, always reach you (guardrails never suppress them), and appear in the Inbox, on the Task detail page, and at `GET /api/escalations`. Distinct from a **question**, where the Agent explicitly asked you something and parked its run until you answer. See [Approvals & Escalations](./features/approvals-and-escalations.md).

### Scorecard

The quantified goals attached to one Agent — "5 pull requests merged a week", "12 posts published a month", "keep the backlog under 20". Each metric carries a target, a current value, and optional floor and stretch bounds, and the platform colors it _Exceeded_, _On track_, _Behind_ or _Critical_ from those numbers alone. In this increment `current` never updates itself: you (or a script calling the API) set it, and there is no organization-wide roll-up yet. See [Agent Scorecards](./features/agent-scorecards.md).

### Fleet / Node

**Fleet** is the registry of machines that belong to you; a **node** is one of them. Enrolled nodes are the [Desktop App](./features/desktop-app.md) (`desktop-node`) and the headless node app (`node`), each enrolled with a one-time token minted at **Settings → Fleet → Add node**. Enrollment is outbound-only — the node calls the platform, never the other way round, so nothing has to be reachable from the internet. Nodes of a Kubernetes cluster you configured are merged into the same list live and never stored. An enrolled node goes **offline** after five minutes without a heartbeat. See [Fleet](./features/fleet.md).

## Knowledge, Memory & Decisions

### Memory (organization-wide)

The layer above the per-Work Knowledge Bases. `/memory` fans in every KB document across every Work in the active Organization, adds the documents published at organization level, and makes the whole thing searchable and faceted in one list. It also holds what a single Work's KB has no place for — uploaded files and folders, what Agents remember from their own runs, ingested meetings, a review queue for agent-written material, and a consolidation pass that retires superseded knowledge. Memory aggregates the same rows; it keeps no second copy of your knowledge. See [Memory](./features/memory.md).

### Decision

A Knowledge Base document of `class: decision` recording a choice — what was decided, why, and whether it still holds — with its own lifecycle separate from the document's publish status. Decisions, together with the **review state** that keeps agent-authored material out of Agent context until a human has looked at it, are what keep the KB trustworthy once Agents start writing to it themselves. See [Decisions & Review](./features/memory-decisions.md).

### Meeting

The record of a call: title, start and end, who was there, a link back to the recording, and the transcript. Attach a transcript and the platform writes an AI summary, saves the meeting to [Memory](#memory-organization-wide) so Agents recall it later, and posts an entry to the [Activity](./features/activity.md) feed. Zoom cloud recordings and Google Meet transcripts arrive on their own once their connector is enabled; anything else you paste in by hand. The catalog lives on the Memory page (`/memory#meetings`). See [Meetings](./features/meetings.md).

## Communications & Triggers

### Inbox

The operator message center at `/inbox` — one list of everything addressed **to you** by your Agents, your Works and the platform: blocking **questions** (an Agent called `ask_human` and parked its run), pending **approvals**, **escalations**, and **notices**. It carries an unread count, an archive, and a reply box that routes your answer straight back to the run waiting for it. It is not the notification bell (which tells you a thing happened and links here), and not per-Agent email at `/agents/:id/inbox`. See [Inbox](./features/inbox.md).

### Notification Channel

A configured destination platform events are pushed out to, on top of the in-app bell that always records everything first. Five channel plugins ship — Slack, Discord, Telegram, WhatsApp and Novu — added, test-sent and removed from **Settings → Channels** (`/settings/integrations/channels`). Which event reaches which channel is decided by **event subscriptions**; that API is shipped, and the Settings grid renders the matrix read-only in this version. See [Notifications](./features/notifications.md).

### Digest

A scheduled briefing of what happened while you were not watching — agent runs that completed or failed, tasks that moved, pull requests opened, events from connected sources, escalations still waiting on you, and where your Goals stand — covering the last 24 hours (daily) or 7 days (weekly). Digests come in two independent scopes, personal and organization, are counted from real rows rather than estimated, and are **off by default**. Turn one on at **Settings → Digest** (`/settings/digest`). See [Digests](./features/digests.md).

### Connector

A plugin that plugs an outside system into Ever Works. It declares up to two independent legs: the **`connector`** capability is the messaging leg (`direction: outbound | inbound | bidirectional`), and the **`event-source`** capability is the ingest leg that sweeps new activity into the event spine on a cron. Eleven ship — Slack, Discord, Linear, Notion, Jira, HubSpot, Pipedrive, Zoom, Google Workspace, Bluesky and Mastodon. See [Connectors](./features/connectors.md).

### Inbound Trigger

A standing rule that turns something happening outside the platform into work inside it. Each trigger owns an HTTPS endpoint and a signing secret; every verified call — signed HMAC-SHA256 — creates a [Task](#task) from the trigger's own template, assigns it to the Agent you nominated, and starts the run unless you asked it to wait. A deploy finishes → a Task. A monitor trips at 3 a.m. → a Task, already assigned, already running. Managed under **Tasks → Triggers** (`/tasks/triggers`). See [Inbound Triggers](./features/inbound-triggers.md).

## Spend: Budgets & Credits

### Budget

A spend cap enforced **before** an AI call runs, not after the bill arrives. Budgets exist per Work, per Mission, per Idea and account-wide, plus one per Agent over an hourly, daily, weekly, monthly or unlimited interval. Hit a cap and the next call is blocked (or alerted, depending on configuration); an Agent that keeps hitting it logs `AGENT_BUDGET_EXCEEDED` and auto-pauses after repeated failures, so a misbehaving worker cannot run away with your spend. See [Budgets & Usage](/features/budgets-and-usage).

### Credit

The platform's unit of consumption. Agent runs, pipelines and AI calls debit credits; the daily allowance, the monthly plan allowance and purchases add them. There is no separate balance column — your balance is the **sum of your ledger movements**, so the number and its explanation can never disagree. Credits complement budgets rather than replace them: a budget caps spend at a scope before a call runs, a credit balance is what the account meters against. Read it on **Billing** and **Usage & Credits**. See [Credits & Billing](./features/credits-and-billing.md).

## Working Surfaces

### Platform Chat / Canvas

Every dashboard page carries a **chat rail** — an assistant that can do what the buttons on that page do, calling the same platform API the dashboard uses, as you, one entity at a time, and asking before anything irreversible. Answers better seen than read open in the **Canvas**, a slide-over panel that renders `chart`, `table`, `stat`, `detail`, `kanban` and bespoke `component` artifacts — including the typed `hitl_question` / `hitl_answer` human-in-the-loop payloads — instead of a wall of markdown. Artifacts are saved with the conversation, so reopening a thread from History brings its charts back. See [Platform Chat & Canvas](./features/platform-chat.md).

## AI and Automation

### Pipeline

An automated workflow that processes work data through a series of sequential steps. Pipelines orchestrate tasks like content generation, data enrichment, screenshot capture, and deployment. The Platform includes both a standard pipeline and an AI-powered agent pipeline.

### Agent

An AI-powered component that performs intelligent tasks within a pipeline — generating item descriptions, extracting structured data from websites, classifying items into categories, and judging content quality. (Distinct from the named, persistent [Agent (AI Employee)](#agent-ai-employee) above.) Two runtimes are in play: AI-provider plugins run their chat and embedding calls through `AiOperations` in `@ever-works/plugin`, a LangChain-based wrapper shared by every provider, while the `agent-pipeline` plugin is built on the AI SDK (`ai` v6). Eleven AI-provider plugins ship — `openai`, `anthropic`, `google`, `grok`, `groq`, `mistral`, `ollama`, `lm-studio`, `vllm`, and the two gateways `openrouter` and `vercel-ai-gateway` — and you can bring your own key for any of them.

### Plugin

A modular, self-contained package that extends the Platform's capabilities. Plugins follow a standardized interface defined by the `@ever-works/plugin` SDK and are categorized by function. 102 plugins ship in the monorepo across 19 categories in use — AI provider (gateways included), pipeline, search, content extractor, screenshot, Git provider, deployment, DNS, storage, database, vector store, data source, job runtime, secret-store resolver, email provider, notification channel, connector, metrics, and utility. Each plugin is an independent ESM package with its own build and test setup. See [Plugins](./features/plugins.md).

### Capability

A specific function or skill that a plugin provides. Capabilities are declared in the plugin's metadata and describe what the plugin can do. For example, an AI provider plugin might declare capabilities like `text-generation` and `structured-output`. The Platform uses capabilities to match plugins to pipeline tasks.

### Provider

An external service integration wrapped by a plugin. Providers supply specific functionality to the Platform:

- **AI Provider** — LLM services for text generation. Eleven plugins: OpenAI, Anthropic, Google (Gemini), Grok (xAI), Groq, Mistral, Ollama, LM Studio, vLLM, plus the OpenRouter and Vercel AI Gateway gateways
- **Search Provider** — Web search APIs for research and item discovery. Nine plugins: Tavily (default), Brave, Exa, SerpAPI, Perplexity, Firecrawl, Linkup, Valyu, Bright Data
- **Content Extraction Provider** — Services that extract structured data from web pages and documents: the built-in local extractor plus Jina, Scrapfly, the Notion extractor, the PDF extractor (OCR fallback) and the Office extractor (`.docx` / `.xlsx` / `.pptx`)
- **Screenshot Provider** — Services that capture website screenshots (ScreenshotOne, Urlbox)
- **Deploy Provider** — Where a Work's site is published. Three targets: **Vercel** (the default), **Kubernetes** (the `k8s` plugin, against a cluster you control), and **Ever Works** managed hosting (`ever-works`), which publishes to a `*.ever.works` subdomain with DNS and database provisioned for you. See [Kubernetes Deployment](./features/k8s-deployment.md) and [Managed Hosting](./features/managed-hosting.md)
- **Git Provider** — Where a Work's repositories live (GitHub, with OAuth and a GitHub App)
- **Job Runtime** — Where background work executes: Trigger.dev, Temporal, BullMQ, pg-boss, Inngest, or your own Fleet nodes. See [Job Runtimes](./features/job-runtimes.md)
- **Metrics Provider** — The numbers a [Goal](#goal) reads: Stripe, Google Analytics, PostHog, or any HTTP endpoint you point it at
- **Email Provider, Notification Channel, Connector** — Outbound and inbound messaging: five email providers, five notification channels, and eleven [connectors](./features/connectors.md)
- **Storage, Database, Vector Store, DNS, Secret Store** — The infrastructure a deployed Work and the platform's own knowledge layer sit on: local filesystem / S3 / MinIO / GitHub blob storage, per-Work PostgreSQL, pgvector or Qdrant, Cloudflare DNS, and seven secret-store resolvers

## Content Generation

### Data Generator

A component within the agent pipeline that generates or enriches structured data for work items. Data generators use AI to produce item descriptions, extract features, determine pricing information, and populate other structured fields from source URLs or existing content.

### Markdown Generator

A component that produces markdown-formatted content for work items. The markdown generator creates long-form content such as detailed reviews, comparisons, or overview pages. This content is stored in the Git-based CMS and rendered by the Template.

### Website Generator

A component that triggers the build and deployment of the work website. After content generation is complete, the website generator commits changes to the Git-based CMS repository and triggers a rebuild of the Template deployment (typically on Vercel).

## Update Mechanisms

### Community PR

A pull request submitted by a community member to add or update items in a work's Git-based CMS repository. Community PRs go through a review process before being merged. They allow public contributions to work content without direct database access.

### Scheduled Update

An automated process that periodically runs pipeline tasks to refresh work data. Scheduled updates can re-check item URLs for availability, update screenshots, regenerate descriptions, and sync new items from configured data sources. These are managed via background jobs (Trigger.dev or BullMQ).

## Architecture Patterns

### Facade

A design pattern used in the Platform to provide a simplified interface to a complex subsystem. The `AiFacadeService` is the primary example: it wraps multiple AI provider plugins behind a single interface, handling provider selection, fallback logic, and configuration. Facades live in the `packages/agent/src/facades/` work.

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

The content management approach used by Ever Works. Work data (items, categories, metadata) is stored as structured files (YAML, Markdown) in a Git repository. The Template clones this repository at build time and reads content from the local filesystem. Changes are made via commits and pull requests.

### Docker

The containerization platform used to run the Platform itself. The repository ships five Compose files — `docker-compose.yml` for the stack, plus `.infra`, `.build`, `.demo` and `.trigger` variants — running the API, Web Dashboard, MCP server and supporting services (PostgreSQL, Redis) as containers, with images published to GHCR. Compose is the fastest way to self-host on a single machine; for anything beyond one box, see Kubernetes below. Start at [Docker Compose](./devops/docker-compose.md).

### Kubernetes

The documented production path for self-hosting the Platform. Environment-specific manifests live under `.deploy/k8s` (`k8s-manifest.dev.yaml`, `.stage.yaml`, `.prod.yaml`, plus the MCP-server manifests), and there is no Helm chart today. Kubernetes is also one of the three [deploy providers](#provider) for a Work's own site — the `k8s` plugin builds an image, pushes it to your registry, and applies a `Deployment`, `Service` and optional `Ingress` to a cluster you control. See [Kubernetes](./devops/kubernetes.md) for the platform and [Kubernetes Deployment](./features/k8s-deployment.md) for Works. A [DigitalOcean walkthrough](./devops/digital-ocean.md) covers one hosted variant.

### Vercel

The default deploy provider for a generated Work site, and the platform used for the Template. Vercel provides zero-configuration deployment for Next.js applications, including automatic preview deployments for pull requests, edge functions, and CDN distribution. The Template includes a `vercel.json` configuration file for deployment settings. Vercel is one of three targets — the others are Kubernetes and Ever Works [managed hosting](./features/managed-hosting.md).

## Related

- [Platform Overview](./overview.md) · [Getting Started](./getting-started.md) · [FAQ](/faq)
- [Features index](./features/index.md) — every user-facing feature page
- [Work Kinds & Capabilities](./features/work-kinds.md) · [Creating a Work](./features/creating-a-work.md)
- [Agents](./features/agents.md) · [Tasks](./features/tasks.md) · [Missions](./features/missions.md) · [Goals](./features/goals.md)
- [Plugin System](./plugin-system/index.md) · [Architecture](./architecture.md)
