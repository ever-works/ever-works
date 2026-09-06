---
id: generated-site
title: What a Generated Site Includes
sidebar_label: Generated Site
sidebar_position: 12
description: The three Git repositories every Work gets, the full feature set of the generated directory site, the general web templates, how the site stays current, and what you own.
---

# What a Generated Site Includes

Every Work you create in Ever Works ends as a **deployable website backed by three Git repositories in your own GitHub account or organization**. The site is not written from scratch on each run: the platform clones one of the published [website templates](./website-templates.md), pushes it into a repository you own, points it at the Work's data repository, deploys it, and then keeps the template layer up to date for you.

This page lists what you actually get — repository by repository, and feature by feature — so you know what is there before you open the site for the first time, and where it is safe to make your own changes.

## Three repositories per Work

For a Work with slug `my-work`, the generator chain produces three repositories (see [Website Generation](../ai-agents/website-generation.md) and the [Generator System](../architecture/generator-system.md)):

| Repository        | Stage that writes it | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `my-work-data`    | Data generator       | The content source of truth: one folder per item under `data/` (item metadata plus a Markdown body), categories, tags, collections and references, item-vs-item `comparisons/`, static `pages/`, header/footer `markdown/` blocks, reusable page `blocks/`, and the Work configuration in `.works/works.yml`. The Knowledge Base folder `kb/` also lives here — one folder per class, never rendered publicly — and uploaded originals land beside it in `kb-originals/` when the Work's storage plugin is `github-storage`. |
| `my-work`         | Markdown generator   | The human-readable "awesome list": a curated `README.md` with a table of contents and items grouped by category, plus per-item detail pages.                                                                                                                                                                                                                                                                                                                                                                                 |
| `my-work-website` | Website generator    | The deployable site, cloned from the chosen template with `main`, `stage` and `develop` branches kept in sync with upstream.                                                                                                                                                                                                                                                                                                                                                                                                 |

```mermaid
flowchart LR
    P[Prompt / Idea] --> D["my-work-data<br/>(items, taxonomy, config)"]
    D --> M["my-work<br/>(README + details)"]
    T["Website template<br/>(classic / minimal / web / web-minimal)"] --> W["my-work-website<br/>(deployable site)"]
    D -. cloned into .content at runtime .-> W
    W --> V["Deploy<br/>(Vercel, Kubernetes, managed subdomain)"]
```

The website repository never contains your content. At start-up the deployed site clones the data repository into its `.content` folder (the `DATA_REPOSITORY` and `GH_TOKEN` values are minted by the platform at deploy time) and re-syncs it periodically or on demand. That separation is what lets the platform replace the website code on every template update without touching a single item you generated or wrote.

## Which template your site is built from

| Template id   | Stack                                  | Kind of site                                                               | Default for Work kinds                          |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `classic`     | Next.js 16 (App Router), full-featured | Directory site — the feature set described on this page                    | `directory`, `awesome-repo`, and any other kind |
| `minimal`     | Astro 6, static, plugin-driven         | Directory site with minimum JavaScript                                     | Opt-in per Work                                 |
| `web`         | Next.js, general-purpose               | Marketing site, landing page, content site with a Markdown blog            | `website`, `landing-page`, `blog`               |
| `web-minimal` | Astro 6, static, general-purpose       | Same marketing sections as `web`, built statically with zero JS by default | Opt-in per Work                                 |

The template is resolved in this order: the template pinned on the Work → your saved default template (**Templates** page → **Website** tab → ⋮ menu → **Make default**) → the kind default above → the system default `classic`. The [Website Templates](./website-templates.md) page covers the catalogue, forking and bring-your-own-repo templates.

## The classic directory site (Next.js)

The `classic` template ([`ever-works/directory-web-template`](https://github.com/ever-works/directory-web-template)) is a complete directory product, not a scaffold. It runs as a Turborepo monorepo (`apps/web` is the site, `apps/web-e2e` its Playwright suite, `apps/docs` its own documentation), on Next.js 16, Tailwind CSS, HeroUI, Drizzle ORM (PostgreSQL, MySQL or SQLite) and `next-intl`. Everything below ships in the repository the platform pushes for you.

### Accounts and access

| Feature               | What you get                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in               | Auth.js (NextAuth v5) with email/password credentials, or Supabase Auth with magic links — both can run side by side.                                              |
| OAuth providers       | Google, GitHub, Microsoft, Facebook and X, toggled per provider in `works.yml` (`auth:` block); the site falls back to credentials-only if OAuth keys are missing. |
| Passkeys              | WebAuthn / passkey schema (`authenticators` table) following the Auth.js contract.                                                                                 |
| Sessions              | JWT sessions (30-day max age) with an in-memory cache layer and automatic member-profile provisioning.                                                             |
| Roles and permissions | Role-based access control with `resource:action` permissions, an admin flag and role management screens under `/admin/roles`.                                      |
| Bot protection        | Google reCAPTCHA v2 on login, registration and contact forms, verified server-side.                                                                                |

### Monetization

| Feature      | What you get                                                                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pricing page | `/pricing` with Free / Standard / Premium plans, a monthly-yearly toggle with computed savings, multi-currency formatting, trust indicators and a "popular" plan highlight.                                                                                       |
| Checkout     | Stripe, Lemon Squeezy, Polar and Solidgate behind one provider abstraction; embedded payment modal or redirect checkout; webhooks update subscription status; customer portal for self-service billing; optional live pricing pulled from Stripe products.        |
| Plan limits  | Submission counts, image counts, description length, video upload, verified badge, priority and instant review are gated per plan (`lib/guards/plan-features.guard.ts`).                                                                                          |
| Sponsor ads  | Paid sponsored placements: a member submits an ad at `/sponsor`, pays, an admin approves or rejects it under `/admin/sponsorships`, and the ad runs until it expires, is renewed or cancelled.                                                                    |
| Promo codes  | Percentage, fixed-amount and free-shipping codes shown on item pages with copy-to-clipboard, expiry tracking and click/copy analytics.                                                                                                                            |
| Payment keys | The platform delivers your payment configuration (`NEXT_PUBLIC_PAYMENT_PROVIDER`, Stripe keys, price ids) to the deployed site as AES-256-GCM-encrypted per-Work runtime environment variables on every deploy — they are never stored in the website repository. |

### Submissions, URL extraction, moderation and admin

| Feature                | What you get                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Submit flow            | A multi-step submission form at `/submit` with step indicator, validation and a rich-text (TipTap) editor with image upload.                                                                                                                                             |
| URL extraction         | Paste a URL and the form auto-fills name, description, category, tags, brand and images via `/api/extract`; when the site is connected to the Ever Works Platform API (`PLATFORM_API_URL` + `PLATFORM_API_SECRET_TOKEN`) extraction uses the platform's AI extractors.   |
| Member dashboard       | Signed-in members see their submissions with status tabs (All / Approved / Pending / Rejected), search, stats cards, inline edit, detail view, delete with confirmation and a trash with restore.                                                                        |
| Review queue           | Submissions enter a pending queue; an admin approves or rejects with notes, and the rejection reason is shown to the submitter.                                                                                                                                          |
| Reports and moderation | Visitors can report items and comments; admins act on reports under `/admin/reports`.                                                                                                                                                                                    |
| Audit trail            | Every item creation, update, status change, review, deletion and restoration is logged with who did it and what changed.                                                                                                                                                 |
| Admin dashboard        | `/admin` with stats, activity charts, submission status, top items, notifications, data export and dedicated sections for items, categories, tags, collections, companies, featured items, comments, reports, roles, users, clients, sponsorships, surveys and settings. |
| Bulk import / export   | CSV/Excel export and import of items, switched on per Work from the platform (`export_enabled`, `import_enabled`, `import_max_rows`).                                                                                                                                    |

### Community

| Feature        | What you get                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Votes          | One up/down vote per member per item with optimistic updates and a sign-in prompt for anonymous visitors.                               |
| Reviews        | Comments with optional 1–5 star ratings that roll up into an aggregate item rating; admins can moderate under `/admin/comments`.        |
| Favorites      | Members bookmark items and browse them at `/favorites`.                                                                                 |
| Profiles       | Public member profiles with avatar, bio, social links, skills and submitted items.                                                      |
| Surveys        | Site-wide or item-specific surveys created and published from `/admin/surveys`, answered by signed-in members at `/surveys`.            |
| Newsletter     | Subscription forms in the footer, a popup and at sign-up, stored with their source, sent through Resend or Novu, with admin statistics. |
| Notifications  | In-app notifications plus email notifications for submissions, reports and payment events.                                              |
| Social sharing | Share button, Open Graph images and structured data so shared links render rich previews.                                               |
| View tracking  | Privacy-conscious unique daily views per item that power view counts, trending lists and popularity scores.                             |

### Search, filters, taxonomy and maps

| Feature            | What you get                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search and filters | Debounced full-text search (300 ms), category and tag filters, sort by updated, created, name, views or votes, active-filter chips, pagination and URL-synced state so filtered views are shareable.                                           |
| Layouts            | Cards, Grid and Masonry views with a sticky filter bar; the default layout and pagination are configurable per Work.                                                                                                                           |
| Taxonomy           | Hierarchical categories at `/categories`, tags at `/tags`, curated collections at `/collections`, featured items with ordering and expiry, and company profiles with domain-based deduplication.                                               |
| Comparisons        | Item-vs-item comparison pages at `/comparisons`, generated by the platform's [comparison generator](./comparisons.md) and rendered by the site.                                                                                                |
| Maps               | Mapbox or Google Maps behind one abstraction; items declare a `location:` and are geocoded automatically; a `/map` view pairs markers with a synchronized card sidebar, with clustering, geolocation and a location picker on the submit form. |
| Breadcrumbs        | Visible breadcrumbs on every page plus `BreadcrumbList` JSON-LD.                                                                                                                                                                               |

### Languages

The site ships **21 locales** with URL-based routing (`/fr/...`, default `en` at the root), automatic browser detection, message fallback and a language switcher: `en`, `fr`, `es`, `de`, `zh`, `ar`, `he`, `ru`, `uk`, `pt`, `it`, `ja`, `ko`, `nl`, `pl`, `tr`, `vi`, `th`, `hi`, `id`, `bg`. Arabic and Hebrew render right-to-left. Translation files live in `apps/web/messages/*.json`.

### SEO, feeds and AI discoverability

| Feature         | What you get                                                                                                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured data | Schema.org JSON-LD generators for `Product`, `Organization`, `WebSite`, `BreadcrumbList`, `FAQPage` and `ItemList`.                                                                                                                                                                                                                      |
| Metadata        | Unique title/description per page, canonical URLs, `hreflang` alternates for all locales, Open Graph and Twitter Card tags, and a generated Open Graph image (`app/opengraph-image.tsx`).                                                                                                                                                |
| Sitemap         | `app/sitemap.ts` covers static pages, every item, category and collection, in every active locale, with per-type priority and change frequency.                                                                                                                                                                                          |
| robots.txt      | `app/robots.ts` allows crawlers, points to the sitemap, blocks admin/API routes and emits an explicit per-bot policy for 18 AI crawlers controlled by the `AI_CRAWLERS` env var (`allow` by default, `disallow`, a selective list, or `none`).                                                                                           |
| Feeds           | RSS 2.0 at `/rss.xml`, Atom 1.0 at `/atom.xml` and JSON Feed 1.1 at `/feed.json`, auto-discoverable from every page's `<head>`.                                                                                                                                                                                                          |
| LLM endpoints   | `/llms.txt` (manifest) and `/llms-full.txt` (the whole directory as one Markdown document), plus a clean `.md` twin of every public page (`/items/<slug>.md`, `/categories/<id>.md`, `/pages/<slug>.md`, …) advertised with `<link rel="alternate" type="text/markdown">` and served `noindex` so search engines keep indexing the HTML. |

### Analytics, theming, AI chat, plugins and CRM

| Feature            | What you get                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analytics          | PostHog events and session recording, Sentry error tracking and Vercel Analytics web vitals behind one `Analytics` singleton; admin analytics with growth and engagement metrics.                                                                                                                                            |
| Theming            | Dark/light mode (`next-themes`) plus switchable color themes (Everworks, Corporate, Material, Funny); the default theme and whether visitors may change it are set per Work.                                                                                                                                                 |
| Feature flags      | Database-backed features (votes, comments, favorites, …) switch themselves off automatically when `DATABASE_URL` is not configured, so the site can run in static-content mode.                                                                                                                                              |
| AI chat            | A floating assistant for visitors that browses, searches and navigates the directory and, for signed-in members, answers about their own submissions, favorites and profile. Built on the Vercel AI SDK against any OpenAI-compatible endpoint; it activates as soon as `AI_CHAT_API_KEY` is set and is read-only by design. |
| Plugin SDK         | `@ever-works/plugin-sdk` with `defineDirectoryPlugin`, typed capabilities, UI slots and a loader/registry, so the site can be extended without forking core files.                                                                                                                                                           |
| CRM                | Twenty CRM integration that syncs members and companies, configured from `/admin/settings` or env vars, in `platform` or `direct_crm` mode.                                                                                                                                                                                  |
| Images and uploads | Allow-listed image domains for Next.js image optimization, file upload through the editor and API client.                                                                                                                                                                                                                    |
| Ops                | A `Dockerfile`, GitHub Actions workflows for CI, CodeQL, dev/stage/prod deploys, Vercel and Kubernetes deploys, Docker image publishing and end-to-end tests; version display and content-sync detection in the footer.                                                                                                      |

## Settings you control from the platform

You do not have to edit the website repository to change how the site behaves. The **Website Configuration** card on `/works/:id/settings` (and the **Configure Before Deploy** dialog on `/works/:id/deploy`) writes the site's `works.yml` through `PUT /api/works/:id/website-settings`:

| Tab      | Settings                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General  | Site name and site URL; enable or disable categories, collections, tags, companies, surveys and comparisons; item import/export and the import row cap. |
| Header   | Submit button, pricing link, layout selector, language selector, theme toggle; default layout, pagination and theme (`light`, `dark`, `system`).        |
| Homepage | Hero section, search box, default view and default sort.                                                                                                |
| Footer   | Newsletter subscribe form, version badge, theme selector.                                                                                               |
| Menus    | Up to ten custom header links and ten footer links (relative paths or `http(s)` URLs, optional icon and target).                                        |

The generated site reads the same file, so a change here is live after the next content sync or deploy.

## The minimal directory site (Astro)

The `minimal` template ([`ever-works/directory-web-minimal-template`](https://github.com/ever-works/directory-web-minimal-template)) reads the **same data repository format** (items, categories, tags, collections, comparisons and `.works/works.yml`) but trades the classic feature surface for a deliberately blank, static canvas:

- **Stack** — Astro 6 with static output (optional ISR through `@astrojs/vercel`), Preact islands only where interactivity is needed, Tailwind CSS and strict TypeScript.
- **Plugin architecture** — almost every feature is a plugin you enable: SEO (meta tags, Open Graph, JSON-LD), pagination, client-side category/tag filters, static search (Pagefind), sort, XML sitemap, breadcrumbs, RSS 2.0 + Atom 1.0 feeds, privacy-friendly analytics (Plausible, Umami, Fathom, GA4 or custom) and related items.
- **Headless UI** — unstyled Astro and Preact building blocks (25 Astro + 8 Preact components, 22 primitives) that an agent styles into a finished site; five reference samples (basic, jobs, events, real estate, and a 3,200-item Git-backed directory) show the range.
- **Agent-customizable** — unlike `classic`, the platform can apply UI-only customizations to a fork of this template (`customizable: true`).

**What is intentionally not included:** authentication and member accounts, a database, payments and billing, traditional SSR, maps and CRM integrations. Each can be added as a plugin when you need it, but if you want submissions, votes, pricing pages or an admin dashboard out of the box, choose `classic`.

**Choosing it:** pick **Minimal** in the template selector when creating the Work, or later from the **Automatic Template Updates** card on `/works/:id/deploy`. The template is registered under the id `minimal`; self-hosted operators can point it at their own fork with `WEBSITE_TEMPLATE_MINIMAL_OWNER`, `WEBSITE_TEMPLATE_MINIMAL_REPO` (default `directory-web-minimal-template`), `WEBSITE_TEMPLATE_MINIMAL_BRANCH` and `WEBSITE_TEMPLATE_MINIMAL_BETA_BRANCH`.

## The general web and web-minimal templates

For Works that are not directories, the catalogue registers two general-purpose templates. They are built from separate repositories, so this page only states what the template registry and the [Website Templates](./website-templates.md) catalogue describe:

| Template      | Repository                                                                              | What it is                                                                                                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`         | [`ever-works/web-template`](https://github.com/ever-works/web-template)                 | Next.js (App Router, React 19, Tailwind CSS v4) marketing/landing/content site: a full landing page (hero, features, how-it-works, testimonials, pricing, FAQ, CTA), About / Pricing / Contact pages and a Markdown blog. All copy lives in `apps/web/lib/site.config.ts`; agent-customizable through `apps/web/src/styles/theme.css`. |
| `web-minimal` | [`ever-works/web-minimal-template`](https://github.com/ever-works/web-minimal-template) | Astro 6 static build of the same marketing section set with zero JavaScript by default, on the same nginx-on-`:3000` build contract as the minimal directory template. Copy lives in `apps/web/src/config/site.ts`; agent-customizable through `theme.css`.                                                                            |

Both are the default for `website`, `landing-page` and `blog` Works (`web` by default; `web-minimal` is opt-in). Neither has item lists, faceted filters or the directory data model.

:::note What the platform generates for these kinds today
The platform's content generators write directory data — items, categories, tags, collections, references and comparisons — into the data repository. They do not yet author blog posts or landing-page copy into `site.config.ts` / `site.ts`. For a `website`, `landing-page` or `blog` Work you get the template code, deploys, template updates and the agent workforce; the marketing copy is edited in the repository or delegated to an [Agent](./agents.md) task.
:::

## Keeping the site current

The platform treats the website repository as a managed layer and keeps it aligned with the upstream template:

1. **Hourly check** — `WebsiteTemplateSchedulerService` runs every hour under a distributed lock, for every Work with **Update automatically** switched on (global kill switch: `WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED`, default `true`).
2. **Compare** — it reads the template's latest commit on the tracked branch and compares it with the Work's `websiteTemplateLastCommit`; nothing happens if they match.
3. **Update** — when they differ it re-applies the template: first the _duplicate_ method (clone the template, re-point the remote at your repository, force push — preserves template history), falling back to the _template_ method (clone both, copy files, commit `Update website from template (<branch>)`, force push).
4. **Branch sync** — `main`, `stage` and `develop` are each cloned from the template and pushed to your repository; every push is verified by reading the remote ref back, and a branch that cannot be verified is reported as an error rather than a success.
5. **Record** — `websiteTemplateLastUpdatedAt`, `websiteTemplateLastCheckedAt` and `websiteTemplateLastError` are stored on the Work and shown on the Deploy tab as **Last updated**, **Last checked** and **Last error**.

**Beta channel.** Switch on **Use beta version of template** and the template's beta branch (`stage` by default, `WEBSITE_TEMPLATE_BETA_BRANCH`) is mapped onto your repository's `main`, so you receive template changes before they are promoted to stable.

**Branches.** `main` is the production branch of every template; `stage` and `develop` exist so you can preview upcoming template changes with your own content.

### How to manage template updates

1. Open the Work and go to **Deploy** (`/works/:id/deploy`). Scroll to the **Automatic Template Updates** card.
2. **Work template** shows the current template and whether it is _inherited_ from your default or _pinned_ to this Work. Pick another template and click **Apply template to Work repository** to switch; confirm **Switch template** in the dialog (the website repository is reset from the new template).
3. Toggle **Update automatically** to enrol the Work in the hourly check, and **Use beta version of template** to follow the beta branch. Both toggles write through to the Git provider connected under **Settings → Git Providers** (GitHub); with none connected the switch reverts itself and reports `Git provider connection required`, so connect it first.
4. To pull the latest template right now, use the **Update Work Repository** card and click **Update Repository**.

From the API (JWT or API key), the same operations are:

| Method  | Endpoint                                 | Purpose                                                                                                                                                  |
| ------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/works/website-templates`           | List the templates available to you.                                                                                                                     |
| `PATCH` | `/api/works/:id`                         | Set `websiteTemplateAutoUpdate` and `websiteTemplateUseBeta`.                                                                                            |
| `POST`  | `/api/works/:id/switch-website-template` | Body `{ "websiteTemplateId": "minimal" }`; returns `switchMode` (`saved_for_initialization`, `repository_reset`, `repository_recreated` or `no_change`). |
| `POST`  | `/api/works/:id/update-website`          | Apply the latest template now; returns `method_used` (`duplicate` or `create-using-template`).                                                           |

```bash
curl -X POST http://localhost:3100/api/works/<work-id>/update-website \
  -H "Authorization: Bearer <token>"
```

## Ownership: it is your repository

All three repositories are created in your GitHub account or organization and are yours to clone, fork, transfer or delete — nothing about a Work lives only inside Ever Works. Two rules keep that ownership safe:

**The website repository is force-pushed.** Every template update and branch sync force-pushes `main`, `stage` and `develop` of `<slug>-website` from the template. The dashboard says it plainly when you switch templates: any custom code in that repository will be lost. Treat those three branches as managed output.

**Make your changes where the platform will not overwrite them:**

| You want to change…                                        | Do it here                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Items, categories, tags, collections, comparisons          | The Work's items and generator screens (`/works/:id/items`, `/works/:id/generator`), the in-app chat, or pull requests against `<slug>-data` — the platform only rewrites the files it owns.                                                                                                                                                                                                                      |
| Static pages, header/footer Markdown, page blocks          | `pages/`, `markdown/` and `blocks/` in `<slug>-data`; the site clones them at start-up and reads pages straight out of `.content/pages/`.                                                                                                                                                                                                                                                                         |
| Blog posts on a `web` Work                                 | The Markdown blog that ships inside the `web` template itself (see [Website Templates](./website-templates.md)) — the data repository has no `posts/` folder and the platform does not author posts for you. Because the website repository is force-pushed on every template update, keep posts on a fork of the template (see **The website code itself** below) or with **Update automatically** switched off. |
| Site name, enabled features, header/homepage/footer, menus | **Website Configuration** on `/works/:id/settings`, which writes `.works/works.yml` (see [`.works/works.yml`](./works-config.md)).                                                                                                                                                                                                                                                                                |
| Payment keys and other runtime secrets                     | The Work's runtime environment settings; values are encrypted and delivered on every deploy, never committed.                                                                                                                                                                                                                                                                                                     |
| The website code itself                                    | Fork the template into your own catalogue entry (**Templates** → **Fork**, or a custom repository URL — see [Work Templates](./work-templates.md)), point the Work at it, and keep your changes on that fork so template updates flow from a repository you control. Or switch **Update automatically** off and work on a branch of your own.                                                                     |
| Domain and hosting                                         | [Custom Domains](./custom-domains.md), the Vercel and Kubernetes deploy plugins, or the managed `ever-works` subdomain — see [Kubernetes Deployment](./k8s-deployment.md).                                                                                                                                                                                                                                        |

## Tests and types: what ships and what is generated

The templates arrive with their own type-checked TypeScript and their own test suites — the classic template carries a Playwright end-to-end suite in `apps/web-e2e` and CI/CodeQL workflows; the minimal template ships 1,122 unit tests, 48 component tests and 367 end-to-end tests. Those suites are part of the code the platform clones into your repository.

The runtime does **not** generate tests for each Work. What is generated per Work is the content (data repository), the README (markdown repository) and the configuration the site reads; code changes made by Agents go through the platform's [quality gates](./quality-gates.md) and pull requests rather than through per-Work test generation.

## How to run the generated site locally

1. Clone the website repository the platform created for you and install dependencies:

    ```bash
    git clone https://github.com/<your-org>/<slug>-website
    cd <slug>-website
    pnpm install
    ```

2. Copy the environment template and point it at your data repository:

    ```bash
    cp apps/web/.env.example apps/web/.env.local
    ```

    Set `DATA_REPOSITORY` to `https://github.com/<your-org>/<slug>-data`, a `GH_TOKEN` that can read it, and `COOKIE_SECRET` / `AUTH_SECRET` (`openssl rand -base64 32`). `DATABASE_URL` is optional — without it the site runs in static-content mode with database features switched off.

3. Start the site:

    ```bash
    pnpm run dev:web
    ```

    The directory is served at `http://localhost:3000`; `.content/` is cloned from your data repository on first start.

## Related

- [Website Templates](./website-templates.md) — the template catalogue, forking and custom repositories
- [Work Templates](./work-templates.md) — starter Works and bring-your-own template repositories
- [Custom Domains](./custom-domains.md) — put the generated site on your own domain
- [Scheduled Updates](./scheduled-updates.md) — keep the content fresh on a cadence
- [`.works/works.yml` Configuration](./works-config.md) — the Work configuration the site reads
- [Comparisons](./comparisons.md) — item-vs-item pages the site renders
- [Community PR Processing](./community-pr-processing.md) — accept contributions to the data repository
- [Website Generation](../ai-agents/website-generation.md) — the clone, update and branch-sync pipeline
- [Generator System](../architecture/generator-system.md) — data → markdown → website stages
