---
id: roadmap
title: Roadmap & Future Direction
sidebar_label: Roadmap
sidebar_position: 16
---

# Roadmap & Future Direction

This page outlines the current direction of Ever Works, areas of active development, and how the community can participate in shaping the project's future.

## Product Vision

Ever Works aims to be the most comprehensive open-source solution for building professional work websites. The long-term vision encompasses:

- **AI-first content generation** that makes it possible to build and maintain large works with minimal manual effort
- **A thriving plugin ecosystem** that allows developers to extend the Platform with custom AI providers, data sources, and integrations
- **Production-grade website templates** that are beautiful, performant, and fully customizable
- **Multi-work management** that scales from a single work to hundreds, all managed from a unified backend

## Areas of Active Development

### Platform

The following areas are actively being worked on in the Platform repository:

#### Plugin System Expansion

- Adding new AI provider plugins (expanding beyond the current 7 providers)
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
- Adding real-time pipeline status monitoring in the Web Dashboard
- Improving the dashboard UI with better data visualization and analytics
- Implementing role-based access control for multi-user environments

#### Infrastructure

- Improving Docker deployment with better health checks and auto-scaling configurations
- Adding support for Kubernetes deployments
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
