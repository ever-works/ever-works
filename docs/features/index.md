---
id: index
title: Platform Features
sidebar_label: Features
sidebar_position: 1
---

# Platform Features

Ever Works combines two things most tools keep separate: the **builder** that turns an idea into a shipped website, store, blog, or directory — and the **autonomous workforce** that keeps that thing researching, writing, improving, and growing 24/7. You set a goal; an AI organization runs it, with all code and content owned in your own Git.

This section covers the individual capabilities that make that possible, beyond the core work CRUD and AI generation pipeline.

> New here? Read the [Platform Overview](../overview.md) for the big picture, or the [Founder Journey guide](../guides/founder-journey.md) for the Start → Build → Sell → Scale playbook that ties these features together.

:::note Where these live in the sidebar
A few features share a sidebar entry rather than owning one. **Teams** is the hub for people _and_ Agents — tabs **Teams | Agents | Sessions | Archived**, with the **Agents Chart** button (`/agents/chart`) and the **Skills** catalog on the Agents tab. **Memory** hosts the **Meetings** catalog as a block. The retired index links still work: `/skills` redirects to `/agents#skills` and `/meetings` to `/memory#meetings`, filters and all. Detail pages (`/agents/:id`, `/teams/:id`, `/skills/:id`, `/meetings/:id`) are unchanged.
:::

## Getting started

| Feature                                      | Description                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Creating an Account](./creating-an-account) | Signing up, social sign-in, magic links, password reset — and what the terms checkbox records                             |
| [Onboarding & Setup Wizard](./onboarding)    | The guided walkthrough that picks your AI, storage, database, deployment and plugins                                      |
| [The Dashboard](./dashboard)                 | The home cockpit at `/`, the sidebar, the header, the Help drawer and the keyboard shortcuts                              |
| [The + New page](./new-page)                 | One prompt box plus chips for Missions, Ideas, Agents, Tasks, every Work kind, and Companies                              |
| [Platform Chat & Canvas](./platform-chat)    | The chat rail on every page — one tool per platform operation, confirmed before anything destructive, answers on a Canvas |
| [The Settings Map](./settings-map)           | What lives where under Settings, including Usage & Credits                                                                |

## The core loop

| Feature                                                | Description                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [Missions](./missions)                                 | Long-running goals that spawn Ideas and optionally auto-build Works on a schedule                           |
| [Ideas](./ideas)                                       | Proposed Works in the queue between "topic" and "finished website" — build, retry, dismiss, accept          |
| [Goals](./goals)                                       | A number you want to move — read from a metrics provider on a schedule and checked against a target         |
| [Creating a Work](./creating-a-work)                   | The buildable unit — websites, blogs, directories, landing pages — created with AI, manually, or by import  |
| [Tasks](./tasks)                                       | One trackable unit of work — status, priority, labels, and optionally the Agent that executes it            |
| [Agents (AI Employees)](./agents)                      | Named, persistent AI workers you create, scope, schedule, and budget — your standing team                   |
| [Agents Catalog](./agents-catalog)                     | Pre-built specialists (PM, Coder, Researcher, …) with a role prompt, default Skills and a starter KB        |
| [Agent Capabilities](./agent-capabilities)             | Per-tool grants, Skills, MCP connections, repositories, environment, init script and the Collaborators list |
| [Skills Catalog](./skills-catalog)                     | Reusable `SKILL.md` instruction blocks an Agent pulls in when they are relevant                             |
| [Teams](./teams)                                       | Nested groups of Agents and people inside an organization, plus the Works and Agents they own               |
| [Agent Scorecards](./agent-scorecards)                 | Target, current, floor and stretch per metric, so an AI worker's output is measurable                       |
| [Agent Email & Inboxes](./agent-email)                 | Inbound + outbound mailboxes per Agent / Mission / Idea / Work — your AI team's email                       |
| [Inbox](./inbox)                                       | The operator message center at `/inbox` — blocking questions, approval requests, escalations and notices    |
| [Approvals & Escalations](./approvals-and-escalations) | The three moments a human stays in the loop — action proposals, escalations, and guardrail modes            |
| [Agent Terminals](./agent-terminals)                   | Attach a real terminal to a live agent run — take the keyboard, watch read-only, replay the transcript      |
| [Knowledge Base & Memory](./knowledge-base)            | Per-Work, typed, Git-backed institutional context and long-term memory every run reads from                 |
| [Memory (Org-Wide)](./memory)                          | Every Work's KB plus org-level documents in one place — files, agent memory, review queue, consolidation    |
| [Meetings](./meetings)                                 | Meeting records with transcripts — entered by hand or synced from Zoom and Google Meet, then summarized     |
| [Notifications](./notifications)                       | The in-app bell, the Slack / Discord / Telegram / WhatsApp / Novu channels, and event subscriptions         |
| [Digests](./digests)                                   | Daily and weekly briefings composed from real runs, tasks, pull requests, escalations and goal progress     |
| [Inbound Triggers](./inbound-triggers)                 | Signed HTTPS endpoints and platform-event rules that spawn a Task — and start an Agent — from outside       |
| [Campaigns](./campaigns)                               | The `campaign` Work kind — one brief provisions the Goal, the go-to-market Agents and the first Tasks       |
| [Autonomous Operation](./autonomous-operation)         | How the platform keeps working 24/7 — the half one-shot builders don't have                                 |
| [Workers](./workers)                                   | The background-execution engine that runs Agents, pipelines, and schedules in parallel                      |

## Work types & templates

A Work's **kind** is chosen once, at creation, and decides what that Work has. The kinds you can pick are `website`, `landing-page`, `blog`, `directory` and `awesome-repo`; the platform also mints `company` and `campaign` Works through their own dedicated flows. This section covers those kinds, the templates a Work is built from, and the places Works and Agents actually run.

| Feature                                   | Description                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Work Kinds & Capabilities](./work-kinds) | What each kind has — the tabs, tiles, repositories and default website template a Work inherits from its kind                                                          |
| [Website Templates](./website-templates)  | Catalogue of base templates a Work's website is generated from (Next.js / Astro, directory / general)                                                                  |
| [Work Templates](./work-templates)        | Pre-baked starters that point at a real GitHub boilerplate repository you fork into a new Work                                                                         |
| [Work Blueprints](./work-blueprints)      | Ready-made Work definitions from the public `ever-works/works` catalog, offered in the Template picker                                                                 |
| [Mission Templates](./mission-templates)  | Pre-built Mission playbooks (cadence, guardrails, KB seed, pre-declared Agents) you fork via "Use this Template"                                                       |
| [Generated Site](./generated-site)        | The three Git repositories every Work gets, what the generated site ships with, and what you own                                                                       |
| [Store Builder](./store-builder)          | _(Coming soon)_ eCommerce storefronts an AI team researches, stocks, writes, and optimizes                                                                             |
| [Company Builder](./company-builder)      | Register and run a whole company staffed by AI Agents — registration v1 ships today with a manual provider; automated incorporation providers are still on the roadmap |
| [Organizations](./organizations)          | Your workspace is an Organization — create one, switch between them, invite people, set the Vision, import a Company                                                   |
| [Desktop App](./desktop-app)              | _(Early access)_ Run the whole stack locally, or use it as a native client — build it from source, or take the `.exe` / `.dmg` / `.AppImage` a CI run produces         |
| [Fleet](./fleet)                          | The registry of machines that are yours — enroll a node, watch it heartbeat, drain it when you want it quiet                                                           |
| [Job Runtimes](./job-runtimes)            | The swappable engines behind Workers — Trigger.dev, Temporal, BullMQ, pg-boss, Inngest, and your own Fleet nodes                                                       |
| [Environments](./environments)            | Named runtime recipes — packages plus a networking posture — published once under Settings and assigned to an Agent                                                    |
| [Secret Stores](./secret-stores)          | Resolver plugins that turn a credential pointer into a real secret, so the platform database never holds one                                                           |

## Operating a Work

| Feature                                              | Description                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Task Isolation](./task-isolation)                   | A branch and a private checkout per Task, so parallel Agents never overwrite each other                         |
| [Quality Gates](./quality-gates)                     | Acceptance checks that decide whether an Agent's work is done — red sends it back instead of to you             |
| [Merge Policy](./merge-policy)                       | Whether an Agent may land its own pull request, configurable per tenant / org / Work / Agent                    |
| [Sessions & Steering](./sessions-and-steering)       | Watch every agent run, and talk to one that is already in flight — steer, interrupt, resume                     |
| [Activity](./activity)                               | The account-wide log of generations, deployments, imports, plugin changes and sign-ins, plus the Schedules view |
| [Decisions & Review](./memory-decisions)             | First-class decision documents plus a review queue that keeps agent-authored memory out of context              |
| [Budgets & Usage](./budgets-and-usage)               | Per-Mission / per-Idea / per-Work / per-Agent / account-wide caps that gate AI spend before the bill arrives    |
| [Credits & Billing](./credits-and-billing)           | The credits ledger, the balance it sums to, and the plan / usage surfaces that read it                          |
| [Integrations](./integrations)                       | Slack, GitHub PR review, native connectors and Meetings — outside activity as one normalized event stream       |
| [Scheduled Updates](./scheduled-updates)             | Re-run the AI generation pipeline on a recurring cadence to keep content fresh                                  |
| [Generation Cancellation](./generation-cancellation) | Cancel an in-flight generation and roll back to a clean state from the dashboard or API                         |
| [Community PR Processing](./community-pr-processing) | Automatically process community-submitted GitHub PRs to extract work items using AI                             |
| [Work Changelog](./work-changelog)                   | Track item, comparison, taxonomy, and community PR changes in a paginated work history timeline                 |
| [Items](./items)                                     | The Items workbench — browse, add and edit items, the markdown body editor, source health and screenshots       |
| [Collections](./collections)                         | Curate items into named groups like "Editor's Picks" or "Best for Beginners"                                    |
| [Item Source Validation](./item-source-validation)   | Validate whether item source URLs are both reachable and actually good sources for the item                     |
| [Item Import & Export](./item-import-export)         | Export items to CSV or Excel and import them back through a mapping wizard — off by default, per Work           |
| [Comparisons](./comparisons)                         | Automatically generate A vs B comparison pages between work items with AI-powered research and scoring          |
| [Advanced Prompts](./advanced-prompts)               | Customize AI behavior per-work with prompt overrides for each pipeline step                                     |
| [Work Members](./work-members)                       | Invite collaborators with role-based access (Manager, Editor, Viewer)                                           |

## Configuration, data & access

| Feature                                   | Description                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [.works/works.yml Config](./works-config) | Source-controlled work configuration in the data repo — used for onboarding existing repos and sync    |
| [Work Import](./work-import)              | Bootstrap a work from an existing data repo or Awesome List README                                     |
| [Taxonomy System](./taxonomy-system)      | Categories, tags, and structured classification across a Work's items                                  |
| [Git Operations](./git-operations)        | How the platform reads and writes your Work's Git repositories                                         |
| [Repositories](./repositories)            | The account-level registry of Git repositories — manual entries, GitHub App imports, Work-derived rows |
| [API Keys](./api-keys)                    | Generate long-lived API keys for programmatic access to the Ever Works API                             |
| [Custom Domains](./custom-domains)        | Assign your own domain name to a work's deployed website                                               |
| [Managed Hosting](./managed-hosting)      | A `*.ever.works` address, a database per Work, managed Git storage and DNS — nothing to operate        |
| [K8s Deployment](./k8s-deployment)        | Deploy a Work to a Kubernetes cluster                                                                  |
| [MCP Server](./mcp-server)                | Expose the Ever Works API as tools for AI assistants like Claude                                       |
| [MCP Connections](./mcp-connections)      | The other direction — register external MCP servers and bind their tools to an Agent                   |
| [Plugins](./plugins)                      | Every plugin your install carries, what each socket does, and how to enable and configure one          |
| [Connectors](./connectors)                | Chat, tracker, docs, CRM, meeting and social connectors — what each one pulls in, and where it lands   |
| [Storage Backends](./storage-backends)    | Where uploaded bytes land — local disk, AWS S3, MinIO, or a GitHub repository with Git LFS             |
| [Data Management](./data-management)      | Export, import, and sync account data (works, items, plugins, secrets) with GitHub backup              |

## Guides

The pages above are reference — what each capability is and every option it takes. The guides below are the walkthroughs: start to finish, in order, with the real routes and commands.

| Guide                                                                        | What you have at the end                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [The Founder Journey](../guides/founder-journey)                             | The Start → Build → Sell → Scale playbook that ties every feature above into one path                  |
| [Platform Tour](../guides/platform-tour)                                     | A walk through every dashboard screen, its route, and the feature page that covers it in depth         |
| [Quickstart: Directory](../guides/quickstart-directory)                      | A directory Work generated, curated, compared, deployed and on a refresh schedule                      |
| [Quickstart: Blog](../guides/quickstart-blog)                                | A Blog Work with your brand voice in Memory, a refresh cadence, a domain, and its own Agent            |
| [Quickstart: Landing Page](../guides/quickstart-landing-page)                | A Landing Page Work, AI-restyled from a template and deployed to a live address                        |
| [Quickstart: Website](../guides/quickstart-website)                          | A multi-page marketing site with a seeded KB, quality gates, reviewed pull requests and a domain       |
| [Quickstart: Awesome List](../guides/quickstart-awesome-repo)                | An awesome-list repo with a generated index, structured data you own, and community PR intake          |
| [Do Everything From Chat](../guides/do-everything-from-chat)                 | Ten worked prompts that drive the platform from the chat rail, each mapped to the tool it calls        |
| [Autonomous: Build from a Template](../guides/autonomous-site-from-template) | A template, a Mission with auto-build, budgets and schedules running as one standing loop              |
| [Run Your Business 24/7](../guides/run-your-business-24-7)                   | A standing AI organization — Goals, Agents, Teams, heartbeats, the Inbox and a daily digest            |
| [Budgets & Guardrails](../guides/budgets-and-guardrails)                     | Every ceiling set — spend caps, guardrail modes, approvals, tool grants, merge policy, gates           |
| [Teams & Organizations](../guides/teams-and-organizations)                   | An Organization with people invited, nested Teams, an org chart, and per-Work roles                    |
| [Connect Integrations](../guides/connect-integrations)                       | Slack, the GitHub App, connector plugins and notification channels wired up and test-fired             |
| [Bring Your Own AI Provider](../guides/bring-your-own-ai-provider)           | Your own model API or local server wired into the simple / medium / complex tiers                      |
| [Import an Existing Repo](../guides/import-an-existing-repo)                 | A repository you already own running as a Work — syncing, generating and deploying                     |
| [Domains & Deploy Targets](../guides/custom-domains-and-deploy-targets)      | A Work published where you want it, on your own domain, with its DNS verified                          |
| [MCP Client Setup](../guides/mcp-server-setup)                               | An MCP client driving your Works, Missions, Ideas and Knowledge Base as tools                          |
| [CLI Quickstart](../guides/cli-quickstart)                                   | The CLI installed and signed in, driving Works, plugins and the Knowledge Base from a terminal         |
| [Desktop App](../guides/desktop-app)                                         | The desktop shell running the whole platform locally, or acting as a client for a remote instance      |
| [Self-host: Docker & K8s](../guides/self-host-docker-kubernetes)             | The platform running on your own infrastructure, from the Compose files to the `.deploy/k8s` manifests |

## Related

- [Platform Overview](../overview.md) — the model behind all of this: Missions → Ideas → Works, run by Agents
- [Glossary](../glossary.md) — every term used across these pages, defined once
- [API Reference](../api/index.md) — the REST surface behind every screen
- [CLI Reference](../cli/index.md) — the same operations from a terminal
- [Plugin System](../plugin-system/index.md) — how the sockets work, and how to write your own plugin
- [FAQ](/faq) — short answers to the questions that come up before the first Work
