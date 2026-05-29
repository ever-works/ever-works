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

## The core loop

| Feature                                        | Description                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Missions](./missions)                         | Long-running goals that spawn Ideas and optionally auto-build Works on a schedule                          |
| [Ideas](./ideas)                               | Proposed Works in the queue between "topic" and "finished website" — build, retry, dismiss, accept         |
| [Creating a Work](./creating-a-work)           | The buildable unit — websites, blogs, directories, landing pages — created with AI, manually, or by import |
| [Agents (AI Employees)](./agents)              | Named, persistent AI workers you create, scope, schedule, and budget — your standing team                  |
| [Agent Email & Inboxes](./agent-email)         | Inbound + outbound mailboxes per Agent / Mission / Idea / Work — your AI team's email                      |
| [Knowledge Base & Memory](./knowledge-base)    | Per-Work, typed, Git-backed institutional context and long-term memory every run reads from                |
| [Autonomous Operation](./autonomous-operation) | How the platform keeps working 24/7 — the half one-shot builders don't have                                |
| [Workers](./workers)                           | The background-execution engine that runs Agents, pipelines, and schedules in parallel                     |

## Work types & templates

| Feature                                  | Description                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Website Templates](./website-templates) | Catalogue of base templates a Work's website is generated from (Next.js / Astro, directory / general)            |
| [Mission Templates](./mission-templates) | Pre-built Mission playbooks (cadence, guardrails, KB seed, pre-declared Agents) you fork via "Use this Template" |
| [Store Builder](./store-builder)         | _(Coming soon)_ eCommerce storefronts an AI team researches, stocks, writes, and optimizes                       |
| [Company Builder](./company-builder)     | _(Coming soon)_ Register and run a whole company, staffed by AI Agents, on top of the platform                   |
| [Desktop App](./desktop-app)             | _(Coming soon)_ Run the full stack locally as a single application                                               |

## Operating a Work

| Feature                                              | Description                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Budgets & Usage](./budgets-and-usage)               | Per-Mission / per-Idea / per-Work / per-Agent / account-wide caps that gate AI spend before the bill arrives |
| [Scheduled Updates](./scheduled-updates)             | Re-run the AI generation pipeline on a recurring cadence to keep content fresh                               |
| [Generation Cancellation](./generation-cancellation) | Cancel an in-flight generation and roll back to a clean state from the dashboard or API                      |
| [Community PR Processing](./community-pr-processing) | Automatically process community-submitted GitHub PRs to extract work items using AI                          |
| [Work Changelog](./work-changelog)                   | Track item, comparison, taxonomy, and community PR changes in a paginated work history timeline              |
| [Collections](./collections)                         | Curate items into named groups like "Editor's Picks" or "Best for Beginners"                                 |
| [Item Source Validation](./item-source-validation)   | Validate whether item source URLs are both reachable and actually good sources for the item                  |
| [Comparisons](./comparisons)                         | Automatically generate A vs B comparison pages between work items with AI-powered research and scoring       |
| [Advanced Prompts](./advanced-prompts)               | Customize AI behavior per-work with prompt overrides for each pipeline step                                  |
| [Work Members](./work-members)                       | Invite collaborators with role-based access (Manager, Editor, Viewer)                                        |

## Configuration, data & access

| Feature                                   | Description                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [.works/works.yml Config](./works-config) | Source-controlled work configuration in the data repo — used for onboarding existing repos and sync |
| [Work Import](./work-import)              | Bootstrap a work from an existing data repo or Awesome List README                                  |
| [Taxonomy System](./taxonomy-system)      | Categories, tags, and structured classification across a Work's items                               |
| [Git Operations](./git-operations)        | How the platform reads and writes your Work's Git repositories                                      |
| [API Keys](./api-keys)                    | Generate long-lived API keys for programmatic access to the Ever Works API                          |
| [Custom Domains](./custom-domains)        | Assign your own domain name to a work's deployed website                                            |
| [K8s Deployment](./k8s-deployment)        | Deploy a Work to a Kubernetes cluster                                                               |
| [MCP Server](./mcp-server)                | Expose the Ever Works API as tools for AI assistants like Claude                                    |
| [Data Management](./data-management)      | Export, import, and sync account data (works, items, plugins, secrets) with GitHub backup           |
