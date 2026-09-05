---
id: roadmap
title: Roadmap & Future Direction
sidebar_label: Roadmap
sidebar_position: 16
description: What has recently shipped, what is actively being worked on, how to propose a feature, and how priorities are decided.
---

# Roadmap & Future Direction

This page outlines the current direction of Ever Works, areas of active development, and how the community can participate in shaping the project's future.

## Product Vision

Ever Works aims to be the open-source, agentic runtime that **researches, ships, and maintains** content-rich websites and the businesses around them — merging the builder experience of one-shot AI site builders with an autonomous workforce that keeps working 24/7. The long-term vision encompasses:

- **AI-first content generation** that makes it possible to build and maintain large works with minimal manual effort
- **An autonomous AI workforce** — user-defined [Agents](/features/agents) (CEO, CTO, Researcher, …) that run [Missions](/features/missions), [Ideas](/features/ideas), and [Works](/features/creating-a-work) on a schedule, not just on prompt — see [Autonomous Operation](/features/autonomous-operation)
- **From idea to business** — beyond websites, planned [Store](/features/store-builder) and [Company](/features/company-builder) builders so a goal can become a registered, AI-run operation
- **Own everything** — code and content live in your own Git under AGPLv3; a planned [Desktop App](/features/desktop-app) runs the whole stack locally
- **A thriving plugin ecosystem** that allows developers to extend the Platform with custom AI providers, data sources, email providers, and integrations
- **Production-grade website templates** that are beautiful, performant, and fully customizable
- **Multi-work management** that scales from a single work to hundreds, all managed from a unified backend

## Recently shipped

Several items that earlier versions of this page listed as future work are **live in the platform today**, each with its own documentation page. They are gathered here rather than quietly deleted, so you can see what moved — and so the real limits of the newest ones sit next to the good news.

| Shipped                              | What it gives you                                                                                                                                                                                                   | Where to see it                                                                                         | Docs                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Kubernetes deployment for Works**  | Deploy a generated Work to your own cluster through the `k8s` deployment plugin — image build and push, ingress, TLS — alongside Vercel and Ever Works managed hosting.                                             | Work → **Deploy** tab (`/works/:id/deploy`), deploy-provider picker                                     | [Kubernetes Deployment](./features/k8s-deployment.md)                                                         |
| **Kubernetes for the platform**      | Self-host the whole platform on Kubernetes from the manifests in `.deploy/k8s` (dev / stage / prod, plus the MCP server).                                                                                           | `kubectl apply -f .deploy/k8s/k8s-manifest.prod.yaml`                                                   | [Kubernetes](./devops/kubernetes.md)                                                                          |
| **Dynamic plugin distribution**      | `PLUGIN_DISTRIBUTION_MODE=dynamic` keeps only the 27 core plugins in the image and installs any other plugin from the registry the first time someone enables it — no redeploy, no shared volume.                   | **Settings → Plugins**, or `ever-works plugins catalog / install / uninstall / install-status`          | [Built-in Plugins](./plugin-system/built-in-plugins.md)                                                       |
| **Role-based access on a Work**      | Owner, Manager, Editor and Viewer roles per Work, with invitations and owner transfer.                                                                                                                              | `/works/:id/settings/members`                                                                           | [Work Members](./features/work-members.md)                                                                    |
| **Real-time run monitoring**         | A Sessions list and per-run detail with live status, **steer / interrupt / resume** on a running agent, and a real terminal you can attach to while it runs or replay afterwards.                                   | **Teams → Sessions** (`/agents/sessions`), agent **Terminal** tab (`/agents/:id/terminal`)              | [Sessions & Steering](./features/sessions-and-steering.md) · [Agent Terminals](./features/agent-terminals.md) |
| **Desktop app (early access)**       | An Electron app with two modes: **local stack** (it supervises its own API and web services behind a prerequisite → runtime → env → boot wizard) and **client** (a native window onto an instance you already run). | `pnpm --filter ever-works-desktop package`, or the installers built by the `desktop-build.yml` workflow | [Desktop App](./features/desktop-app.md)                                                                      |
| **Company registration (v1)**        | The **Company** chip on **+ New** opens a register-company form (name, optional country) that creates the Organization and stores its registration metadata.                                                        | `/new` → **Company**                                                                                    | [Organizations](./features/organizations.md) · [Company Builder](./features/company-builder.md)               |
| **Platform chat and canvas**         | A chat rail on every dashboard page with roughly 400 single-entity tools, a confirm-before-destructive gate, no bulk operations, and a Canvas for charts, tables, stat tiles and boards. Also reachable from Slack. | Robot icon on the dashboard sidebar; `@works` and `/works` in Slack                                     | [Platform Chat](./features/platform-chat.md)                                                                  |
| **Eleven connectors**                | Slack, Discord, Linear, Notion, Jira, HubSpot, Pipedrive, Zoom, Google Workspace, Bluesky and Mastodon, all feeding the shared event spine.                                                                         | **Settings → Plugins → Connectors**                                                                     | [Connectors](./features/connectors.md) · [Integrations](./features/integrations.md)                           |
| **Notifications v2 and channels**    | An event-type catalog with per-event subscriptions, quiet hours, mutes and organization defaults, plus five delivery channels — Slack, Discord, Telegram, WhatsApp, Novu — with test sends and a delivery log.      | `/settings/notifications`, `/settings/integrations/channels`                                            | [Notifications](./features/notifications.md)                                                                  |
| **Organization-wide Memory**         | One searchable place across every Work's Knowledge Base plus organization documents: facets, memory files and folders, agent memory, meetings, a review queue, scheduled consolidation and health metrics.          | `/memory`                                                                                               | [Memory](./features/memory.md) · [Memory & Decisions](./features/memory-decisions.md)                         |
| **Campaigns (early access)**         | A go-to-market Work kind where one brief provisions the Work, its Goal, the go-to-market Agents, the first pipeline Tasks and the pipeline preference in a single call.                                             | `/works/new/campaign`                                                                                   | [Campaigns](./features/campaigns.md)                                                                          |
| **Fleet nodes**                      | Register your own machines as execution nodes — enrollment tokens, heartbeats, drain — and lease jobs onto them through the `job-runtime-node` runtime.                                                             | `/settings/fleet`                                                                                       | [Fleet](./features/fleet.md)                                                                                  |
| **Environments**                     | Named runtime recipes — the pip and npm packages a run starts with, plus its networking posture — published once under Settings and assigned to an Agent.                                                           | `/settings/environments`, agent **Capabilities** tab                                                    | [Environments](./features/environments.md)                                                                    |
| **Eleven AI providers and gateways** | anthropic, google, grok, groq, lm-studio, mistral, ollama, openai, openrouter, vercel-ai-gateway and vllm — local runtimes and bring-your-own-key included.                                                         | **Settings → Plugins → AI Providers**                                                                   | [Plugins](./features/plugins.md)                                                                              |

### Limits worth knowing

Shipped does not mean finished. These are the caveats behind the table above:

- **Organization-level roles are not differentiated yet.** A Work membership carries four roles, but an Organization membership carries exactly one (`member`) — the role tuple is deliberately one value wide until the product decision behind it is made. Role-based access therefore stays on the list below for the organization scope.
- **The notification event × channel grid is read-only in the dashboard.** Subscriptions, quiet hours and mutes are fully served by the API; the settings screen renders the matrix but does not write it yet.
- **The desktop app has no published installer.** The `desktop-build.yml` workflow produces installers as CI artifacts; until a public download exists, run the app from a checkout or build the package yourself.
- **Dynamic plugin mode is an operator feature.** The distributable packages are published with restricted access and the install allowlist is administered by platform admins, so dynamic mode is not self-service today. Bundled mode remains the default and is unaffected.
- **Campaigns has no end-to-end browser coverage yet**, and the `gtm-pipeline` plugin does not auto-enable — enable it before you start a campaign, and treat anything odd on that screen as worth reporting.
- **Environments has one consumer.** Only the `claude-managed-agent` runtime applies an assigned Environment today; other runtimes ignore it.
- **Store is still coming soon.** There is no `store` Work kind — the Store chip on `/new` is deliberately inert, and [Store Builder](./features/store-builder.md) describes where it is headed rather than what exists.

### How to check what is live in your own install

1. Open **Settings → Plugins** (`/settings/plugins/ai-provider`, then the other categories) and confirm which providers, connectors and channels are installed and enabled for your account.
2. Run `ever-works plugins catalog` to see what the registry offers in dynamic mode, and `ever-works plugins install-status <plugin-id>` for one plugin's state on the node that answers you.
3. Open **Teams → Sessions** (`/agents/sessions`), then run a heartbeat from an agent's **Dashboard** tab and follow it in that agent's **Terminal** tab — that exercises run monitoring end to end.
4. Open `/settings/environments` and `/settings/fleet` for the operator-side features; Fleet appears only when `FLEET_ENABLED` is on for the deployment.
5. Open any Work's **Deploy** tab (`/works/:id/deploy`). The provider selector lists the deployment plugins you have enabled — Ever Works managed hosting, Vercel, Kubernetes — and hides itself when only one is enabled and already selected.

## Areas of Active Development

### Platform

The following areas are actively being worked on in the Platform repository:

#### Autonomous Workforce (Agents, Missions, Ideas)

- [Missions](/features/missions) and [Ideas](/features/ideas) — the goal → proposal → Work hierarchy that lets the platform keep generating what to build next
- User-defined [Agents](/features/agents) — named AI employees with scopes, heartbeats, budgets, permissions, skills, and tasks
- [Agent Email & Inboxes](/features/agent-email) — inbound/outbound mailboxes per Agent and per Mission/Idea/Work, backed by pluggable email providers
- [Knowledge Base & Memory](/features/knowledge-base) — per-Work, Git-backed institutional context and long-term memory
- [Store](/features/store-builder) and [Company](/features/company-builder) builders — new Work shapes that turn a goal into a self-maintaining storefront or AI-run company. **Update:** Company registration v1 has shipped (see [Recently shipped](#recently-shipped)); what remains here is the incorporation and banking provider integrations behind it, plus the Store kind, which has no code path yet
- [Desktop App](/features/desktop-app) — the full stack running locally as a single application. **Update:** an early-access app exists with local-stack and client modes; the remaining work is a published installer
- Dynamic plugin distribution — install plugins on demand at runtime rather than bundling everything. **Update:** shipped (see [Recently shipped](#recently-shipped)); what is left is publishing the distributable packages openly and a self-service allowlist

#### Plugin System Expansion

- Adding new AI provider plugins (expanding beyond the current 11 providers)
- Improving plugin discovery and configuration through the Web Dashboard
- Developing a plugin marketplace for community-contributed plugins
- Enhancing the plugin SDK with better documentation and more extension points

#### AI Pipeline Improvements

- Improving content quality through better prompt engineering and multi-step generation
- Adding support for vision models to analyze screenshots and extract visual information
- Implementing content validation and quality scoring before publishing
- Supporting incremental pipeline runs that only process changed or new items

#### API and Dashboard

- Expanding the REST API with more granular endpoints for work management
- Adding real-time pipeline status monitoring in the Web Dashboard. **Update:** shipped for agent runs — live status on **Teams → Sessions** and in the agent **Terminal** tab (see [Recently shipped](#recently-shipped))
- Improving the dashboard UI with better data visualization and analytics
- Implementing role-based access control for multi-user environments. **Update:** shipped at the Work scope — Owner / Manager / Editor / Viewer at `/works/:id/settings/members`; the organization scope still has a single `member` role, so this item stays open there

#### Infrastructure

- Improving Docker deployment with better health checks and auto-scaling configurations
- Adding support for Kubernetes deployments. **Update:** shipped for both Works (the `k8s` deployment plugin) and the platform itself (the `.deploy/k8s` manifests) — see [Recently shipped](#recently-shipped)
- Optimizing background job processing for large-scale pipeline runs
- Improving monitoring and observability with structured logging

### Template

The following areas are actively being worked on in the Template repository:

#### Performance and Core Web Vitals

- Optimizing Largest Contentful Paint (LCP) for item listing and detail pages
- Reducing JavaScript bundle size through better code splitting and tree shaking
- Improving image optimization pipeline for work item screenshots and logos
- Implementing partial prerendering for faster initial page loads

#### Feature Enhancements

- Adding more filtering and search capabilities (faceted search, advanced filters)
- Implementing user-generated content features (reviews, ratings, comments)
- Adding more payment provider integrations and subscription management features
- Expanding the theming system with more built-in themes and easier customization

#### Developer Experience

- Improving local development setup with better documentation and error messages
- Adding more comprehensive E2E test coverage with Playwright
- Creating starter templates for common work types (SaaS, local business, resources)
- Improving TypeScript type safety across the codebase

#### Internationalization

- Adding more built-in language translations
- Improving RTL layout support for Arabic and Hebrew
- Supporting per-work language configuration
- Adding automated translation workflows

### Documentation

- Expanding API reference documentation with more examples
- Adding video tutorials for common tasks
- Creating architecture decision records (ADRs) for major design decisions
- Building interactive guides and playground environments

## How to Propose Features

The community plays a vital role in shaping Ever Works. Here is how you can propose new features or improvements:

### GitHub Issues

The primary way to propose features is through GitHub Issues:

- **Platform:** [github.com/ever-works/ever-works/issues](https://github.com/ever-works/ever-works/issues)
- **Template:** [github.com/ever-works/ever-works-website-template/issues](https://github.com/ever-works/ever-works-website-template/issues)

When creating a feature request:

1. **Check existing issues** first to avoid duplicates. If a similar request exists, add your use case as a comment.
2. **Use the feature request template** if one is provided.
3. **Describe the problem** you are trying to solve, not just the solution you want.
4. **Provide context** about your use case, work type, and scale.
5. **Include examples** of how the feature would work (mockups, API schemas, configuration examples).

### GitHub Discussions

For broader ideas that need community input before becoming formal proposals:

- **Platform:** [github.com/ever-works/ever-works/discussions](https://github.com/ever-works/ever-works/discussions)
- **Template:** [github.com/ever-works/ever-works-website-template/discussions](https://github.com/ever-works/ever-works-website-template/discussions)

Discussions are ideal for:

- Exploring alternative approaches to a problem
- Gathering community feedback on a proposed change
- Sharing use cases and workflows that could inform feature development
- Asking questions about the project direction

### Discord

Join the [Ever Works Discord](https://discord.gg/ever) for real-time conversations about features, bugs, and project direction. Discord is best for informal discussions and quick feedback.

## How Priorities Are Decided

Feature prioritization is based on several factors:

### Impact Assessment

| Factor                       | Weight | Description                                             |
| ---------------------------- | ------ | ------------------------------------------------------- |
| **User demand**              | High   | Number of requests, upvotes, and community interest     |
| **Strategic alignment**      | High   | How well the feature aligns with the product vision     |
| **Implementation effort**    | Medium | Complexity, time investment, and maintenance burden     |
| **Breaking change risk**     | Medium | Potential to disrupt existing users                     |
| **Contributor availability** | Medium | Whether maintainers or community members can take it on |

### Priority Tiers

- **P0 (Critical):** Security vulnerabilities, data loss bugs, or blocking issues that prevent basic functionality. Addressed immediately.
- **P1 (High):** Features or fixes that are actively being worked on for the next release. These align with the current development focus.
- **P2 (Medium):** Approved features or improvements that are planned but not yet scheduled. These are candidates for the next development cycle.
- **P3 (Low):** Nice-to-have improvements that are accepted but not actively planned. These are great candidates for community contributions.

### Labels

GitHub issues use labels to indicate priority and status:

| Label                | Meaning                                   |
| -------------------- | ----------------------------------------- |
| `enhancement`        | Feature request or improvement            |
| `bug`                | Something is not working correctly        |
| `good first issue`   | Suitable for new contributors             |
| `help wanted`        | Community contributions welcome           |
| `priority: critical` | Must be addressed immediately             |
| `priority: high`     | Planned for next release                  |
| `priority: medium`   | Planned for a future release              |
| `priority: low`      | Accepted, not yet scheduled               |
| `needs discussion`   | Requires more input before implementation |
| `wontfix`            | Decided against implementing              |

## Contributing to the Roadmap

The most effective ways to influence the roadmap:

1. **Submit well-written feature requests** with clear problem statements and use cases.
2. **Contribute code.** Pull requests that implement requested features are the fastest path from idea to reality. See the [Contributing Guide](/contributing) for details.
3. **Participate in discussions.** Provide feedback on proposals, share your experience, and help refine ideas.
4. **Report bugs.** Reliable bug reports help the team prioritize fixes and improve stability.
5. **Build plugins.** The plugin system is designed for extensibility. Building a new plugin is one of the highest-impact contributions you can make.

## Release Cadence

Ever Works does not follow a fixed release schedule. Instead, releases are made when a meaningful set of features and fixes are ready. In general:

- **Patch releases** (bug fixes) are published as needed, often weekly during active development.
- **Minor releases** (new features) are published roughly monthly.
- **Major releases** (breaking changes) are infrequent and accompanied by migration guides.

See the [Changelog & Versioning](/changelog) page for details on versioning strategy and upgrade paths.

## Staying Updated

To stay informed about project developments:

- **Watch the repositories** on GitHub to receive notifications about new issues, PRs, and releases.
- **Star the repositories** to show your support and help others discover the project.
- **Join the Discord** for real-time updates and community discussions.
- **Follow [@everworks](https://twitter.com/everworks)** on Twitter for announcements.
- **Check the releases page** periodically for new versions and changelogs.

## Contact

For questions about the roadmap or to discuss partnership and enterprise needs:

- **Email:** [ever@ever.co](mailto:ever@ever.co)
- **Website:** [ever.works](https://ever.works)
- **Discord:** [discord.gg/ever](https://discord.gg/ever)

## Related

- [Changelog & Versioning](./changelog.md) — what actually shipped in each release, and how versions move
- [Feature Overview](./features/index.md) — every shipped feature page in one index
- [Contributing Guide](./contributing.md) — how to turn a roadmap item into a pull request
- [Plugin System](./plugin-system/index.md) — the extension surface most roadmap items land on
- [Support & Help](/support) — where to ask when this page does not match what you see
