---
id: index
title: Platform Features
sidebar_label: Features
sidebar_position: 1
---

# Platform Features

This section covers individual capabilities built into the Ever Works Platform beyond the core work CRUD and AI generation pipeline.

| Feature                                              | Description                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Community PR Processing](./community-pr-processing) | Automatically process community-submitted GitHub PRs to extract work items using AI                    |
| [Work Changelog](./work-changelog)                   | Track item, comparison, taxonomy, and community PR changes in a paginated work history timeline        |
| [Collections](./collections)                         | Curate items into named groups like "Editor's Picks" or "Best for Beginners"                           |
| [Item Source Validation](./item-source-validation)   | Validate whether item source URLs are both reachable and actually good sources for the item            |
| [Scheduled Updates](./scheduled-updates)             | Re-run the AI generation pipeline on a recurring cadence to keep content fresh                         |
| [Generation Cancellation](./generation-cancellation) | Cancel an in-flight generation and roll back to a clean state from the dashboard or API                |
| [works.yml Config](./works-config)                   | Source-controlled work configuration in the data repo — used for onboarding existing repos and sync    |
| [Work Import](./work-import)                         | Bootstrap a work from an existing data repo or Awesome List README                                     |
| [Work Members](./work-members)                       | Invite collaborators with role-based access (Manager, Editor, Viewer)                                  |
| [Comparisons](./comparisons)                         | Automatically generate A vs B comparison pages between work items with AI-powered research and scoring |
| [Advanced Prompts](./advanced-prompts)               | Customize AI behavior per-work with prompt overrides for each pipeline step                            |
| [API Keys](./api-keys)                               | Generate long-lived API keys for programmatic access to the Ever Works API                             |
| [Custom Domains](./custom-domains)                   | Assign your own domain name to a work's deployed website                                               |
| [MCP Server](./mcp-server)                           | Expose the Ever Works API as tools for AI assistants like Claude                                       |
| [Data Management](./data-management)                 | Export, import, and sync account data (works, items, plugins, secrets) with GitHub backup              |
