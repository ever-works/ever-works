# Ever Works Platform

[uri_everworks]: https://ever.works
[uri_docs]: https://docs.ever.works
[uri_license]: https://www.gnu.org/licenses/agpl-3.0.html
[uri_license_image]: https://img.shields.io/badge/License-AGPL%20v3-blue.svg

**The Workshop for AI.** An open agentic runtime that autonomously researches, ships, and maintains content-rich websites and Git repositories.

![visitors](https://visitor-badge.laobi.icu/badge?page_id=ever-co.ever-works-platform)
[![License: AGPL v3][uri_license_image]][uri_license]
[![Status](https://img.shields.io/badge/Status-Pre--release-yellow.svg)](https://github.com/ever-works/ever-works/releases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ever-works/ever-works)
[![Gitpod Ready-to-Code](https://img.shields.io/badge/Gitpod-Ready--to--Code-blue?logo=gitpod)](https://gitpod.io/#https://github.com/ever-works/ever-works)

---

## 🌟 What is it

[Ever® Works™][uri_everworks] is an open-source, extensible, **agentic runtime** that autonomously researches, ships, and maintains content-rich websites and Git repositories.

Give it an idea, and AI agents handle the rest:

- 🔬 **Autonomous research** — agents investigate the topic before building anything
- ✍️ **AI content generation** — long-form, structured, ready-to-publish content
- 💻 **Code generation** — full sites and repositories, not just snippets
- 🚀 **Multi-target deployment** — ship the result to your hosting of choice
- 🗂️ **Git-native lifecycle** — code _and_ content both live in Git, so you own everything and nothing is locked in
- ⏰ **Continuous improvement** — keeps working on a schedule, not just when you prompt it

Think of it as a **workshop for AI**: it runs on your machine, your cloud, or ours, and keeps the whole content-and-code lifecycle version-controlled from the first idea to every future update.

Ever® Works™ is a part of our larger Open Platform for **Collaborative, On-Demand and Sharing Economies** — [Ever® Platform™](https://ever.co).

## ✨ Features

Main capabilities:

- **Idea-to-site automation** — turn a single prompt into a researched, written, coded, and deployed result
- **Autonomous AI agents** with a configurable, multi-step generation **pipeline**
- **Content management** — items, categories, tags, and collections
- **Code + content in Git** — every change is a commit, fully version-controlled and portable
- **Multi-provider AI** — bring your own models and keys (OpenAI, Anthropic, Google, Groq, Mistral, Ollama, and more) via gateways like OpenRouter
- **Extensible plugin system** — AI providers, search, content extraction, screenshots, Git providers, deployment, and pipelines (see [Plugins & Extensibility](#-plugins--extensibility))
- **Scheduled updates** — keep generated sites fresh and improving over time
- **Data import** — bring in existing content from external sources
- **Community PR workflow** — contribute generated changes back through Git pull requests
- **Comparison generator** — produce structured comparison content
- **Headless REST API** — automate everything programmatically
- **AI chat / conversations** — interact with your works through natural language
- **CLI** — drive generation and operations from the terminal
- **MCP server** — expose the platform to AI agents and IDEs via the [Model Context Protocol](https://modelcontextprotocol.io)
- **Auth** — email/password plus OAuth (GitHub, Google)
- **Subscriptions & billing**, notifications, email, activity logs, and integrations
- **Monitoring** — built-in Sentry + PostHog instrumentation
- **Multi-app, multi-surface** — Web UI, API, CLI, Admin, MCP, and Docs in a single monorepo

Read more in the [official documentation][uri_docs].

## 🧩 Plugins & Extensibility

Ever Works ships with a first-class plugin system. Plugins are standalone ESM packages that declare their metadata, capabilities, and settings — so you can mix, match, and extend providers without forking the core.

| Category               | Plugins                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **AI providers**       | OpenAI, Anthropic, Google, Groq, Mistral, Ollama                                                                               |
| **AI gateways**        | OpenRouter _(default)_, Vercel AI Gateway                                                                                      |
| **Search**             | Tavily _(default)_, Brave, Exa, SerpAPI, Perplexity, Bright Data, Firecrawl, Jina, Valyu, Linkup                               |
| **Content extractors** | Local extractor _(default)_, Notion, PDF, Scrapfly                                                                             |
| **Screenshots**        | ScreenshotOne, Urlbox, Scrapfly                                                                                                |
| **Git providers**      | GitHub _(default, with OAuth)_                                                                                                 |
| **Deployment**         | Vercel _(default)_                                                                                                             |
| **Data sources**       | Apify                                                                                                                          |
| **Pipelines**          | Standard 15-step _(default)_, Agent pipeline, Claude Code, Claude Managed Agent, Codex, Gemini, OpenCode, Make, Sim AI, Zapier |
| **Prompt providers**   | Langfuse                                                                                                                       |
| **Utilities**          | Comparison generator                                                                                                           |

See the [plugin documentation][uri_docs] for how to build and publish your own.

## 🌼 Screenshots

<details>
<summary>Show / Hide Screenshots</summary>

### Web UI

![overview](https://docs.ever.works/overview.png)

</details>

## 🔗 Links

- **<https://ever.works>** — check more information about the platform at the official website.
- **<https://app.ever.works>** — SaaS (Important: it's currently in pre-release/testing mode, please use it cautiously).
- **<https://demo.ever.works>** — Online Demo (see more info below).
- **<https://docs.ever.works>** — Platform Documentation.
- **<https://api.ever.works>** — Headless API.
- **<https://ever.co>** — get more information about our company products.

## 📊 Activity

<!-- TODO: replace the placeholder IDs below with the real ones once the repo is registered:
     - Trendshift: submit the repo at https://trendshift.io to get the numeric repository ID
     - Repobeats: generate an embed at https://repobeats.axiom.co to get the SVG hash -->

<a href="https://trendshift.io/repositories/00000" target="_blank"><img src="https://trendshift.io/api/badge/repositories/00000" alt="ever-works%2Fever-works | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

![Alt](https://repobeats.axiom.co/api/embed/0000000000000000000000000000000000000000.svg 'Repobeats analytics image')

## 💻 Demo, Testing and Production

### Demo

Ever Works Platform Demo is available at <https://demo.ever.works>.

Notes:

- Content of the demo environment may reset on each deployment (usually daily).
- The demo environment is deployed using CI/CD from the `develop` branch.

### Production (SaaS)

Ever® Works™ Platform SaaS is available at <https://app.ever.works>.

Note: it's currently in pre-release/testing mode, please use it cautiously!

### Staging

- Staging builds (using CI/CD, from the `stage` branch) are used to test releases before they are deployed to production.

## 🧱 Technology Stack and Requirements

- [TypeScript](https://www.typescriptlang.org)
- [Node.js](https://nodejs.org) (>= 22) / [NestJS](https://nestjs.com) — REST API
- [Next.js](https://nextjs.org) (App Router) / [React](https://react.dev) / [Tailwind CSS](https://tailwindcss.com) — Web UI
- [Turborepo](https://turbo.build/repo) / [pnpm](https://pnpm.io) workspaces — monorepo orchestration
- [TypeORM](https://typeorm.io) — database & migrations
- [LangChain](https://www.langchain.com) — unified AI provider integration
- [BullMQ](https://bullmq.io) / [Trigger.dev](https://trigger.dev) — background jobs & scheduling
- [Docusaurus](https://docusaurus.io) — documentation site

For Production, we recommend:

- [PostgreSQL](https://www.postgresql.org)
- [Redis](https://redis.io)
- [Kubernetes](https://kubernetes.io), [Docker](https://www.docker.com)

#### See also the README.md and LICENSES.md files in relevant folders for lists of libraries and software included in the Platform, information about licenses, and other details

## 🧰 Apps & Packages

Ever Works is a [Turborepo](https://turbo.build/repo) + [pnpm](https://pnpm.io) monorepo.

**Apps** (`apps/*`):

- `api` — NestJS REST API (port `3100`)
- `web` — Next.js App Router web UI (port `3000`)
- `cli` — public CLI
- `internal-cli` — internal NestJS CLI tooling
- `admin` — admin interface
- `mcp` — Model Context Protocol server (port `3200`)
- `docs` — documentation site (renders `docs/`)

**Packages** (`packages/*`):

- `agent` — core AI agent logic (generators, pipeline, work operations, facades, …)
- `plugin` — plugin system contracts & utilities
- `plugins/*` — provider implementations (AI, search, deployment, …)
- `contracts` — shared TypeScript types
- `tasks` — Trigger.dev background jobs
- `monitoring` — Sentry + PostHog integration
- `cli-shared` — shared CLI utilities

## 📄 Documentation

Please refer to our official [Platform Documentation][uri_docs].

## 🚀 Quick Start

### With Docker Compose

- Clone the repo.
- Make sure you have a recent [Docker Compose installed locally](https://docs.docker.com/compose/install) (minimum [v2.20](https://docs.docker.com/compose/release-notes/#2200)).

#### Demo

- Run `docker compose -f docker-compose.demo.yml up`, if you want to run the platform in a basic configuration (e.g. for demo / exploring functionality / a quick run) using our prebuilt Docker images from [GitHub Container Registry](https://github.com/orgs/ever-works/packages). Check the `.env.demo.compose` file for optional settings.
- Open <http://localhost:3000> in your browser (the API runs on <http://localhost:3100>, the MCP server on <http://localhost:3200>).
- Enjoy!

#### Production

- Edit `.env.compose` (if needed) to use your custom settings.
- Run `docker compose up -d`, if you want to run the platform in a minimal production configuration using our prebuilt Docker images.

Note: we recommend using Kubernetes for production workloads instead of Docker Compose!

#### Build

- Run `docker compose -f docker-compose.build.yml up -d`, if you want to build everything (code and Docker images) locally. _(Note: this builds the whole platform locally and can take a while — the options above are much faster.)_

Notes:

- You can run **only** the infra dependencies (PostgreSQL + Redis, without our API / Web containers) with `docker compose -f docker-compose.infra.yml up -d`. This is handy when running the apps locally while keeping the backing services in containers.
- You can add `--env-file .env.something` to the `docker compose` command to use a specific env file with your custom settings.

### Manually

#### Required

- Install [Node.js](https://nodejs.org/en/download) LTS (>= 22).
- Install [pnpm](https://pnpm.io/installation) (>= 9.9).
- Install dependencies with `pnpm install`.
- If you will make code changes (and push to the Git repo), run `pnpm prepare:husky`.
- Copy the example env files and adjust settings:
    - `apps/api/.env.example` → `apps/api/.env`
    - `apps/web/.env.example` → `apps/web/.env.local`
- Build workspace packages first (Turborepo handles dependency order): `pnpm build`.
- Run the apps:
    - `pnpm dev:apps` — run all apps in watch mode
    - `pnpm dev:api` — API only (port `3100`)
    - `pnpm dev:web` — Web only (port `3000`)
- Open <http://localhost:3000> in your browser.
- Enjoy!

Notes:

- The API self-applies pending database migrations on startup, so there is nothing to run manually on a fresh setup.
- For Redis and PostgreSQL during local development, you can use `docker compose -f docker-compose.infra.yml up -d`.

### Production

#### Kubernetes

- We recommend deploying to Kubernetes (k8s) for production workloads. See the `.deploy/` folder for our deployment configurations.

## 💌 Contact Us

- [Ever.co Website Contact Us page](https://ever.co/contacts)
- [Discord Chat](https://discord.gg/X2gUeNrrWH)
- For business inquiries: <mailto:ever@ever.co>
- Please report security vulnerabilities to <mailto:security@ever.co>

## 🔐 Security

Ever® Works™ follows good security practices, but 100% security cannot be guaranteed in any software!
Ever® Works™ is provided AS IS without any warranty. Use at your own risk!
See more details in the [LICENSE](LICENSE).

In a production setup, all client-side to server-side (backend, APIs) communications should be encrypted using HTTPS/WSS/SSL.

If you discover any issue regarding security, please disclose the information responsibly by sending an email to <mailto:security@ever.co> and not by creating a GitHub issue.

## 🛡️ License

We support the open-source community. If you're building awesome non-profit/open-source projects, we're happy to help — feel free to contact us at <mailto:ever@ever.co> to make a request.

This software is available under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0).

#### Please see [LICENSE](LICENSE) and [LICENSES.md](LICENSES.md) for more information on licenses

## ™️ Trademarks

**Ever**® is a registered trademark of [Ever Co. LTD](https://ever.co).
**Ever® Demand™**, **Ever® Gauzy™**, **Ever® Teams™**, **Ever® Rec™**, **Ever® Recu™**, **Ever® Cloc™**, **Ever® Works™** and **Ever® OpenSaaS™** are all trademarks of [Ever Co. LTD](https://ever.co).

The trademarks may only be used with the written permission of Ever Co. LTD. and may not be used to promote or otherwise market competitive products or services.

All other brand and product names are trademarks, registered trademarks, or service marks of their respective holders.

## 🍺 Contribute

- Please give us a :star: on Github, it **helps**!
- You are more than welcome to submit feature requests in the [separate repo](https://github.com/ever-works/ever-works/issues).
- Pull requests are always welcome! Please base pull requests against the _develop_ branch and follow the [contributing guide](.github/CONTRIBUTING.md).

## 💪 Thanks to our Contributors

This project was initially developed in a private repository before its public release.
We are grateful to the current and former team members who contributed to the project during that phase.

Private-development contributors:

- Paradoxe Ng (492,726++ 246,474--)
- Ruslan Konviser (250,892++ 51,505--)
- Gabriel Nt (111,946++ 36,898--)
- Akilimaili Cizungu Innocent (43,132++ 700--)
- Michał Dziuba (18,944++ 6,930--)
- Roland MN (14,063++ 155--)
- Joel Kalema (12,720++ 6,039--)

Public contributions are tracked in the repository history from the initial public release onward in [CONTRIBUTORS.md](https://github.com/ever-works/ever-works/blob/develop/.github/CONTRIBUTORS.md).
You can also view a full list of our [contributors tracked by GitHub](https://github.com/ever-works/ever-works/graphs/contributors).

<img src="https://contributors-img.web.app/image?repo=ever-works/ever-works" />

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ever-works/ever-works&type=Date)](https://star-history.com/#ever-works/ever-works&Date)

## ❤️ Powered By

<p>
  <a href="https://www.digitalocean.com/?utm_medium=opensource&utm_source=ever-co">
    <img src="https://opensource.nyc3.cdn.digitaloceanspaces.com/attribution/assets/PoweredByDO/DO_Powered_by_Badge_blue.svg" width="201px">
  </a>
</p>

<p>
 <a href="https://vercel.com/?utm_source=ever-co&utm_campaign=oss">
     <img src=".github/vercel-logo.svg" alt="Powered by Vercel" />
 </a>
</p>

## ©️ Copyright

#### Copyright © 2025-present, Ever Co. LTD. All rights reserved

## 🔥 P.S

- If you are interested in an Open Business Management Platform (ERP/CRM/HRM), check out our open-source [Ever Gauzy](https://github.com/ever-co/ever-gauzy) platform.
- Explore the rest of the [Ever Platform](https://ever.co) family of products.
- [We are Hiring: remote developers](https://github.com/ever-co/jobs#available-positions)!
